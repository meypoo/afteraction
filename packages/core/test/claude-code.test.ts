import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import type { NormalizedEvent, ParseWarning, Session } from "../src/model.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/claude-code");
const PROJECTS = path.join(FIXTURES, "projects");
const DEMO_SID = "11111111-2222-4333-8444-555555555555";
const DEMO = path.join(PROJECTS, "C--Users-USER-projects-demo-app", `${DEMO_SID}.jsonl`);
const MALFORMED = path.join(FIXTURES, "malformed", "22222222-3333-4444-8555-666666666666.jsonl");

async function collect(file: string) {
  const events: NormalizedEvent[] = [];
  const warnings: ParseWarning[] = [];
  const sessions: Session[] = [];
  for await (const rec of claudeCodeAdapter.parse(file)) {
    if (rec.type === "event") events.push(rec.event);
    else if (rec.type === "warning") warnings.push(rec.warning);
    else sessions.push(rec.session);
  }
  return { events, warnings, sessions };
}

describe("claude code adapter: discover", () => {
  it("finds main session files and skips subagent transcripts", async () => {
    const files = await claudeCodeAdapter.discover(PROJECTS);
    expect(files.map((f) => path.basename(f))).toEqual([`${DEMO_SID}.jsonl`]);
  });

  it("returns nothing for a missing root", async () => {
    expect(await claudeCodeAdapter.discover(path.join(FIXTURES, "does-not-exist"))).toEqual([]);
  });
});

