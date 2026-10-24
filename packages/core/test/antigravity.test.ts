import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { antigravityAdapter, readAntigravitySummaries } from "../src/adapters/antigravity.js";
import type { NormalizedEvent, ParseWarning, Session } from "../src/model.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/antigravity");
const U1 = "aaaaaaaa-0000-4000-8000-000000000001";
const U2 = "aaaaaaaa-0000-4000-8000-000000000002";
const U3 = "aaaaaaaa-0000-4000-8000-000000000003";
const TRANSCRIPT = (root: string, uuid: string) =>
  path.join(root, "brain", uuid, ".system_generated", "logs", "transcript.jsonl");
const FULL = TRANSCRIPT(FIXTURES, U1);
const META_ONLY = path.join(FIXTURES, "conversations", `${U2}.pb`);
const MALFORMED = TRANSCRIPT(path.join(FIXTURES, "malformed"), U3);
const P = "c:\\Users\\USER\\projects\\demo-app";

async function collect(file: string) {
  const events: NormalizedEvent[] = [];
  const warnings: ParseWarning[] = [];
  const sessions: Session[] = [];
  for await (const rec of antigravityAdapter.parse(file)) {
    if (rec.type === "event") events.push(rec.event);
    else if (rec.type === "warning") warnings.push(rec.warning);
    else sessions.push(rec.session);
  }
  return { events, warnings, sessions };
}

describe("antigravity adapter: discover", () => {
  it("prefers the readable transcript and falls back to the encrypted conversation file", async () => {
    expect(await antigravityAdapter.discover(FIXTURES)).toEqual([FULL, META_ONLY]);
  });

  it("finds transcripts that have no conversation file", async () => {
    expect(await antigravityAdapter.discover(path.join(FIXTURES, "malformed"))).toEqual([MALFORMED]);
  });

  it("returns nothing for a missing root", async () => {
    expect(await antigravityAdapter.discover(path.join(FIXTURES, "does-not-exist"))).toEqual([]);
  });
});

describe("antigravity adapter: summaries protobuf", () => {
  it("reads title, step count, times and workspace per conversation", async () => {
    const s = await readAntigravitySummaries(FIXTURES);
    expect(s.get(U1)).toEqual({
      title: "Fix login form",
      steps: 64,
      created: "2026-01-15T10:00:00.000Z",
      updated: "2026-01-15T11:00:00.500Z",
      workspace: P,
    });
    expect(s.get(U2)?.title).toBe("Scaffold demo app");
    expect(s.get("cccccccc-0000-4000-8000-00000000dead")).toEqual({
      title: null, steps: null, created: null, updated: null, workspace: null,
    });
  });
});

