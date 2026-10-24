import { describe, expect, it } from "vitest";
import path from "node:path";
import { continueAdapter } from "../src/adapters/continue.js";
import { collect, expectSnapshot, FIXTURES_ROOT } from "./helpers.js";

const ROOT = path.join(FIXTURES_ROOT, "continue", "sessions");
const N = (n: number) => path.join(ROOT, `nnnnnnnn-0000-4000-8000-00000000000${n}.json`);
const PROJ = "c:\\Users\\USER\\projects\\demo-app";

describe("continue adapter", () => {
  it("discovers session files but not the index", async () => {
    expect(await continueAdapter.discover(ROOT)).toEqual([N(1), N(2), N(3)]);
  });

  it("maps history items, tool calls and tool results", async () => {
    const { events, warnings } = await collect(continueAdapter, N(1));
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "thinking", // role "thinking"
      "thinking", "assistant_message", "file_read", // reasoning, text, tool
      "file_edit", "file_write", "shell_command", "file_edit", "web_fetch", "tool_call",
      "unknown", // unknown role
      "unknown", // item without a message
      "assistant_message",
    ]);
    expect(warnings.map((w) => w.message)).toEqual(['history 7: unknown role "critic"', "history 8: no message"]);
    expect(events[0]!.payload.text).toBe("Validate the signup email.\n[imageUrl]");
  });

  it("reads tool arguments and keeps the tool's own output over the later tool message", async () => {
    const { events } = await collect(continueAdapter, N(1));
    expect(events[4]!.payload).toMatchObject({ path: "src/signup.tsx", status: "done" });
    expect(events[4]!.payload).not.toHaveProperty("output_excerpt"); // file contents are not copied into reads
    expect(events[5]!.payload).toMatchObject({ path: "src/signup.tsx", old_excerpt: "valid = true", new_excerpt: "valid = isEmail(v)" });
    expect(events[6]!.payload).toMatchObject({ path: `${PROJ}\\src\\email.ts`, bytes: 35 });
    expect(events[7]!.payload).toMatchObject({ command: "npm test", stdout_excerpt: "3 passing" });
    expect(events[8]!.payload).toMatchObject({ chunks: 2, lines_added: 3, lines_removed: 2 });
    expect(events[9]!.payload.url).toBe("https://example.com/rfc5322");
    expect(events[10]!.payload).toMatchObject({ tool_name: "grep_search", is_error: true });
  });

  it("builds the session with usage from the index time and workspace", async () => {
    const { events, sessions } = await collect(continueAdapter, N(1));
    expect(events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, e.tokens_in, e.tokens_out, e.cache_read])).toEqual([
      [2, 1000, 100, 500],
      [5, 2000, 120, 0],
    ]);
    expect(sessions[0]).toMatchObject({
      id: "continue:nnnnnnnn-0000-4000-8000-000000000001",
      source: "continue",
      project_path: PROJ,
      model: "claude-sonnet-5-5",
      title: "Signup validation",
      started_at: "2026-01-15T10:00:00.000Z",
      total_input_tokens: 3000,
      total_output_tokens: 220,
    });
  });

  it("matches the expected normalized snapshot", async () => {
    await expectSnapshot(continueAdapter, N(1), path.join(FIXTURES_ROOT, "continue", "expected", "session-1.json"));
  });

  it("skips empty sessions and warns on files that are not sessions", async () => {
    const empty = await collect(continueAdapter, N(2));
    expect([empty.events.length, empty.sessions.length, empty.warnings.length]).toEqual([0, 0, 0]);
    expect((await collect(continueAdapter, N(3))).warnings).toHaveLength(1);
  });
});
