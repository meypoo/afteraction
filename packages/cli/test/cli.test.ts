import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/claude-code");

let tmp: string;
let dbArgs: string[];

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["node", "flightrec", ...dbArgs, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "flightrec-cli-"));
  cpSync(path.join(FIXTURES, "projects"), path.join(tmp, "projects"), { recursive: true });
  dbArgs = ["--db", path.join(tmp, "flightrec.db"), "--source", `claude=${path.join(tmp, "projects")}`];
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("flightrec cli", () => {
  it("ingests, then skips unchanged files", async () => {
    const first = await cli("ingest");
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/Ingested 1 files: 1 parsed, 0 unchanged · \d+ events · 0 warnings/);
    const second = await cli("ingest");
    expect(second.out).toMatch(/0 parsed, 1 unchanged/);
  });

  it("lists sessions with filters", async () => {
    await cli("ingest");
    const list = await cli("list");
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^STARTED\s+AGENT\s+PROJECT/);
    expect(list.out).toContain("Claude Code");
    expect(list.out).toContain("demo-app");
    expect(list.out).toContain("11111111");
    expect((await cli("list", "--project", "nope")).out).toMatch(/No sessions found/);
    expect((await cli("list", "--risk", "high")).out).toMatch(/No sessions found/);
    const json = JSON.parse((await cli("list", "--json")).out) as { id: string }[];
    expect(json.map((s) => s.id)).toEqual(["claude:11111111-2222-4333-8444-555555555555"]);
  });

  it("rejects bad filter values", async () => {
    await cli("ingest");
    const bad = await cli("list", "--since", "soon");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/Invalid --since/);
    expect((await cli("list", "--risk", "extreme")).code).not.toBe(0);
  });

  it("shows a session timeline by prefix", async () => {
    await cli("ingest");
    const show = await cli("show", "1111");
    expect(show.code).toBe(0);
    expect(show.out).toContain("Claude Code · claude-opus-5");
    expect(show.out).toContain("$ npm test ✗");
    expect(show.out).toMatch(/subagent_start\s+Subagent:/);
    expect(show.out).toMatch(/shell_command\s+↳ \$ node scripts\/check\.js/);
    const missing = await cli("show", "nope");
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/No single session matches "nope"/);
  });

  it("doctor reports sources, counts and warnings", async () => {
    await cli("ingest");
    const doc = await cli("doctor");
    expect(doc.code).toBe(0);
    expect(doc.out).toMatch(/claude_code\s+.*projects\s+\(1 session files/);
    expect(doc.out).toMatch(/claude_code\s+1 sessions · \d+ events/);
    expect(doc.out).toContain("Parse warnings: 0");
  });

  it("prints warnings with file and line during ingest", async () => {
    dbArgs = ["--db", path.join(tmp, "flightrec.db"), "--source", `claude=${FIXTURES}`];
    const res = await cli("ingest");
    expect(res.code).toBe(0);
    expect(res.err).toMatch(/warning: .*22222222-3333-4444-8555-666666666666\.jsonl:3 invalid JSON/);
    expect(res.out).toMatch(/9 warnings/);
  });

  it("validates --source", async () => {
    dbArgs = [];
    const res = await cli("--source", "cursor=/tmp", "ingest");
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/expected name=path/);
  });
});
