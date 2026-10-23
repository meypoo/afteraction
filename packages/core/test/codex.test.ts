import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexAdapter, parseApplyPatch } from "../src/adapters/codex.js";
import type { NormalizedEvent, ParseWarning, Session } from "../src/model.js";
import { applyRisks } from "../src/risk.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/codex");
const CLI_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DESKTOP_ID = "0198a1b2-d4e5-7f60-9a1b-2c3d4e5f6a7b";
const CLI = path.join(FIXTURES, "sessions/2026/01/15", `rollout-2026-01-15T10-00-00-${CLI_ID}.jsonl`);
const DESKTOP = path.join(FIXTURES, "sessions/2026/01/16", `rollout-2026-01-16T09-00-00-${DESKTOP_ID}.jsonl`);
const IMPORTED = path.join(FIXTURES, "archived_sessions", "rollout-2026-01-14T08-00-00-0198a1b2-e5f6-7a71-8b2c-3d4e5f6a7b8c.jsonl");
const LEGACY = path.join(FIXTURES, "legacy", "rollout-2025-05-01T12-00-00-0196a000-0000-7000-8000-000000000001.jsonl");
const MALFORMED = path.join(FIXTURES, "malformed", "rollout-2026-01-17T07-00-00-0198a1b2-f6a7-7b82-9c3d-4e5f6a7b8c9d.jsonl");

async function collect(file: string) {
  const events: NormalizedEvent[] = [];
  const warnings: ParseWarning[] = [];
  const sessions: Session[] = [];
  for await (const rec of codexAdapter.parse(file)) {
    if (rec.type === "event") events.push(rec.event);
    else if (rec.type === "warning") warnings.push(rec.warning);
    else sessions.push(rec.session);
  }
  return { events, warnings, sessions };
}

const tokens = (e: NormalizedEvent) => [e.tokens_in, e.cache_read, e.tokens_out];

describe("codex adapter: discover", () => {
  it("finds rollouts under sessions/ and archived_sessions/ of a Codex home", async () => {
    const files = await codexAdapter.discover(FIXTURES);
    expect(files.map((f) => path.relative(FIXTURES, f).replace(/\\/g, "/"))).toEqual([
      "archived_sessions/rollout-2026-01-14T08-00-00-0198a1b2-e5f6-7a71-8b2c-3d4e5f6a7b8c.jsonl",
      `sessions/2026/01/15/rollout-2026-01-15T10-00-00-${CLI_ID}.jsonl`,
      `sessions/2026/01/16/rollout-2026-01-16T09-00-00-${DESKTOP_ID}.jsonl`,
    ]);
  });

  it("searches any other folder as is", async () => {
    const files = await codexAdapter.discover(path.join(FIXTURES, "legacy"));
    expect(files).toEqual([LEGACY]);
  });

  it("returns nothing for a missing root", async () => {
    expect(await codexAdapter.discover(path.join(FIXTURES, "does-not-exist"))).toEqual([]);
  });
});

