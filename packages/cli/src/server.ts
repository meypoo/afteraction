// Local web server: JSON API over the store plus the built web UI. Loopback only.
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildReceipt,
  COST_LABEL,
  costSummary,
  fileTouches,
  getEvent,
  getEvents,
  getSession,
  InvalidSince,
  listProjects,
  listRisks,
  listSessions,
  loadPrices,
  maskDeep,
  RULES,
  sourceCounts,
  type Db,
  type RiskLevel,
} from "@afteraction/core";

export interface ServerOptions {
  db: Db;
  port: number;
  /** Directory with the built web UI (index.html + assets). */
  webRoot: string;
  version: string;
  /**
   * Per-launch secret. When set, every request must carry it: once as ?token= on a page URL (which sets a
   * cookie and redirects), then in that cookie or an "Authorization: Bearer" header. Other local users and
   * processes can reach a loopback port, so the port alone is not access control.
   */
  token?: string;
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

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

class BadRequest extends Error {}

/** Integer query parameter in [min, max]; absent means `fallback`, anything else is a 400. */
function intParam(v: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === "") return fallback;
  const n = /^\d{1,16}$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequest(`Invalid ${name} "${v}" (expected ${min} to ${max})`);
  return n;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A fresh random value for ServerOptions.token. */
export const newToken = (): string => randomBytes(24).toString("base64url");

export function createApp(opts: ServerOptions): Hono {
  const { db, port, webRoot, version } = opts;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  // Cookies are shared by every port on a host, so the name carries the port.
  const cookieName = `afteraction_${port}`;
  const app = new Hono();

  // Hardening headers on every response, including the 401/403s and error pages below.
  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
    // Sessions hold prompts, commands and (with ?reveal=1) secrets: never cache them.
    if (c.req.path.startsWith("/api/")) c.res.headers.set("Cache-Control", "no-store");
  });

  // DNS-rebinding protection: only answer requests addressed to the loopback host we listen on.
  app.use("*", async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return c.text("Forbidden: afteraction only answers on localhost.", 403);
    await next();
  });

  if (opts.token) {
    const token = opts.token;
    app.use("*", async (c, next) => {
      const fromUrl = c.req.query("token");
      if (fromUrl !== undefined && c.req.method === "GET" && !c.req.path.startsWith("/api/")) {
        if (!sameSecret(fromUrl, token)) return c.text("Forbidden: wrong token. Open the URL afteraction printed in your terminal.", 403);
        const url = new URL(c.req.url);
        url.searchParams.delete("token");
        c.header("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`);
        c.header("Cache-Control", "no-store");
        return c.redirect(url.pathname + url.search, 302);
      }
      const cookie = (c.req.header("cookie") ?? "")
        .split(/;\s*/)
        .find((p) => p.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1);
      const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
      const given = cookie ?? bearer;
      if (!given || !sameSecret(given, token)) {
        const msg = "Unauthorized: open the URL afteraction printed in your terminal (it carries this launch's token).";
        return c.req.path.startsWith("/api/") ? c.json({ error: msg }, 401) : c.text(msg, 401);
      }
      await next();
    });
  }

  app.onError((err, c) => {
    if (err instanceof BadRequest || err instanceof InvalidSince) return c.json({ error: err.message.replace("--since ", "") }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // The API is read-only: nothing but GET/HEAD reaches it, so no cross-site request can change state.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "method not allowed" }, 405);
    await next();
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
    const sessions = listSessions(db, {
      source: q.agent || undefined,
      project: q.project || undefined,
      since: q.since || undefined,
      until: q.until || undefined,
      risk: risk(q.risk),
      q: q.q?.trim() ? q.q : undefined,
      limit: intParam(q.limit, "limit", 500, 1, 5000),
      offset: intParam(q.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
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

  // Static UI with single-page-app fallback. Containment is checked on real paths, so a symlink
  // inside the web root cannot serve a file from outside it.
  const root = path.resolve(webRoot);
  const realRoot = (() => {
    try {
      return realpathSync(root);
    } catch {
      return root;
    }
  })();
  app.get("*", (c) => {
    const index = path.join(root, "index.html");
    if (!existsSync(index)) {
      return c.text('The web UI has not been built. Run "pnpm build" in the afteraction repo, then restart.', 503);
    }
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      rel = "/";
    }
    if (rel !== "/" && !rel.includes("\0")) {
      let real: string | undefined;
      try {
        real = realpathSync(path.resolve(root, "." + rel));
      } catch {
        real = undefined; // missing: fall through to the app
      }
      if (real && real.startsWith(realRoot + path.sep) && statSync(real).isFile()) {
        const type = MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream";
        const cache = rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        return c.body(readFileSync(real), 200, { "Content-Type": type, "Cache-Control": cache });
      }
    }
    return c.body(readFileSync(index), 200, { "Content-Type": MIME[".html"]!, "Cache-Control": "no-cache" });
  });

  return app;
}

/** Listen on 127.0.0.1 only. Resolves once the port is bound; `url` carries the token when one is set. */
export function startServer(opts: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp(opts);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, () =>
      resolve({
        url: `http://localhost:${opts.port}/${opts.token ? `?token=${opts.token}` : ""}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
    server.on("error", reject);
  });
}
