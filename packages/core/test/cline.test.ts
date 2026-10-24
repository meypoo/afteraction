import { describe, expect, it } from "vitest";
import path from "node:path";
import { clineAdapter } from "../src/adapters/cline.js";
import { collect, expectSnapshot, FIXTURES_ROOT } from "./helpers.js";

const ROOT = path.join(FIXTURES_ROOT, "cline");
const TASK = path.join(ROOT, "tasks", "1768471200000", "ui_messages.json");
const NOT_ARRAY = path.join(ROOT, "tasks", "1768474800000", "ui_messages.json");
const PROJ = "C:\\Users\\USER\\projects\\demo-app";

describe("cline adapter", () => {
  it("discovers task folders that have ui_messages.json", async () => {
    expect(await clineAdapter.discover(ROOT)).toEqual([TASK, NOT_ARRAY]);
  });

  it("maps chat messages, skipping partial and bookkeeping ones", async () => {
    const { events, warnings } = await collect(clineAdapter, TASK);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "thinking", "assistant_message", "file_read",
      "file_edit", "file_write", "shell_command",
      "user_message",
      "tool_call", // MCP
      "web_fetch",
      "error",
      "unknown", // unknown say
      "unknown", // not an object
      "assistant_message", // completion result
      "assistant_message", // usage of the last request, with no content after it
    ]);
    expect(warnings.map((w) => w.message)).toEqual(['message 18: unknown say value "mystery_say"', "message 19: not an object"]);
  });

  it("reads tools, commands and their output", async () => {
    const { events } = await collect(clineAdapter, TASK);
    expect(events[3]!.payload).toMatchObject({ path: "src/signup.tsx", tool_name: "readFile" });
    expect(events[4]!.payload).toMatchObject({ path: "src/signup.tsx", old_excerpt: "const valid = true;", new_excerpt: "const valid = validate(form);", lines_added: 1, lines_removed: 1 });
    expect(events[5]!.payload).toMatchObject({ path: "src/validate.ts", lines_added: 1 });
    expect(events[6]!.payload).toMatchObject({ command: "npm test", stdout_excerpt: "2 passing\n1 failing" });
    expect(events[8]!.payload).toMatchObject({ tool_name: "github/create_issue", input: { title: "Validation" }, output_excerpt: '{"number": 7}' });
    expect(events[9]!.payload.url).toBe("https://example.com/email-rules");
  });

  it("attaches each request's usage to the next event and finds the working directory", async () => {
    const { events, sessions } = await collect(clineAdapter, TASK);
    expect(events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, e.tokens_in, e.tokens_out, e.cache_read, e.cache_write])).toEqual([
      [1, 3000, 200, 0, 500],
      [4, 4000, 300, 2500, 0],
      [14, 100, 10, 0, 0],
    ]);
    expect(sessions[0]).toMatchObject({
      id: "cline:1768471200000",
      source: "cline",
      project_path: PROJ,
      model: "claude-sonnet-5-5",
      title: "Add input validation to the signup form.",
      started_at: "2026-01-15T10:00:00.000Z",
      total_input_tokens: 7100,
      total_output_tokens: 510,
      total_cache_read_tokens: 2500,
      total_cache_write_tokens: 500,
    });
  });

  it("matches the expected normalized snapshot", async () => {
    await expectSnapshot(clineAdapter, TASK, path.join(ROOT, "expected", "1768471200000.json"));
  });

  it("warns when ui_messages.json is not an array", async () => {
    const { events, sessions, warnings } = await collect(clineAdapter, NOT_ARRAY);
    expect([events.length, sessions.length, warnings.length]).toEqual([0, 0, 1]);
  });
});
