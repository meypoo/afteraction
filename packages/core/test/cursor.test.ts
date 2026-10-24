import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { collect, expectSnapshot, FIXTURES_ROOT } from "./helpers.js";

const FIX = path.join(FIXTURES_ROOT, "cursor");
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";

let tmp: string;
let user: string;
let db: string;

function build(file: string, sqlFile: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.exec(readFileSync(path.join(FIX, sqlFile), "utf8"));
  conn.close();
}

beforeAll(() => {
  // Fixtures are SQL text (*.db is git-ignored); build Cursor's User folder from them.
  tmp = mkdtempSync(path.join(os.tmpdir(), "flightrec-cursor-"));
  user = path.join(tmp, "User");
  db = path.join(user, "globalStorage", "state.vscdb");
  build(db, "globalStorage.sql");
  const ws = path.join(user, "workspaceStorage", "abc123");
  build(path.join(ws, "state.vscdb"), "workspace.sql");
  copyFileSync(path.join(FIX, "workspace.json"), path.join(ws, "workspace.json"));
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("cursor adapter", () => {
  it("lists chats that have messages and skips empty drafts", async () => {
    expect(await cursorAdapter.discover(user)).toEqual([`${db}#${C1}`, `${db}#${C2}`]);
    expect(await cursorAdapter.discover(path.join(tmp, "missing"))).toEqual([]);
  });

  it("maps bubbles and tool calls in order", async () => {
    const { events, warnings } = await collect(cursorAdapter, `${db}#${C1}`);
    expect(events.map((e) => e.kind)).toEqual([
      "user_message",
      "thinking", "assistant_message",
      "file_read", "shell_command", "file_edit", "file_edit", "file_write", "tool_call",
      "assistant_message",
      "unknown",
    ]);
    expect(warnings.map((w) => w.message)).toEqual(["bubble b10: unknown bubble type 9", "bubble missing: missing or not JSON"]);
  });

  it("reads tool arguments and results", async () => {
    const { events } = await collect(cursorAdapter, `${db}#${C1}`);
    expect(events[3]!.payload).toMatchObject({ path: "src/login.ts", tool_use_id: "t1" });
    expect(events[4]!.payload).toMatchObject({ command: "npm test", exit_code: 1, is_error: true, stdout_excerpt: "1 failing\n", description: "Run tests" });
    expect(events[5]!.payload).toMatchObject({ path: "src/login.ts", old_excerpt: "retries = 0", new_excerpt: "retries = 3" });
    expect(events[6]!.payload).toMatchObject({ path: "src/api.ts", new_excerpt: "retry(fetch)\n", unified_diff: "@@ -1 +1 @@\n-fetch\n+retry(fetch)\n" });
    expect(events[7]!.payload).toMatchObject({ path: "src/retry.ts", bytes: 31 });
    expect(events[8]!.payload).toMatchObject({ tool_name: "grep", status: "error", is_error: true });
  });

  it("builds the session with its workspace folder, model and usage", async () => {
    const { events, sessions } = await collect(cursorAdapter, `${db}#${C1}`);
    expect(events.filter((e) => e.tokens_in !== null).map((e) => [e.seq, e.tokens_in, e.tokens_out])).toEqual([[1, 900, 60], [9, 400, 30]]);
    expect(sessions[0]).toMatchObject({
      id: `cursor:${C1}`,
      source: "cursor",
      project_path: "c:\\Users\\USER\\projects\\demo-app",
      model: "claude-sonnet-5-5",
      title: "Login retry",
      started_at: "2026-01-15T10:00:00.000Z",
      ended_at: "2026-01-15T10:00:30.000Z",
      total_input_tokens: 1300,
      total_output_tokens: 90,
    });
  });

  it("reads old chats with inline conversations", async () => {
    const { events, sessions } = await collect(cursorAdapter, `${db}#${C2}`);
    expect(events.map((e) => [e.kind, e.summary])).toEqual([
      ["user_message", "Explain the build script."],
      ["assistant_message", "It bundles the CLI with esbuild."],
    ]);
    expect(sessions[0]).toMatchObject({ title: "Explain the build script.", model: "gpt-5", project_path: null });
  });

  it("changes its fingerprint when a bubble changes", async () => {
    const file = `${db}#${C1}`;
    const before = await cursorAdapter.fingerprint(file);
    const conn = new Database(db);
    conn.prepare("UPDATE cursorDiskKV SET value = value || ' ' WHERE key = ?").run(`bubbleId:${C1}:b9`);
    conn.close();
    expect(await cursorAdapter.fingerprint(file)).not.toBe(before);
  });

  it("matches the expected normalized snapshot", async () => {
    await expectSnapshot(cursorAdapter, `${db}#${C1}`, path.join(FIX, "expected", `${C1}.json`));
  });

  it("warns for a missing chat or a bad path", async () => {
    expect((await collect(cursorAdapter, `${db}#nope`)).warnings).toHaveLength(1);
    expect((await collect(cursorAdapter, db)).warnings).toHaveLength(1);
  });
});