describe("codex adapter: Codex CLI rollout", () => {
  it("normalizes shell calls, patches, reasoning and the aborted turn", async () => {
    const { events, warnings } = await collect(CLI);
    expect(warnings).toEqual([]);
    expect(events.map((e) => `${e.kind}: ${e.summary}`)).toEqual([
      "user_message: <environment_context> <cwd>/home/user/projects/demo-app</cwd> <approval_policy>on-request</approval_policy> </environme…",
      "user_message: Add a /health endpoint and run the tests.",
      "thinking: Planning the endpoint",
      "shell_command: $ cat src/server.ts",
      "file_write: Write src/health.ts",
      "file_edit: Edit src/server.ts",
      "file_write: Delete src/old.ts",
      "shell_command: $ npm test",
      "tool_call: update_plan",
      "tool_call: Web search: express json response",
      "assistant_message: Added the endpoint. One test fails; looking into it.",
      "error: Turn aborted (interrupted)",
    ]);
    expect(events[0]!.payload.meta).toBe(true);
    expect(events[1]!.payload.meta).toBeUndefined();
    expect(events[2]!.payload).toMatchObject({ summary_only: true, redacted: false });
  });

  it("reads exit codes, output and durations for shell calls", async () => {
    const { events } = await collect(CLI);
    expect(events[3]!.payload).toMatchObject({
      command: "cat src/server.ts", shell: "bash", cwd: "/home/user/projects/demo-app",
      exit_code: 0, is_error: false, duration_ms: 42, stdout_excerpt: 'import express from "express";\n',
    });
    expect(events[7]!.payload).toMatchObject({ command: "npm test", exit_code: 1, is_error: true, duration_ms: 3500, stdout_excerpt: "1 failing\n" });
  });

  it("splits apply_patch into one event per file with line counts", async () => {
    const { events } = await collect(CLI);
    expect(events[4]!.payload).toMatchObject({ path: "src/health.ts", operation: "create", lines_added: 2, lines_removed: 0, is_error: false });
    expect(events[5]!.payload).toMatchObject({ path: "src/server.ts", lines_added: 2, lines_removed: 1 });
    expect(String(events[5]!.payload.unified_diff)).toContain('+app.get("/health"');
    expect(events[6]!.payload).toMatchObject({ path: "src/old.ts", operation: "delete" });
  });

  it("counts each response's tokens once, with cached input split out", async () => {
    const { events, sessions } = await collect(CLI);
    const withTokens = events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, ...tokens(e)]);
    expect(withTokens).toEqual([
      [2, 4000, 8000, 150],
      [4, 500, 12000, 90],
      [5, 400, 12400, 120],
      [7, 200, 12800, 60],
      [8, 200, 13000, 30],
    ]);
    expect(sessions[0]).toMatchObject({ total_input_tokens: 5300, total_cache_read_tokens: 58200, total_output_tokens: 450, total_cache_write_tokens: 0 });
  });

  it("builds the session from session_meta and turn_context", async () => {
    const { sessions, events } = await collect(CLI);
    expect(sessions).toHaveLength(1);
    const { source_hash, ...s } = sessions[0]!;
    expect(source_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(s).toEqual({
      id: `codex:${CLI_ID}`,
      source: "codex",
      project_path: "/home/user/projects/demo-app",
      git_branch: "feature/health",
      started_at: events[0]!.ts,
      ended_at: events.at(-1)!.ts,
      model: "gpt-5-codex",
      title: "Add a /health endpoint and run the tests.",
      total_input_tokens: 5300,
      total_output_tokens: 450,
      total_cache_read_tokens: 58200,
      total_cache_write_tokens: 0,
      est_cost_usd: null,
      max_risk: "none",
      source_file: CLI,
    });
    expect(events.every((e) => e.session_id === `codex:${CLI_ID}` && e.id === `codex:${CLI_ID}:${e.seq}`)).toBe(true);
  });

  it("keeps the raw call and output, without encrypted reasoning", async () => {
    const { events } = await collect(CLI);
    expect(Object.keys(events[3]!.raw as object)).toEqual(["call", "output"]);
    expect(JSON.stringify(events[2]!.raw)).not.toContain("xxxxxxxx");
  });
});

