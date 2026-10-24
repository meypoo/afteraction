import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { ADAPTERS, getEvents, ingest, listSessions, openDb, type Db, type NormalizedEvent } from "@afteraction/core";
import { writeDemoLogs } from "../src/demo.js";
import { App, detailLines, windowStart, wrap, type TuiData } from "../src/tui.js";

let tmp: string;
let db: Db;
let data: TuiData;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "afteraction-tui-"));
  db = openDb(path.join(tmp, "demo.db"));
  await ingest(db, { sources: [{ adapter: ADAPTERS.claude!, root: writeDemoLogs(tmp) }] });
  data = { sessions: () => listSessions(db), events: (id) => getEvents(db, id) };
});

afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Ink applies input on the next tick.
const tick = () => new Promise((r) => setTimeout(r, 20));
async function press(stdin: { write: (s: string) => void }, ...keys: string[]) {
  await tick(); // let Ink attach its input listener after the first render
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

describe("tui helpers", () => {
  it("keeps the selection inside the window", () => {
    expect(windowStart(0, 100, 10)).toBe(0);
    expect(windowStart(50, 100, 10)).toBe(45);
    expect(windowStart(99, 100, 10)).toBe(90);
    expect(windowStart(3, 4, 10)).toBe(0);
  });

  it("hard-wraps long lines and keeps line breaks", () => {
    expect(wrap("abcdefgh\nxy", 3)).toEqual(["abc", "def", "gh", "xy"]);
  });

  it("masks secrets in the detail pane unless revealed", () => {
    const e = {
      id: "e1", session_id: "s", seq: 1, ts: null, kind: "shell_command", summary: "echo",
      payload: { command: "echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz", exit_code: 0 },
      raw: null, tokens_in: null, tokens_out: null, cache_read: null, cache_write: null, usage_extra: null, model: null,
      risk_level: "none", risk_rules: [],
    } satisfies NormalizedEvent;
    const masked = detailLines(e, { width: 80, reveal: false, project: null }).map((l) => l.text).join("\n");
    expect(masked).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const shown = detailLines(e, { width: 80, reveal: true, project: null }).map((l) => l.text).join("\n");
    expect(shown).toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
  });
});

describe("tui", () => {
  it("lists sessions and opens one with enter", async () => {
    const sessions = data.sessions();
    const { lastFrame, stdin, unmount } = render(<App data={data} />);
    expect(lastFrame()).toContain(`${sessions.length} sessions`);
    expect(lastFrame()).toContain(sessions[0]!.title.slice(0, 20));
    await press(stdin, "\r");
    expect(lastFrame()).toContain(`${sessions[0]!.event_count} events`);
    expect(lastFrame()).toContain("next/prev risk");
    await press(stdin, "\x1b");
    expect(lastFrame()).toContain("enter open");
    unmount();
  });

  it("filters the list with /", async () => {
    const target = data.sessions().at(-1)!;
    const { lastFrame, stdin, unmount } = render(<App data={data} />);
    await press(stdin, "/", ...target.title.slice(0, 12), "\r");
    expect(lastFrame()).toContain("matches");
    expect(lastFrame()).toContain(target.title.slice(0, 12));
    unmount();
  });

  it("marks claims and jumps to the next one with c", async () => {
    const dark = data.sessions().find((s) => s.title.includes("dark mode"))!;
    const { lastFrame, stdin, unmount } = render(<App data={data} initialSessionId={dark.id} />);
    await press(stdin);
    expect(lastFrame()).toContain("no risks · 1 contrad");
    expect(lastFrame()).toContain("✗ claim");
    await press(stdin, "c");
    expect(lastFrame()).toContain("✗ CONTRADICTED tests claim · The last test run before this claim failed");
    expect(lastFrame()).toContain("$ npx jest src/theme");
    unmount();
  });

  it("jumps to the next risk with r", async () => {
    const risky = data.sessions().find((s) => s.max_risk !== "none")!;
    const first = data.events(risky.id).find((e) => e.risk_level !== "none" && e.kind !== "thinking")!;
    const { lastFrame, stdin, unmount } = render(<App data={data} initialSessionId={risky.id} />);
    await press(stdin, "r");
    expect(lastFrame()).toContain(`#${first.seq} ·`);
    expect(lastFrame()).toContain(first.risk_rules[0]!);
    unmount();
  });
});
