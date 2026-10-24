import { describe, expect, it } from "vitest";
import path from "node:path";
import { copilotAdapter, replayChatLog } from "../src/adapters/copilot.js";
import { collect, expectSnapshot, FIXTURES_ROOT } from "./helpers.js";

const FIX = path.join(FIXTURES_ROOT, "copilot");
const USER = path.join(FIX, "User");
const P = (n: number) => `pppppppp-0000-4000-8000-00000000000${n}`;
const WS_FILE = path.join(USER, "workspaceStorage", "wwwwwwww0000", "chatSessions", `${P(1)}.jsonl`);
const EMPTY = path.join(USER, "globalStorage", "emptyWindowChatSessions");
const PROJ = "C:\\Users\\USER\\projects\\demo-app";

describe("vscode chat log replay", () => {
  it("applies set, push with truncate, and delete entries", () => {
    const log = [
      { kind: 0, v: { a: [1, 2, 3], b: { c: 1 } } },
      { kind: 1, k: ["b", "c"], v: 2 },
      { kind: 2, k: ["a"], i: 1, v: [9] },
      { kind: 2, k: ["a"], v: [10] },
      { kind: 3, k: ["b"] },
      { kind: 1, k: ["d"], v: "x" },
    ].map((e) => JSON.stringify(e)).join("\n");
    expect(replayChatLog(log, () => {})).toEqual({ a: [1, 9, 10], d: "x" });
  });

  it("reports lines it cannot apply and keeps going", () => {
    const bad: number[] = [];
    const log = ['{"kind":0,"v":{"a":1}}', "{oops", '{"kind":1,"k":["x","y"],"v":1}', '{"kind":5}', '{"kind":1,"k":["a"],"v":2}'].join("\n");
    expect(replayChatLog(log, (line) => bad.push(line))).toEqual({ a: 2 });
    expect(bad).toEqual([2, 3, 4]);
  });

  it("cannot pollute Object.prototype or grow huge sparse arrays", () => {
    const bad: number[] = [];
    const log = [
      { kind: 0, v: { a: [1, 2] } },
      { kind: 1, k: ["__proto__", "polluted"], v: true },
      { kind: 1, k: ["a", "constructor", "prototype", "polluted"], v: true },
      { kind: 2, k: ["__proto__", "x"], v: [1] },
      { kind: 3, k: ["constructor", "prototype", "toString"] },
      { kind: 2, k: ["a"], i: 1e9, v: [3] },
    ].map((e) => JSON.stringify(e)).join("\n");
    const state = replayChatLog(log, (line) => bad.push(line)) as { a: unknown[] };
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(typeof Object.prototype.toString).toBe("function");
    expect(bad).toEqual([2, 3, 4, 5]);
    expect(state.a).toEqual([1, 2, 3]);
  });
});

describe("copilot adapter", () => {
  it("discovers workspace and empty-window sessions, preferring .jsonl over a migrated .json", async () => {
    expect(await copilotAdapter.discover(USER)).toEqual([
      WS_FILE,
      path.join(EMPTY, `${P(2)}.json`),
      path.join(EMPTY, `${P(3)}.jsonl`),
      path.join(EMPTY, `${P(4)}.jsonl`),
    ]);
  });

  it("maps a replayed agent session in order", async () => {
    const { events, warnings } = await collect(copilotAdapter, WS_FILE);
    expect(warnings).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "thinking",
      "assistant_message", // "I'll read login.ts first." joined around the inline reference
      "file_read", "shell_command", "tool_call", "file_edit", "file_write", "web_fetch", "tool_call",
      "assistant_message",
      "user_message", "error", // rate limit
      "user_message", "assistant_message", "error", // cancelled
    ]);
    expect(events[2]!.payload.text).toBe(`I'll read ${PROJ}\\src\\login.ts first.`);
  });

  it("reads terminal state, edited files and tool inputs", async () => {
    const { events } = await collect(copilotAdapter, WS_FILE);
    expect(events[3]!.payload).toMatchObject({ path: `${PROJ}\\src\\login.ts`, tool_name: "copilot_readFile" });
    expect(events[4]!.payload).toMatchObject({ command: "npm test", exit_code: 1, is_error: true, duration_ms: 1500, stdout_excerpt: "1 failing" });
    expect(events[6]!.payload).toMatchObject({ path: `${PROJ}\\src\\login.ts`, new_excerpt: "const timeout = config.timeout;", edit_count: 1 });
    expect(events[7]!.payload).toMatchObject({ path: `${PROJ}\\src\\config.ts`, bytes: 27 });
    expect(events[8]!.payload.url).toBe("https://example.com/docs");
    expect(events[9]!.payload).toMatchObject({ tool_name: "mcp_github_list_issues", input: { repo: "demo" } });
  });

  it("builds the session from the replayed state", async () => {
    const { sessions } = await collect(copilotAdapter, WS_FILE);
    expect(sessions[0]).toMatchObject({
      id: `copilot:${P(1)}`,
      source: "copilot",
      project_path: "c:\\Users\\USER\\projects\\demo-app",
      model: "gpt-4.1",
      title: "Configurable login timeout",
      started_at: "2026-01-15T09:59:59.000Z",
      ended_at: "2026-01-15T10:01:10.000Z",
      total_input_tokens: 0,
    });
  });

  it("reads old single-object sessions and skips unused chat panels", async () => {
    const old = await collect(copilotAdapter, path.join(EMPTY, `${P(2)}.json`));
    expect(old.events.map((e) => e.kind)).toEqual(["user_message", "assistant_message"]);
    expect(old.sessions[0]).toMatchObject({ project_path: null, title: "What does the build script do?" });
    const unused = await collect(copilotAdapter, path.join(EMPTY, `${P(4)}.jsonl`));
    expect([unused.events.length, unused.sessions.length, unused.warnings.length]).toEqual([0, 0, 0]);
  });

  it("matches the expected normalized snapshot", async () => {
    await expectSnapshot(copilotAdapter, WS_FILE, path.join(FIX, "expected", `${P(1)}.json`));
  });

  it("survives malformed log lines", async () => {
    const { events, warnings, sessions } = await collect(copilotAdapter, path.join(FIX, "malformed", `${P(9)}.jsonl`));
    expect(warnings.map((w) => w.line)).toEqual([2, 3, 4, null]);
    expect(events.map((e) => e.kind)).toEqual(["user_message", "assistant_message", "unknown"]);
    expect(sessions).toHaveLength(1);
  });
});
