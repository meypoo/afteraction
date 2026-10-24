import { describe, expect, it } from "vitest";
import path from "node:path";
import { geminiCliAdapter } from "../src/adapters/gemini-cli.js";
import { collect, expectSnapshot, FIXTURES_ROOT } from "./helpers.js";

const ROOT = path.join(FIXTURES_ROOT, "gemini-cli", "tmp");
const HASH = "70821e01b8546d7ce54769ed809bc1c65c126278667bd81d28819705fed117a6";
const FILE = path.join(ROOT, HASH, "chats", "session-2026-01-15T10-00-gggggggg.json");
const BROKEN = path.join(ROOT, "0".repeat(64), "chats", "session-2026-01-16T09-00-broken00.json");
const PROJ = "/home/user/projects/demo-app";

describe("gemini cli adapter", () => {
  it("discovers session files per project hash", async () => {
    expect(await geminiCliAdapter.discover(ROOT)).toEqual([BROKEN, FILE]);
    expect(await geminiCliAdapter.discover(path.join(ROOT, "missing"))).toEqual([]);
  });

  it("maps messages, thoughts and tool calls in order", async () => {
    const { events, warnings } = await collect(geminiCliAdapter, FILE);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "thinking", "assistant_message", "file_read", "shell_command",
      "file_edit", "file_write", "shell_command", "web_fetch", "tool_call",
      "user_message", // info, marked meta
      "error",
      "unknown", // unknown message type
      "unknown", // not an object
      "assistant_message",
    ]);
    expect(warnings.map((w) => w.message)).toEqual([
      'message 12: unknown message type "compression"',
      "message 13: message is not an object",
    ]);
  });

  it("parses shell results, edits and fetches", async () => {
    const { events } = await collect(geminiCliAdapter, FILE);
    const [test, lint] = events.filter((e) => e.kind === "shell_command");
    expect(test!.payload).toMatchObject({ command: "npm test", exit_code: 0, is_error: false, stdout_excerpt: "3 passing" });
    expect(lint!.payload).toMatchObject({ command: "npm run lint", cwd: "src", exit_code: 1, is_error: true, stdout_excerpt: "", stderr_excerpt: "lint failed" });
    expect(events.find((e) => e.kind === "file_edit")!.payload).toMatchObject({ path: `${PROJ}/src/login.ts`, old_excerpt: "timeout = 10", new_excerpt: "timeout = 30" });
    expect(events.find((e) => e.kind === "web_fetch")!.payload.url).toBe("https://example.com/docs/timeouts");
    expect(events.find((e) => e.kind === "tool_call")!.payload).toMatchObject({ tool_name: "glob", is_error: true });
    expect(events[10]!.payload).toMatchObject({ meta: true, level: "info" });
  });

  it("puts usage on each reply's first event and recovers the project from its hash", async () => {
    const { events, sessions } = await collect(geminiCliAdapter, FILE);
    expect(events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, e.tokens_in, e.tokens_out, e.cache_read])).toEqual([
      [1, 1000, 120, 200],
      [5, 1000, 150, 1000],
    ]);
    expect(sessions[0]).toMatchObject({
      id: "gemini:gggggggg-0000-4000-8000-000000000001",
      source: "gemini_cli",
      project_path: PROJ,
      model: "gemini-2.5-pro",
      title: "Fix the failing login test.",
      started_at: "2026-01-15T10:00:00.000Z",
      ended_at: "2026-01-15T10:05:00.000Z",
      total_input_tokens: 2000,
      total_output_tokens: 270,
      total_cache_read_tokens: 1200,
    });
  });

  it("matches the expected normalized snapshot", async () => {
    await expectSnapshot(geminiCliAdapter, FILE, path.join(FIXTURES_ROOT, "gemini-cli", "expected", "session.json"));
  });

  it("warns instead of throwing on a broken file", async () => {
    const { events, sessions, warnings } = await collect(geminiCliAdapter, BROKEN);
    expect([events.length, sessions.length, warnings.length]).toEqual([0, 0, 1]);
  });
});
