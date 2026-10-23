// Local web server: JSON API over the store plus the built web UI. Loopback only.
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildReceipt,
  COST_LABEL,
  costSummary,
  fileTouches,
  getEvent,
  getEvents,
  getSession,
  listProjects,
  listRisks,
  listSessions,
  loadPrices,
  maskSecrets,
  RULES,
  sourceCounts,
  type Db,
  type RiskLevel,
} from "@flightrec/core";

export interface ServerOptions {
  db: Db;
  port: number;
  /** Directory with the built web UI (index.html + assets). */
  webRoot: string;
  version: string;
}

const RISKS: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/** Mask API keys in every string of a JSON-like value. */
function maskDeep<T>(v: T): T {
  if (typeof v === "string") return maskSecrets(v) as T;
  if (Array.isArray(v)) return v.map(maskDeep) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x)])) as T;
  }
  return v;
}

class BadRequest extends Error {}

export function createApp(opts: ServerOptions): Hono {
  const { db, port, webRoot, version } = opts;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const app = new Hono();

  // DNS-rebinding protection: only answer requests addressed to the loopback host we listen on.
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return c.text("Forbidden: flightrec only answers on localhost.", 403);
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  app.onError((err, c) => {
    if (err instanceof BadRequest || /Invalid --since/.test(err.message)) return c.json({ error: err.message.replace("--since ", "") }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  const reveal = (c: Context) => c.req.query("reveal") === "1";
  const out = <T>(c: Context, v: T) => (reveal(c) ? v : maskDeep(v));
  const risk = (v: string | undefined): RiskLevel | undefined => {
    if (!v) return undefined;
    if (!RISKS.includes(v as RiskLevel)) throw new BadRequest(`Invalid risk level "${v}"`);
    return v as RiskLevel;
  };

  app.get("/api/meta", (c) => {
    const p = loadPrices();
    return c.json({
      version,
      cost_label: COST_LABEL,
      prices: { last_updated: p.last_updated, confirmed: p.confirmed, source: p.source },
      sources: sourceCounts(db),
      rules: RULES.map((r) => ({ id: r.id, severity: r.severity, description: r.description })),
    });
  });

  app.get("/api/sessions", (c) => {
    const q = c.req.query();
    const limit = Math.min(Number(q.limit) || 500, 5000);
    const sessions = listSessions(db, {
      source: q.agent || undefined,
      project: q.project || undefined,
      since: q.since || undefined,
      until: q.until || undefined,
      risk: risk(q.risk),
      q: q.q?.trim() ? q.q : undefined,
      limit,
      offset: Number(q.offset) || 0,
    });
    return c.json(out(c, { sessions }));
  });

  app.get("/api/projects", (c) => c.json(out(c, { projects: listProjects(db) })));

  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = getSession(db, id);
    if (!session) return c.json({ error: "session not found" }, 404);
    return c.json(out(c, { session, files: fileTouches(db, id) }));
  });

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!getSession(db, id)) return c.json({ error: "session not found" }, 404);
    return c.json(out(c, { events: getEvents(db, id) }));
  });

  app.get("/api/sessions/:id/receipt", (c) => {
    const id = c.req.param("id");
    const session = getSession(db, id);
    if (!session) return c.json({ error: "session not found" }, 404);
    const md = buildReceipt(session, getEvents(db, id), { version, redact: c.req.query("redact") !== "0" });
    return c.body(md, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  app.get("/api/events/:id", (c) => {
    const event = getEvent(db, c.req.param("id"), { withRaw: c.req.query("raw") === "1" });
    if (!event) return c.json({ error: "event not found" }, 404);
    return c.json(out(c, { event }));
  });

  app.get("/api/risks", (c) => {
    const q = c.req.query();
    return c.json(out(c, { risks: listRisks(db, { since: q.since || undefined, level: risk(q.level) }) }));
  });

  app.get("/api/costs", (c) => c.json(out(c, { ...costSummary(db, { since: c.req.query("since") || undefined }), cost_label: COST_LABEL })));

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // Static UI with single-page-app fallback.
  const root = path.resolve(webRoot);
  app.get("*", (c) => {
    const index = path.join(root, "index.html");
    if (!existsSync(index)) {
      return c.text('The web UI has not been built. Run "pnpm build" in the flightrec repo, then restart.', 503);
    }
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      rel = "/";
    }
    const file = path.resolve(root, "." + rel);
    const inside = file === root || file.startsWith(root + path.sep);
    if (inside && rel !== "/" && existsSync(file) && statSync(file).isFile()) {
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      const cache = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      return c.body(readFileSync(file), 200, { "Content-Type": type, "Cache-Control": cache });
    }
    return c.body(readFileSync(index), 200, { "Content-Type": MIME[".html"]!, "Cache-Control": "no-cache" });
  });

  return app;
}

/** Listen on 127.0.0.1 only. Resolves once the port is bound. */
export function startServer(opts: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp(opts);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, () =>
      resolve({
        url: `http://localhost:${opts.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
    server.on("error", reject);
  });
}
