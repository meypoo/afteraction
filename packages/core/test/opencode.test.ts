import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { opencodeAdapter } from "../src/adapters/opencode.js";
import type { NormalizedEvent, ParseWarning, Session } from "../src/model.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/opencode");
const S1 = "ses_fixture00000000000001";
const S2 = "ses_fixture00000000000002";
const CWD = "C:\\Users\\USER\\projects\\demo-app";

let tmp: string;
let root: string;
let dbFile: string;

beforeAll(() => {
  // The fixture is SQL text (diffable, and *.db is git-ignored); build the database from it.
  tmp = mkdtempSync(path.join(os.tmpdir(), "afteraction-opencode-"));
  root = path.join(tmp, "opencode");
  mkdirSync(root);
  dbFile = path.join(root, "opencode.db");
  const db = new Database(dbFile);
  db.exec(readFileSync(path.join(FIXTURES, "opencode.sql"), "utf8"));
  db.close();
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function collect(file: string) {
  const events: NormalizedEvent[] = [];
  const warnings: ParseWarning[] = [];
  const sessions: Session[] = [];
  for await (const rec of opencodeAdapter.parse(file)) {
    if (rec.type === "event") events.push(rec.event);
    else if (rec.type === "warning") warnings.push(rec.warning);
    else sessions.push(rec.session);
  }
  return { events, warnings, sessions };
}

describe("opencode adapter: discover", () => {
  it("returns one path per session in the database", async () => {
    expect(await opencodeAdapter.discover(root)).toEqual([`${dbFile}#${S1}`, `${dbFile}#${S2}`]);
  });

  it("returns nothing for a missing root", async () => {
    expect(await opencodeAdapter.discover(path.join(tmp, "does-not-exist"))).toEqual([]);
  });
});

describe("opencode adapter: session", () => {
  it("maps parts to events in order and skips bookkeeping parts", async () => {
    const { events, warnings } = await collect(`${dbFile}#${S1}`);
    expect(warnings).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "assistant_message", "shell_command", "file_read",
      "thinking", "file_read", "shell_command", "tool_call", // patch part skipped
      // compaction part skipped
      "assistant_message", // compaction summary
      "user_message", // synthetic "Continue"
      "thinking", "assistant_message",
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
  });

  it("maps tools, exit codes and durations", async () => {
    const { events } = await collect(`${dbFile}#${S1}`);
    const [ok, failing] = events.filter((e) => e.kind === "shell_command");
    expect(ok!.payload).toMatchObject({ command: "git status", exit_code: 0, is_error: false, stdout_excerpt: "On branch main\n", duration_ms: 400 });
    expect(failing!.payload).toMatchObject({ command: "npm test", exit_code: 1, is_error: true, stdout_excerpt: "1 failing\n" });
    const reads = events.filter((e) => e.kind === "file_read");
    expect(reads.map((e) => e.payload.path)).toEqual([`${CWD}\\package.json`, `${CWD}\\src`]);
    expect(reads[1]!.payload.directory).toBe(true);
    const glob = events.find((e) => e.kind === "tool_call")!;
    expect(glob.summary).toBe("glob: **/*.env");
    expect(glob.payload).toMatchObject({ tool_name: "glob", input: { pattern: "**/*.env" }, output_excerpt: "No files found" });
  });

  it("marks injected prompts and compaction summaries", async () => {
    const { events } = await collect(`${dbFile}#${S1}`);
    expect(events[8]!.payload.compact_summary).toBe(true);
    expect(events[9]!.payload.meta).toBe(true);
    expect(events[10]!.payload).toMatchObject({ redacted: true });
  });

  it("puts each message's usage on its first event, with reasoning billed as output", async () => {
    const { events, sessions } = await collect(`${dbFile}#${S1}`);
    const withTokens = events.filter((e) => e.tokens_in !== null);
    expect(withTokens.map((e) => [e.seq, e.tokens_in, e.tokens_out, e.cache_read])).toEqual([
      [1, 1200, 90, 800],
      [4, 300, 160, 2000],
      [8, 5000, 400, 0],
      [10, 200, 70, 6000],
    ]);
    expect(sessions[0]).toMatchObject({
      id: `opencode:${S1}`,
      source: "opencode",
      project_path: CWD,
      title: "Review the demo app for bugs",
      model: "claude-sonnet-5-5",
      started_at: "2026-01-15T10:00:00.000Z",
      ended_at: "2026-01-15T10:10:00.000Z",
      total_input_tokens: 6700,
      total_output_tokens: 720,
      total_cache_read_tokens: 8800,
      total_cache_write_tokens: 0,
    });
  });

  it("changes its fingerprint when the session changes", async () => {
    const file = `${dbFile}#${S1}`;
    const before = await opencodeAdapter.fingerprint(file);
    expect(await opencodeAdapter.fingerprint(file)).toBe(before);
    const db = new Database(dbFile);
    db.prepare("UPDATE session SET time_updated = time_updated + 1 WHERE id = ?").run(S1);
    db.close();
    expect(await opencodeAdapter.fingerprint(file)).not.toBe(before);
    expect(await opencodeAdapter.fingerprint(`${dbFile}#${S2}`)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("matches the expected normalized snapshot", async () => {
    const { events, sessions } = await collect(`${dbFile}#${S1}`);
    const snapshot = {
      session: { ...sessions[0], source_file: "<fixture>", source_hash: "<hash>" },
      events: events.map(({ raw: _raw, ...rest }) => rest),
    };
    await expect(JSON.stringify(snapshot, null, 2) + "\n").toMatchFileSnapshot(path.join(FIXTURES, "expected", `${S1}.json`));
  });
});

describe("opencode adapter: malformed rows", () => {
  it("never throws, warns and keeps what it can", async () => {
    const { events, warnings, sessions } = await collect(`${dbFile}#${S2}`);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message", "unknown", // file part
      "shell_command", "error", // tool error + message error
      "assistant_message", // usage without parts
      "assistant_message", // bad time and tokens
    ]);
    expect(warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/^message msg_0002\d+: invalid JSON/),
      expect.stringMatching(/^message msg_0002\d+: not a JSON object/),
      expect.stringMatching(/^part prt_\d+: invalid JSON/),
      expect.stringMatching(/^part prt_\d+: not a JSON object/),
      expect.stringMatching(/^part prt_\d+: unknown part type "file"/),
    ]);
    expect(events[2]!.payload).toMatchObject({ command: "ls /missing", status: "error", is_error: true, error: "No such file", duration_ms: 5 });
    expect(events[3]!.payload).toMatchObject({ name: "APIError", message: "Rate limited" });
    expect(events[4]!).toMatchObject({ summary: "(no content)", tokens_in: 7, tokens_out: 3 });
    expect(events[5]!).toMatchObject({ ts: null, tokens_in: null });
    expect(sessions[0]).toMatchObject({ title: "List the files.", project_path: CWD });
  });

  it("warns for a path that is not <db>#<session> or a session that is gone", async () => {
    expect((await collect(dbFile)).warnings).toHaveLength(1);
    const gone = await collect(`${dbFile}#ses_missing`);
    expect(gone.sessions).toEqual([]);
    expect(gone.warnings).toEqual([{ file: `${dbFile}#ses_missing`, line: null, message: "session not found in database" }]);
  });
});

describe("opencode adapter: write and edit tools", () => {
  it("maps write/edit to file events and notices content changed without a time_updated bump", async () => {
    const ENV = path.win32.join("C:\\Users\\USER", ".env");
    const APP = path.win32.join(CWD, "src", "app.ts");
    const dir = path.join(tmp, "opencode-writes");
    mkdirSync(dir);
    const file = path.join(dir, "opencode.db");
    const db = new Database(file);
    db.exec(readFileSync(path.join(FIXTURES, "opencode.sql"), "utf8"));
    const part = (id: string, tool: string, input: object) =>
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, 'msg_00020011', ?, 1768474800010, 1768474800010, ?)")
        .run(id, S2, JSON.stringify({ type: "tool", tool, callID: id, state: { status: "completed", input, output: "", time: { start: 1768474800010, end: 1768474800011 } } }));
    part("prt_00090", "write", { filePath: ENV, content: "A=1\nB=2\n" });
    part("prt_00091", "edit", { filePath: APP, oldString: "a\nb", newString: "c" });
    const before = await opencodeAdapter.fingerprint(`${file}#${S2}`);
    db.prepare("UPDATE part SET data = replace(data, 'A=1', 'A=12') WHERE id = 'prt_00090'").run();
    db.close();
    expect(await opencodeAdapter.fingerprint(`${file}#${S2}`)).not.toBe(before);

    const { events } = await collect(`${file}#${S2}`);
    expect(events.find((e) => e.kind === "file_write")?.payload).toMatchObject({ path: ENV, lines_added: 2, content_excerpt: "A=12\nB=2\n" });
    expect(events.find((e) => e.kind === "file_edit")?.payload).toMatchObject({ path: APP, lines_added: 1, lines_removed: 2, new_excerpt: "c" });
  });
});