describe("claude code adapter: demo session", () => {
  it("emits events in file order with the subagent nested after its Agent call", async () => {
    const { events } = await collect(DEMO);
    const kinds = events.map((e) => e.kind + (e.payload.subagent_id ? "*" : ""));
    expect(kinds).toEqual([
      "user_message", // line 2
      "thinking", "shell_command", // 9, 10 (+ result 11)
      "thinking", "file_write", // 12, 13
      "assistant_message", // 15
      "user_message", // 17
      "assistant_message", "shell_command", // 19, 20
      "shell_command", // 22
      "file_write", // 25
      "assistant_message", // 27
      "file_read", // 28
      "file_edit", "file_edit", // 30, 32
      "user_message", // 34
      "file_read", // 35
      "tool_call", // 37 AskUserQuestion
      "tool_call", // 39 MCP, error result
      "subagent_start", // 42 Agent
      "user_message*", "assistant_message*", "shell_command*", "file_read*", "assistant_message*",
      "subagent_end*",
      "error", // 46 <synthetic> API error message
      "shell_command", // 58 PowerShell
      "tool_call", // 60 ToolSearch
      "web_fetch", // 62
      "user_message", // 64
      "tool_call", // 65 Grep
      "error", // 67 system/api_error
      "tool_call", // 68 WebSearch
      "user_message", // 70 text block
      "tool_call", // 71 SendUserFile
      "tool_call", // 76 Monitor
      "tool_call", // 78 ReadNotifications
      "user_message", // 80 isMeta
      "user_message", // 81
      "tool_call", // 89 TaskStop
      "user_message", // 91 image
      "tool_call", // 94 ExitPlanMode
      "user_message", // 99
      "tool_call", // 100 Artifact
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("builds the session record with deduplicated token totals", async () => {
    const { sessions, warnings } = await collect(DEMO);
    expect(warnings).toEqual([]);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s).toMatchObject({
      id: `claude:${DEMO_SID}`,
      source: "claude_code",
      project_path: "C:\\Users\\USER\\projects\\demo-app",
      git_branch: "main",
      started_at: "2026-01-15T10:00:00.014Z",
      // Latest timestamp on any transcript line, attachments included (line 45).
      ended_at: "2026-01-16T09:54:42.287Z",
      model: "claude-opus-5",
      title: "<content placeholder, 1416 chars>",
      // Each API message counted once (last line wins), main file + subagent.
      total_input_tokens: 54,
      total_output_tokens: 37242,
      total_cache_read_tokens: 4683574,
      total_cache_write_tokens: 115622,
      est_cost_usd: null,
      max_risk: "none",
      source_file: DEMO,
    });
    expect(s.source_hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("attaches each message's usage once, using the last line's numbers", async () => {
    const { events } = await collect(DEMO);
    const sub = events.filter((e) => e.payload.subagent_id);
    // Subagent message split over text + Bash + Read lines: usage only on the first, output from the last line.
    expect(sub[1]).toMatchObject({ kind: "assistant_message", tokens_out: 159, cache_write: 32938 });
    expect(sub[2]).toMatchObject({ kind: "shell_command", tokens_out: null });
    expect(sub[3]).toMatchObject({ kind: "file_read", tokens_out: null });
    const synthetic = events.find((e) => e.kind === "error" && e.model === "<synthetic>");
    expect(synthetic).toBeDefined();
  });

  it("merges tool results into their calls", async () => {
    const { events } = await collect(DEMO);
    const shells = events.filter((e) => e.kind === "shell_command");
    expect(shells[0]!.payload).toMatchObject({ command: "npm test", shell: "bash", is_error: true, exit_code: null });
    expect(shells[0]!.payload.error).toMatch(/^<toolUseResult placeholder/);
    expect(shells[1]!.payload).toMatchObject({ is_error: false });
    expect(typeof shells[1]!.payload.stdout_excerpt).toBe("string");
    const ps = shells.find((e) => e.payload.shell === "powershell");
    expect(ps).toBeDefined();
    expect(ps!.summary.startsWith("$ ")).toBe(true);

    const edit = events.find((e) => e.kind === "file_edit")!;
    expect(edit.payload.path).toMatch(/^C:\\Users\\USER\\projects\\demo-app\\src\\/);
    expect(edit.payload.unified_diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@\n/);
    const write = events.find((e) => e.kind === "file_write")!;
    expect(write.payload).toMatchObject({ operation: "create" });
    expect(typeof write.payload.bytes).toBe("number");

    const mcp = events.find((e) => e.kind === "tool_call" && String(e.payload.tool_name).startsWith("mcp__"))!;
    expect(mcp.payload).toMatchObject({ tool_name: "mcp__example__tool_1", is_error: true });
    expect(events.find((e) => e.kind === "web_fetch")!.payload).toMatchObject({ url: "https://example.com/docs" });
  });

  it("links the subagent transcript to its Agent call", async () => {
    const { events } = await collect(DEMO);
    const start = events.find((e) => e.kind === "subagent_start")!;
    expect(start.payload).toMatchObject({ agent_id: "a0000000000000001", subagent_type: "general-purpose" });
    const end = events.find((e) => e.kind === "subagent_end")!;
    expect(end.payload).toMatchObject({ agent_id: "a0000000000000001", subagent_id: "a0000000000000001" });
    expect(end.ts).toBe("2026-01-16T09:45:29.735Z");
  });

  it("matches the expected normalized snapshot", async () => {
    const { events, sessions } = await collect(DEMO);
    const snapshot = {
      session: { ...sessions[0], source_file: "<fixture>", source_hash: "<hash>" },
      events: events.map(({ raw: _raw, ...rest }) => rest),
    };
    await expect(JSON.stringify(snapshot, null, 2) + "\n").toMatchFileSnapshot(
      path.join(FIXTURES, "expected", `${DEMO_SID}.json`),
    );
  });
});

describe("claude code adapter: malformed input", () => {
  it("never throws and keeps unknown lines as unknown events", async () => {
    const { events, warnings, sessions } = await collect(MALFORMED);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message", // 2
      "unknown", // 8 unknown line type
      "unknown", // 9 unknown content block
      "unknown", // 10 assistant without message
      "tool_result", // 11 orphan result
      "user_message", // 12
    ]);
    expect(warnings.map((w) => w.line)).toEqual([3, 5, 6, 7, 8, 9, 10, 11, 13]);
    for (const w of warnings) expect(w.file).toBe(MALFORMED);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("<prompt placeholder>");
  });

  it("falls back to the previous timestamp when a line's timestamp is invalid", async () => {
    const { events } = await collect(MALFORMED);
    const orphan = events.find((e) => e.kind === "tool_result")!;
    expect(orphan.ts).toBe("2026-01-20T09:00:04.000Z");
    expect(orphan.payload).toMatchObject({ tool_use_id: "toolu_does_not_exist", is_error: true });
  });
});
