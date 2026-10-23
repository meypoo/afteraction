// SQLite storage (better-sqlite3) for sessions, events and ingest state.
import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventKind, NormalizedEvent, ParseWarning, RiskLevel, Session } from "./model.js";

export type Db = Database.Database;

export function defaultDbPath(): string {
  return path.join(os.homedir(), ".flightrec", "flightrec.db");
}

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  project_path TEXT,
  git_branch TEXT,
  started_at TEXT,
  ended_at TEXT,
  model TEXT,
  title TEXT NOT NULL,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL,
  max_risk TEXT NOT NULL DEFAULT 'none',
  source_file TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  unpriced_models TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS sessions_source_file ON sessions(source_file);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  raw TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  usage_extra TEXT,
  est_cost_usd REAL,
  model TEXT,
  risk_level TEXT NOT NULL DEFAULT 'none',
  risk_rules TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind);

CREATE TABLE IF NOT EXISTS ingest_files (
  source_file TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  session_id TEXT,
  ingested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parse_warnings (
  source_file TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parse_warnings_source ON parse_warnings(source_file);
CREATE INDEX IF NOT EXISTS events_risk ON events(risk_level) WHERE risk_level != 'none';

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Full-text search over session titles, prompts and shell commands.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(session_id UNINDEXED, kind UNINDEXED, text);

CREATE VIEW IF NOT EXISTS file_touches AS
  SELECT session_id,
         json_extract(payload, '$.path') AS path,
         SUM(kind = 'file_read') AS reads,
         SUM(kind = 'file_write') AS writes,
         SUM(kind = 'file_edit') AS edits,
         MIN(ts) AS first_ts,
         MAX(ts) AS last_ts
  FROM events
  WHERE kind IN ('file_read', 'file_write', 'file_edit')
  GROUP BY session_id, path;
`;

export function openDb(file = defaultDbPath()): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  if (file !== ":memory:") {
    try {
      chmodSync(file, 0o600); // user-only; best effort on Windows
    } catch {
      // ignore: some filesystems do not support chmod
    }
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(`Database ${file} was created by a newer flightrec (schema ${version}).`);
  }
  if (version > 0 && version < SCHEMA_VERSION) {
    // Everything here is derived from the agents' own logs, so an older layout is rebuilt, not migrated.
    db.exec(`DROP VIEW IF EXISTS file_touches; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS ingest_files; DROP TABLE IF EXISTS parse_warnings; DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS search;`);
  }
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function getMeta(db: Db, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getFingerprint(db: Db, sourceFile: string): string | undefined {
  const row = db.prepare("SELECT fingerprint FROM ingest_files WHERE source_file = ?").get(sourceFile) as
    | { fingerprint: string }
    | undefined;
  return row?.fingerprint;
}

/** Replace everything stored for one source file in a single transaction. */
export function replaceSession(
  db: Db,
  args: {
    sourceFile: string; source: string; fingerprint: string; session: Session | null; events: NormalizedEvent[];
    warnings: ParseWarning[]; unpricedModels?: string[];
  },
): void {
  const { sourceFile, session, events, warnings } = args;
  const insertEvent = db.prepare(`INSERT INTO events
    (id, session_id, seq, ts, kind, summary, payload, raw, tokens_in, tokens_out, cache_read, cache_write, usage_extra, est_cost_usd, model, risk_level, risk_rules)
    VALUES (@id, @session_id, @seq, @ts, @kind, @summary, @payload, @raw, @tokens_in, @tokens_out, @cache_read, @cache_write, @usage_extra, @est_cost_usd, @model, @risk_level, @risk_rules)`);
  const insertSearch = db.prepare("INSERT INTO search (session_id, kind, text) VALUES (?, ?, ?)");
  const insertWarning = db.prepare("INSERT INTO parse_warnings (source_file, file, line, message) VALUES (?, ?, ?, ?)");

  db.transaction(() => {
    const old = db.prepare("SELECT id FROM sessions WHERE source_file = ? OR id = ?").all(sourceFile, session?.id ?? "") as { id: string }[];
    for (const { id } of old) db.prepare("DELETE FROM search WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE source_file = ?").run(sourceFile);
    db.prepare("DELETE FROM parse_warnings WHERE source_file = ?").run(sourceFile);
    if (session) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id); // same session id from another file: last wins
      db.prepare(`INSERT INTO sessions
        (id, source, project_path, git_branch, started_at, ended_at, model, title, total_input_tokens, total_output_tokens,
         total_cache_read_tokens, total_cache_write_tokens, est_cost_usd, max_risk, source_file, source_hash, event_count,
         unpriced_models)
        VALUES (@id, @source, @project_path, @git_branch, @started_at, @ended_at, @model, @title, @total_input_tokens,
         @total_output_tokens, @total_cache_read_tokens, @total_cache_write_tokens, @est_cost_usd, @max_risk, @source_file,
         @source_hash, @event_count, @unpriced_models)`).run({
        ...session, event_count: events.length, unpriced_models: JSON.stringify(args.unpricedModels ?? []),
      });
      for (const e of events) {
        insertEvent.run({
          ...e,
          payload: JSON.stringify(e.payload),
          raw: JSON.stringify(e.raw ?? null),
          usage_extra: e.usage_extra ? JSON.stringify(e.usage_extra) : null,
          est_cost_usd: e.est_cost_usd ?? null,
          risk_rules: JSON.stringify(e.risk_rules),
        });
        const text =
          e.kind === "user_message" && e.payload.meta !== true ? e.payload.text : e.kind === "shell_command" ? e.payload.command : null;
        if (typeof text === "string" && text) insertSearch.run(session.id, e.kind, text);
      }
      insertSearch.run(session.id, "title", session.title);
    }
    for (const w of warnings) insertWarning.run(sourceFile, w.file, w.line, w.message);
    db.prepare(`INSERT INTO ingest_files (source_file, source, fingerprint, session_id, ingested_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_file) DO UPDATE SET fingerprint = excluded.fingerprint, session_id = excluded.session_id,
        ingested_at = excluded.ingested_at`).run(sourceFile, args.source, args.fingerprint, session?.id ?? null, new Date().toISOString());
  })();
}

export interface SessionRow extends Session {
  event_count: number;
  /** JSON array of models whose tokens could not be priced (why est_cost_usd is null). */
  unpriced_models: string;
}

export interface ListOptions {
  /** ISO timestamp or relative duration like "7d"; matches sessions active at or after it. */
  since?: string;
  /** Sessions that started before this ISO timestamp or date. */
  until?: string;
  project?: string;
  risk?: RiskLevel;
  source?: string;
  /** Full-text search over titles, prompts and shell commands. */
  q?: string;
  limit?: number;
  offset?: number;
}

/** Turn free text into a safe FTS5 query: every word must match, as a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  return words?.length ? words.map((w) => `"${w}"*`).join(" ") : null;
}

const RISK_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/** Parse "7d", "24h", "30m", "2w" or an ISO date into an ISO timestamp. */
export function parseSince(value: string, now = new Date()): string {
  const m = /^(\d+)\s*([mhdw])$/.exec(value.trim());
  if (m) {
    const ms = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2] as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() - Number(m[1]) * ms).toISOString();
  }
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`Invalid --since value "${value}" (use e.g. 7d, 24h or 2026-01-31)`);
  return new Date(t).toISOString();
}

export function listSessions(db: Db, opts: ListOptions = {}): SessionRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.since) {
    where.push("COALESCE(ended_at, started_at) >= @since");
    params.since = parseSince(opts.since);
  }
  if (opts.project) {
    where.push("project_path LIKE @project");
    params.project = `%${opts.project}%`;
  }
  if (opts.source) {
    where.push("source = @source");
    params.source = opts.source;
  }
  if (opts.until) {
    where.push("COALESCE(started_at, '') < @until");
    params.until = parseSince(opts.until);
  }
  if (opts.risk) {
    // --risk high means "high or worse"
    const levels = RISK_ORDER.slice(RISK_ORDER.indexOf(opts.risk));
    where.push(`max_risk IN (${levels.map((l) => `'${l}'`).join(",")})`);
  }
  if (opts.q !== undefined) {
    const q = ftsQuery(opts.q);
    if (!q) return [];
    where.push("id IN (SELECT session_id FROM search WHERE search MATCH @q)");
    params.q = q;
  }
  const limit = opts.limit ? `LIMIT ${Math.trunc(opts.limit)} OFFSET ${Math.trunc(opts.offset ?? 0)}` : "";
  const sql = `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(started_at, '') DESC ${limit}`;
  return db.prepare(sql).all(params) as SessionRow[];
}

export function getSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

/** Accept a full id, a bare uuid, or a unique prefix of either. Returns null if none or ambiguous. */
export function resolveSession(db: Db, query: string): string | null {
  if (getSession(db, query)) return query;
  if (query === "latest") {
    const row = db.prepare("SELECT id FROM sessions ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 1").get() as { id: string } | undefined;
    return row?.id ?? null;
  }
  const rows = db
    .prepare("SELECT id FROM sessions WHERE id LIKE @q OR substr(id, instr(id, ':') + 1) LIKE @q LIMIT 2")
    .all({ q: `${query.replace(/[%_]/g, "")}%` }) as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

interface EventRow extends Omit<NormalizedEvent, "payload" | "raw" | "risk_rules" | "usage_extra"> {
  payload: string;
  raw: string;
  risk_rules: string;
  usage_extra: string | null;
}

function fromRow(r: EventRow): NormalizedEvent {
  return {
    ...r,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    raw: JSON.parse(r.raw) as unknown,
    risk_rules: JSON.parse(r.risk_rules) as string[],
    usage_extra: r.usage_extra ? (JSON.parse(r.usage_extra) as NormalizedEvent["usage_extra"]) : null,
  };
}

const EVENT_COLS = ["id", "session_id", "seq", "ts", "kind", "summary", "payload", "tokens_in", "tokens_out", "cache_read",
  "cache_write", "usage_extra", "est_cost_usd", "model", "risk_level", "risk_rules"];
const eventCols = (prefix = "") => EVENT_COLS.map((c) => prefix + c).join(", ") + ", 'null' AS raw";

export function getEvents(db: Db, sessionId: string, opts: { withRaw?: boolean; kinds?: EventKind[] } = {}): NormalizedEvent[] {
  const cols = opts.withRaw ? "*" : eventCols();
  const kindFilter = opts.kinds?.length ? `AND kind IN (${opts.kinds.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(`SELECT ${cols} FROM events WHERE session_id = ? ${kindFilter} ORDER BY seq`)
    .all(sessionId, ...(opts.kinds ?? [])) as EventRow[];
  return rows.map(fromRow);
}

export function getEvent(db: Db, id: string, opts: { withRaw?: boolean } = {}): NormalizedEvent | undefined {
  const row = db.prepare(`SELECT ${opts.withRaw ? "*" : eventCols()} FROM events WHERE id = ?`).get(id) as EventRow | undefined;
  return row ? fromRow(row) : undefined;
}

export interface RiskRow extends NormalizedEvent {
  title: string;
  project_path: string | null;
  source: string;
}

/** Flagged events across sessions, worst first. `level` means that level or worse. */
export function listRisks(db: Db, opts: { since?: string; level?: RiskLevel } = {}): RiskRow[] {
  const levels = RISK_ORDER.slice(Math.max(1, RISK_ORDER.indexOf(opts.level ?? "low")));
  const params: unknown[] = [...levels];
  let since = "";
  if (opts.since) {
    since = "AND COALESCE(e.ts, s.started_at) >= ?";
    params.push(parseSince(opts.since));
  }
  const rows = db
    .prepare(`SELECT ${eventCols("e.")}, s.title, s.project_path, s.source
      FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.risk_level IN (${levels.map(() => "?").join(",")}) ${since}
      ORDER BY CASE e.risk_level WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, e.ts DESC`)
    .all(...params) as (EventRow & { title: string; project_path: string | null; source: string })[];
  return rows.map((r) => ({ ...fromRow(r), title: r.title, project_path: r.project_path, source: r.source }));
}

/** Rewrite stored risk results and cost for one session (after rules or prices change). */
export function updateDerived(
  db: Db,
  sessionId: string,
  events: Pick<NormalizedEvent, "id" | "risk_level" | "risk_rules" | "est_cost_usd">[],
  session: { max_risk: RiskLevel; est_cost_usd: number | null; unpriced_models: string[] },
): void {
  const upd = db.prepare("UPDATE events SET risk_level = ?, risk_rules = ?, est_cost_usd = ? WHERE id = ?");
  db.transaction(() => {
    for (const e of events) upd.run(e.risk_level, JSON.stringify(e.risk_rules), e.est_cost_usd ?? null, e.id);
    db.prepare("UPDATE sessions SET max_risk = ?, est_cost_usd = ?, unpriced_models = ? WHERE id = ?").run(
      session.max_risk, session.est_cost_usd, JSON.stringify(session.unpriced_models), sessionId,
    );
  })();
}

export interface FileTouch {
  session_id: string;
  path: string;
  reads: number;
  writes: number;
  edits: number;
  first_ts: string | null;
  last_ts: string | null;
}

export function fileTouches(db: Db, sessionId: string): FileTouch[] {
  return db.prepare("SELECT * FROM file_touches WHERE session_id = ? ORDER BY path").all(sessionId) as FileTouch[];
}

export interface WarningSummary {
  total: number;
  byFile: { source_file: string; count: number }[];
  sample: ParseWarning[];
}

export function warningSummary(db: Db, sampleSize = 20): WarningSummary {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM parse_warnings").get() as { n: number }).n;
  const byFile = db
    .prepare("SELECT source_file, COUNT(*) AS count FROM parse_warnings GROUP BY source_file ORDER BY count DESC")
    .all() as { source_file: string; count: number }[];
  const rows = db.prepare("SELECT file, line, message FROM parse_warnings ORDER BY rowid LIMIT ?").all(sampleSize) as ParseWarning[];
  return { total, byFile, sample: rows };
}

export function sourceCounts(db: Db): { source: string; sessions: number; events: number }[] {
  return db
    .prepare("SELECT source, COUNT(*) AS sessions, COALESCE(SUM(event_count), 0) AS events FROM sessions GROUP BY source")
    .all() as { source: string; sessions: number; events: number }[];
}

export function listProjects(db: Db): { project_path: string; sessions: number }[] {
  return db
    .prepare("SELECT project_path, COUNT(*) AS sessions FROM sessions WHERE project_path IS NOT NULL GROUP BY project_path ORDER BY sessions DESC")
    .all() as { project_path: string; sessions: number }[];
}

export interface CostSummary {
  total_usd: number;
  /** Sessions left out of totals because a model had no price. */
  unpriced_sessions: number;
  by_day: { day: string; usd: number }[];
  by_project: { project_path: string | null; usd: number; sessions: number }[];
  by_model: { model: string; usd: number; tokens: number }[];
  top_sessions: SessionRow[];
}

/** Cost breakdowns from per-event estimates. Days are UTC dates of the events. */
export function costSummary(db: Db, opts: { since?: string } = {}): CostSummary {
  const since = opts.since ? parseSince(opts.since) : "";
  const evWhere = "e.est_cost_usd IS NOT NULL AND COALESCE(e.ts, '') >= @since";
  const p = { since };
  const by_day = db
    .prepare(`SELECT substr(e.ts, 1, 10) AS day, SUM(e.est_cost_usd) AS usd FROM events e
      WHERE ${evWhere} AND e.ts IS NOT NULL GROUP BY day ORDER BY day`)
    .all(p) as { day: string; usd: number }[];
  const by_model = db
    .prepare(`SELECT e.model AS model, SUM(e.est_cost_usd) AS usd,
        SUM(COALESCE(e.tokens_in,0) + COALESCE(e.tokens_out,0) + COALESCE(e.cache_read,0) + COALESCE(e.cache_write,0)) AS tokens
      FROM events e WHERE ${evWhere} AND e.model IS NOT NULL AND e.est_cost_usd > 0 GROUP BY e.model ORDER BY usd DESC`)
    .all(p) as { model: string; usd: number; tokens: number }[];
  const sWhere = "COALESCE(ended_at, started_at, '') >= @since";
  const by_project = db
    .prepare(`SELECT project_path, SUM(est_cost_usd) AS usd, COUNT(*) AS sessions FROM sessions
      WHERE ${sWhere} AND est_cost_usd IS NOT NULL GROUP BY project_path ORDER BY usd DESC`)
    .all(p) as { project_path: string | null; usd: number; sessions: number }[];
  const top_sessions = db
    .prepare(`SELECT * FROM sessions WHERE ${sWhere} AND est_cost_usd IS NOT NULL ORDER BY est_cost_usd DESC LIMIT 10`)
    .all(p) as SessionRow[];
  const unpriced_sessions = (db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${sWhere} AND est_cost_usd IS NULL`).get(p) as { n: number }).n;
  const total_usd = by_project.reduce((a, r) => a + r.usd, 0);
  return { total_usd, unpriced_sessions, by_day, by_project, by_model, top_sessions };
}

/**
 * Delete stored sessions (events, search entries, warnings) that ended before `before`, or all of them.
 * Ingest fingerprints are kept, so purged logs only come back if they change or on `ingest --full`.
 */
export function purgeSessions(db: Db, opts: { before?: string } = {}): { sessions: number; events: number } {
  const cutoff = opts.before ? parseSince(opts.before) : null;
  const rows = (
    cutoff
      ? db.prepare("SELECT id, source_file, event_count FROM sessions WHERE COALESCE(ended_at, started_at, '') < ?").all(cutoff)
      : db.prepare("SELECT id, source_file, event_count FROM sessions").all()
  ) as { id: string; source_file: string; event_count: number }[];
  db.transaction(() => {
    for (const r of rows) {
      db.prepare("DELETE FROM search WHERE session_id = ?").run(r.id);
      db.prepare("DELETE FROM parse_warnings WHERE source_file = ?").run(r.source_file);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(r.id); // events cascade
      db.prepare("UPDATE ingest_files SET session_id = NULL WHERE source_file = ?").run(r.source_file);
    }
  })();
  if (rows.length) {
    try {
      db.exec("VACUUM"); // give the space back to the OS
    } catch {
      // VACUUM needs free temp space; the rows are deleted either way
    }
  }
  return { sessions: rows.length, events: rows.reduce((a, r) => a + r.event_count, 0) };
}
