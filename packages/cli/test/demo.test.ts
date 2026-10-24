import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTERS, getEvents, ingest, listRisks, listSessions, openDb, type Db } from "@afteraction/core";
import { writeDemoLogs } from "../src/demo.js";

let tmp: string;
let db: Db;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "afteraction-demo-test-"));
  db = openDb(path.join(tmp, "demo.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("demo dataset", () => {
  it("parses without warnings and covers every page of the UI", async () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const report = await ingest(db, { sources: [{ adapter: ADAPTERS.claude!, root: writeDemoLogs(tmp, now) }] });
    expect(report).toMatchObject({ filesParsed: 6, sessions: 6, warnings: 0, filesFailed: 0 });

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(6);
    expect(new Set(sessions.map((s) => s.project_path)).size).toBe(4);
    expect(sessions.every((s) => (s.est_cost_usd ?? 0) > 0)).toBe(true);
    // All within the Costs page's default 30-day window.
    expect(sessions.every((s) => now - Date.parse(s.started_at!) < 30 * 86_400_000)).toBe(true);

    const rules = new Set(listRisks(db).flatMap((r) => r.risk_rules));
    for (const rule of [
      "secret-file-read", "secret-in-output", "package-install", "git-force", "git-history-rewrite",
      "db-destructive", "pipe-to-shell", "outside-project-write", "chmod-permissive",
    ]) expect(rules, rule).toContain(rule);
    expect(rules).not.toContain("destructive-rm"); // `rm -rf dist` is a build dir

    const typos = sessions.find((s) => s.title.includes("typos"))!;
    expect(typos.max_risk).toBe("none");
    const edits = getEvents(db, typos.id).filter((e) => e.kind === "file_edit");
    expect(edits).toHaveLength(2);
    expect(edits[0]!.payload.unified_diff).toContain("-Install the CLI with your package manager of choise:");
    expect(edits[0]!.payload.unified_diff).toContain("+Install the CLI with your package manager of choice:");
  });
});
