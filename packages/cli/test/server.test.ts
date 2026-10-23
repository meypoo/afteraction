import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeAdapter, ingest, openDb, type Db } from "@flightrec/core";
import { createApp } from "../src/server.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/claude-code");
const SID = "11111111-2222-4333-8444-555555555555";
const ID = `claude:${SID}`;
const PORT = 4317;
const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

let tmp: string;
let db: Db;
let app: ReturnType<typeof createApp>;

const get = (url: string, host = `127.0.0.1:${PORT}`) => app.request(url, { headers: host ? { Host: host } : {} });
const json = async (url: string) => {
  const res = await get(url);
  expect(res.status, url).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON shapes in assertions
  return (await res.json()) as Record<string, any>;
};

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "flightrec-server-"));
  cpSync(path.join(FIXTURES, "projects"), path.join(tmp, "projects"), { recursive: true });
  appendFileSync(
    path.join(tmp, "projects", "C--Users-USER-projects-demo-app", `${SID}.jsonl`),
    [
      { type: "assistant", uuid: "00000000-0000-4000-8000-999999999991", timestamp: "2026-01-16T11:00:00.000Z", sessionId: SID,
        message: { id: "msg_x", model: "claude-opus-5-5", role: "assistant",
          content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: `echo ${SECRET}` } }] } },
      { type: "user", uuid: "00000000-0000-4000-8000-999999999992", timestamp: "2026-01-16T11:00:01.000Z", sessionId: SID,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: SECRET }] },
        toolUseResult: { stdout: SECRET, stderr: "", interrupted: false, isImage: false } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  db = openDb(path.join(tmp, "flightrec.db"));
  await ingest(db, { sources: [{ adapter: claudeCodeAdapter, root: path.join(tmp, "projects") }] });
  const web = path.join(tmp, "web");
  mkdirSync(path.join(web, "assets"), { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>flightrec</title>");
  writeFileSync(path.join(web, "assets", "app.js"), "console.log(1)");
  writeFileSync(path.join(tmp, "secret.txt"), "do not serve");
  app = createApp({ db, port: PORT, webRoot: web, version: "0.1.0" });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("host header check", () => {
  it("accepts loopback hosts on the right port only", async () => {
    for (const h of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]) expect((await get("/api/meta", h)).status).toBe(200);
    for (const h of ["evil.example", `evil.example:${PORT}`, "127.0.0.1:9999", "", `127.0.0.1.evil.example:${PORT}`]) {
      expect((await get("/api/meta", h)).status, h).toBe(403);
    }
  });

  it("sends no CORS headers and sets protective headers", async () => {
    const res = await get("/api/meta");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("api", () => {
  it("reports version and the cost label", async () => {
    const m = await json("/api/meta");
    expect(m).toMatchObject({ version: "0.1.0", cost_label: "Estimated, API-equivalent pricing", prices: { confirmed: true } });
    expect(m.prices.last_updated).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("lists and filters sessions", async () => {
    expect((await json("/api/sessions")).sessions.map((s: { id: string }) => s.id)).toEqual([ID]);
    expect((await json("/api/sessions?q=npm")).sessions).toHaveLength(1);
    expect((await json("/api/sessions?q=nothingmatches")).sessions).toHaveLength(0);
    expect((await json("/api/sessions?risk=high")).sessions).toHaveLength(1); // secret-in-output
    expect((await json("/api/sessions?agent=codex")).sessions).toHaveLength(0);
    expect((await json("/api/sessions?project=demo")).sessions).toHaveLength(1);
    expect((await get("/api/sessions?since=soon")).status).toBe(400);
    expect((await json("/api/projects")).projects).toHaveLength(1);
  });

  it("returns session detail, events and files", async () => {
    const d = await json(`/api/sessions/${encodeURIComponent(ID)}`);
    expect(d.session).toMatchObject({ id: ID, max_risk: "high" });
    expect(d.files.find((f: { path: string }) => f.path.endsWith("file3.py"))).toMatchObject({ reads: 1, writes: 1, edits: 2 });
    const ev = await json(`/api/sessions/${encodeURIComponent(ID)}/events`);
    expect(ev.events[2]).toMatchObject({ kind: "shell_command", payload: { command: "npm test" } });
    expect(ev.events.every((e: { raw: unknown }) => e.raw === null)).toBe(true);
    expect((await get(`/api/sessions/${encodeURIComponent("claude:nope")}`)).status).toBe(404);
  });

  it("masks secrets unless reveal is asked for", async () => {
    const res = await get(`/api/sessions/${encodeURIComponent(ID)}/events`);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).toContain("sk-ant…[redacted]");
    const events = JSON.parse(text).events as { id: string; kind: string; risk_rules: string[] }[];
    const leaky = events.find((e) => e.risk_rules.includes("secret-in-output"))!;
    const one = await json(`/api/events/${encodeURIComponent(leaky.id)}`);
    expect(JSON.stringify(one)).not.toContain(SECRET);
    const revealed = await json(`/api/events/${encodeURIComponent(leaky.id)}?reveal=1&raw=1`);
    expect(revealed.event.payload.stdout_excerpt).toBe(SECRET);
    expect(revealed.event.raw).toMatchObject({ tool_result: { type: "user" } });
  });

  it("serves a redacted receipt", async () => {
    const res = await get(`/api/sessions/${encodeURIComponent(ID)}/receipt`);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    const md = await res.text();
    expect(md).toContain("### 🛫 Agent session receipt");
    expect(md).not.toContain(SECRET);
  });

  it("lists risks and costs", async () => {
    const r = await json("/api/risks");
    expect(r.risks.map((x: { risk_rules: string[] }) => x.risk_rules)).toEqual([["secret-in-output"]]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const c = await json("/api/costs");
    expect(c.total_usd).toBeCloseTo(3.14159155 + 0, 2);
    expect(c.cost_label).toBe("Estimated, API-equivalent pricing");
  });

  it("returns 404 JSON for unknown API routes", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});

describe("static files", () => {
  it("serves the built UI with an SPA fallback", async () => {
    const index = await get("/");
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    expect(await index.text()).toContain("<title>flightrec</title>");
    expect(await (await get("/sessions/abc")).text()).toContain("<title>flightrec</title>");
    const js = await get("/assets/app.js");
    expect(js.headers.get("content-type")).toMatch(/javascript/);
  });

  it("never serves files outside the web root", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const res = await get(p);
      expect(await res.text(), p).not.toContain("do not serve");
    }
  });

  it("explains how to build the UI when it is missing", async () => {
    const bare = createApp({ db, port: PORT, webRoot: path.join(tmp, "missing"), version: "0.1.0" });
    const res = await bare.request("/", { headers: { Host: `127.0.0.1:${PORT}` } });
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/pnpm build/);
  });
});