describe("codex adapter: Codex Desktop rollout", () => {
  it("replaces exec scripts with the commands and file changes they ran", async () => {
    const { events, warnings } = await collect(DESKTOP);
    expect(warnings).toEqual([]);
    expect(events.map((e) => `${e.kind}: ${e.summary}`)).toEqual([
      "user_message: # AGENTS.md instructions <INSTRUCTIONS>Be careful.</INSTRUCTIONS> <environment_context> <cwd>C:\\Users\\USER\\projects\\dem…",
      "user_message: Add a SECURITY.md and check git status.",
      "assistant_message: I'll add the file, then check the tree.",
      "thinking: (reasoning; text not recorded)",
      "file_write: Write C:\\Users\\USER\\projects\\demo-app\\SECURITY.md",
      "shell_command: $ git status --short; Remove-Item -Recurse -Force docs",
      "tool_call: exec: text(ALL_TOOLS.map(x => x.name).join('\\n'));",
      "assistant_message: Added SECURITY.md.",
    ]);
    expect(events[0]!.payload.meta).toBe(true);
    expect(events[3]!.payload.redacted).toBe(true);
    expect(events[4]!.payload).toMatchObject({ operation: "create", lines_added: 3, via: "exec" });
    expect(events[5]!.payload).toMatchObject({
      shell: "powershell", cwd: "C:/Users/USER/projects/demo-app", exit_code: 0, is_error: false,
      duration_ms: 500, stdout_excerpt: "?? SECURITY.md\n", via: "exec",
    });
    expect(events[6]!.payload.result_excerpt).toBe("exec_command\napply_patch\n");
  });

  it("uses token_usage_record and gives an exec script's usage to its first command", async () => {
    const { events, sessions } = await collect(DESKTOP);
    expect(events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, ...tokens(e)])).toEqual([
      [2, 10000, 20000, 200],
      [5, 1000, 30000, 80],
      [6, 500, 31000, 40],
      [7, 500, 31500, 20],
    ]);
    expect(sessions[0]).toMatchObject({
      id: `codex:${DESKTOP_ID}`, project_path: "C:\\Users\\USER\\projects\\demo-app", git_branch: "main",
      model: "gpt-5.6-terra", title: "Add a SECURITY.md and check git status.",
      total_input_tokens: 12000, total_cache_read_tokens: 112500, total_output_tokens: 340,
    });
  });

  it("feeds the risk rules: a recursive delete inside a PowerShell command is flagged", async () => {
    const { events, sessions } = await collect(DESKTOP);
    applyRisks(events, sessions[0]!);
    expect(events[5]!.risk_rules).toContain("destructive-rm");
  });
});

describe("codex adapter: imports and old formats", () => {
  it("skips a rollout that only holds another agent's imported session", async () => {
    const { events, sessions, warnings } = await collect(IMPORTED);
    expect([events.length, sessions.length, warnings.length]).toEqual([0, 0, 0]);
  });

  it("reads rollouts written before the line envelope existed", async () => {
    const { events, sessions, warnings } = await collect(LEGACY);
    expect(warnings).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["user_message", "shell_command", "assistant_message"]);
    expect(events[1]!.payload).toMatchObject({ command: "ls -la", cwd: "/home/user/projects/demo-app", exit_code: 0, duration_ms: 10 });
    expect(sessions[0]).toMatchObject({ id: "codex:0196a000-0000-7000-8000-000000000001", git_branch: "main", title: "List the files." });
  });
});

describe("codex adapter: malformed input", () => {
  it("never throws, keeps what it can and warns with line numbers", async () => {
    const { events, warnings, sessions } = await collect(MALFORMED);
    expect(warnings.map((w) => [w.line, w.message])).toEqual([
      [3, "invalid JSON"],
      [5, "line is not a JSON object"],
      [6, "invalid JSON"],
      [7, 'unknown line type "mystery_line"'],
      [8, 'unknown response item "brand_new_item"'],
      [9, 'unknown event_msg type "brand_new_event"'],
      [11, 'invalid timestamp "yesterday"; using previous'],
      [13, "invalid JSON"],
    ]);
    expect(events.map((e) => e.kind)).toEqual(["user_message", "unknown", "unknown", "tool_result", "user_message"]);
    expect(events[3]!.ts).toBe("2026-01-17T07:00:06.000Z"); // last valid timestamp, from line 10
    expect(sessions[0]!.title).toBe("First prompt.");
  });
});

describe("parseApplyPatch", () => {
  it("handles moves and CRLF patches", () => {
    const patch = "*** Begin Patch\r\n*** Update File: a.ts\r\n*** Move to: b.ts\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n";
    expect(parseApplyPatch(patch)).toEqual([{ op: "update", path: "a.ts", movePath: "b.ts", diff: "@@\n-x\n+y\n" }]);
  });

  it("returns nothing for text that is not a patch", () => {
    expect(parseApplyPatch("hello")).toEqual([]);
  });
});