describe("antigravity adapter: transcript", () => {
  it("maps steps to events in order and skips injected system steps", async () => {
    const { events, warnings } = await collect(FULL);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message", // 25
      "thinking", "tool_call", // 28 manage_task (+ result 29)
      "thinking", "shell_command", // 30 (+ 31)
      "file_read", // 32 (+ 33)
      "assistant_message", "file_edit", // 35 (+ 36)
      "file_edit", // 37 multi_replace (+ 38)
      "file_write", // 39 (+ 40)
      "tool_call", // 41 artifact (+ 42)
      "tool_call", // 43 grep (+ 44)
      "shell_command", // 45 background (+ 46)
      "error", // 47
      "tool_call", // 48 list_dir (+ 49)
      "shell_command", // 50 (+ 51)
      "thinking", "assistant_message", // 52
      "user_message", // 53
      "unknown", // 54
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(warnings).toEqual([{ file: FULL, line: 30, message: 'unknown step type "BROWSER_SUBAGENT"' }]);
  });

  it("decodes JSON-encoded tool arguments and attaches results", async () => {
    const { events } = await collect(FULL);
    const shells = events.filter((e) => e.kind === "shell_command").map((e) => e.payload);
    expect(shells[0]).toMatchObject({
      command: "npm run dev", cwd: P, exit_code: 1, is_error: true, duration_ms: 60000,
      stdout_excerpt: "\n> demo-app@0.1.0 dev\n> next dev\n\nPort 3000 is in use.\n",
    });
    expect(shells[1]).toMatchObject({ command: "npm test", background: true, task_id: `${U1}/task-46` });
    expect(shells[2]).toMatchObject({ command: "git status", exit_code: 0, is_error: false, stdout_excerpt: "On branch main\nnothing to commit\n" });

    const read = events.find((e) => e.kind === "file_read")!;
    expect(read.payload).toMatchObject({ path: `${P}\\src\\login.ts`, start_line: 1, end_line: 40 });
    expect(read.summary).toBe(`Read ${P}\\src\\login.ts`);

    const [edit, multi] = events.filter((e) => e.kind === "file_edit");
    expect(edit!.payload).toMatchObject({
      path: `${P}\\src\\login.ts`, old_excerpt: "const timeout = 10;", new_excerpt: "const timeout = 30;",
      lines_added: 1, lines_removed: 1,
    });
    expect(edit!.payload.unified_diff).toBe(
      "@@ -1,3 +1,3 @@\n import { form } from './form';\n-const timeout = 10;\n+const timeout = 30;\n \n",
    );
    expect(multi!.payload).toMatchObject({ path: `${P}\\src\\form.ts`, chunks: 2, lines_added: 3, lines_removed: 2 });

    const write = events.find((e) => e.kind === "file_write")!;
    expect(write.payload).toMatchObject({ path: `${P}\\src\\retry.ts`, bytes: 54, lines_added: 2 });
  });

  it("keeps artifacts out of file writes so they are not flagged as writes outside the project", async () => {
    const { events } = await collect(FULL);
    const artifact = events.find((e) => e.payload.artifact === true)!;
    expect(artifact.kind).toBe("tool_call");
    expect(artifact.summary).toBe("Artifact analysis_results.md");
  });

  it("builds the session from the summary and the transcript", async () => {
    const { sessions } = await collect(FULL);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: `antigravity:${U1}`,
      source: "antigravity",
      project_path: P,
      title: "Fix login form",
      started_at: "2026-01-15T10:00:00.000Z",
      ended_at: "2026-01-15T11:00:00.500Z",
      model: null,
      total_input_tokens: 0,
      est_cost_usd: null,
    });
    expect(sessions[0]!.source_hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("matches the expected normalized snapshot", async () => {
    const { events, sessions } = await collect(FULL);
    const snapshot = {
      session: { ...sessions[0], source_file: "<fixture>", source_hash: "<hash>" },
      events: events.map(({ raw: _raw, ...rest }) => rest),
    };
    await expect(JSON.stringify(snapshot, null, 2) + "\n").toMatchFileSnapshot(
      path.join(FIXTURES, "expected", `${U1}.json`),
    );
  });
});

describe("antigravity adapter: metadata only", () => {
  it("shows the agent's documents when the transcript is encrypted", async () => {
    const { events, warnings, sessions } = await collect(META_ONLY);
    expect(warnings).toEqual([]);
    expect(events.map((e) => [e.ts, e.kind, e.summary])).toEqual([
      ["2026-01-16T10:10:00.000Z", "assistant_message", "implementation_plan.md: Plan for the demo app scaffold."],
      ["2026-01-16T10:30:00.123Z", "assistant_message", "task.md: Task list for scaffolding the demo app."],
    ]);
    expect(events[1]!.payload).toMatchObject({ artifact: "task.md", artifact_type: "ARTIFACT_TYPE_TASK", metadata_only: true });
    expect(sessions[0]).toMatchObject({
      id: `antigravity:${U2}`,
      title: "Scaffold demo app",
      project_path: P,
      started_at: "2026-01-16T10:00:00.250Z",
      ended_at: "2026-01-16T11:00:00.000Z",
    });
  });
});

describe("antigravity adapter: malformed input", () => {
  it("never throws, warns with line numbers and keeps what it can", async () => {
    const { events, warnings, sessions } = await collect(MALFORMED);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message", // 1
      "tool_result", // 6 orphan result
      "shell_command", // 7 unencoded argument, bad timestamp
      "unknown", // 8
      "user_message", // 9 no wrapper tags
    ]);
    expect(events[2]!.payload.command).toBe("not-json-encoded");
    expect(events[2]!.ts).toBeNull();
    expect(events[4]!.payload.text).toBe("no wrapper tags");
    expect(warnings.map((w) => w.line)).toEqual([2, 4, 5, 8]);
    expect(sessions[0]).toMatchObject({ title: "List the files.", project_path: null, started_at: "2026-01-15T10:00:00Z" });
  });

  it("warns instead of throwing for a file it does not recognise", async () => {
    const { events, warnings, sessions } = await collect(path.join(FIXTURES, "agyhub_summaries_proto.pb"));
    expect(events).toEqual([]);
    expect(sessions).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
