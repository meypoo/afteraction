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

const SCHEMA_VERSION = 1;

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
  event_count INTEGER NOT NULL DEFAULT 0
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
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return db;
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
  args: { sourceFile: string; source: string; fingerprint: string; session: Session | null; events: NormalizedEvent[]; warnings: ParseWarning[] },
): void {
  const { sourceFile, session, events, warnings } = args;
  const insertEvent = db.prepare(`INSERT INTO events
    (id, session_id, seq, ts, kind, summary, payload, raw, tokens_in, tokens_out, cache_read, cache_write, model, risk_level, risk_rules)
    VALUES (@id, @session_id, @seq, @ts, @kind, @summary, @payload, @raw, @tokens_in, @tokens_out, @cache_read, @cache_write, @model, @risk_level, @risk_rules)`);
  const insertWarning = db.prepare("INSERT INTO parse_warnings (source_file, file, line, message) VALUES (?, ?, ?, ?)");

  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE source_file = ?").run(sourceFile);
    db.prepare("DELETE FROM parse_warnings WHERE source_file = ?").run(sourceFile);
    if (session) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id); // same session id from another file: last wins
      db.prepare(`INSERT INTO sessions
        (id, source, project_path, git_branch, started_at, ended_at, model, title, total_input_tokens, total_output_tokens,
         total_cache_read_tokens, total_cache_write_tokens, est_cost_usd, max_risk, source_file, source_hash, event_count)
        VALUES (@id, @source, @project_path, @git_branch, @started_at, @ended_at, @model, @title, @total_input_tokens,
         @total_output_tokens, @total_cache_read_tokens, @total_cache_write_tokens, @est_cost_usd, @max_risk, @source_file,
         @source_hash, @event_count)`).run({ ...session, event_count: events.length });
      for (const e of events) {
        insertEvent.run({
          ...e,
          payload: JSON.stringify(e.payload),
          raw: JSON.stringify(e.raw ?? null),
          risk_rules: JSON.stringify(e.risk_rules),
        });
      }
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
}

export interface ListOptions {
  /** ISO timestamp or relative duration like "7d"; matches sessions active at or after it. */
  since?: string;
  project?: string;
  risk?: RiskLevel;
  source?: string;
  limit?: number;
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
  if (opts.risk) {
    // --risk high means "high or worse"
    const levels = RISK_ORDER.slice(RISK_ORDER.indexOf(opts.risk));
    where.push(`max_risk IN (${levels.map((l) => `'${l}'`).join(",")})`);
  }
  const sql = `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(started_at, '') DESC ${opts.limit ? "LIMIT " + Math.trunc(opts.limit) : ""}`;
  return db.prepare(sql).all(params) as SessionRow[];
}

export function getSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

/** Accept a full id, a bare uuid, or a unique prefix of either. Returns null if none or ambiguous. */
export function resolveSession(db: Db, query: string): string | null {
  if (getSession(db, query)) return query;
  const rows = db
    .prepare("SELECT id FROM sessions WHERE id LIKE @q OR substr(id, instr(id, ':') + 1) LIKE @q LIMIT 2")
    .all({ q: `${query.replace(/[%_]/g, "")}%` }) as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

interface EventRow extends Omit<NormalizedEvent, "payload" | "raw" | "risk_rules"> {
  payload: string;
  raw: string;
  risk_rules: string;
}

export function getEvents(db: Db, sessionId: string, opts: { withRaw?: boolean; kinds?: EventKind[] } = {}): NormalizedEvent[] {
  const cols = opts.withRaw ? "*" : "id, session_id, seq, ts, kind, summary, payload, 'null' AS raw, tokens_in, tokens_out, cache_read, cache_write, model, risk_level, risk_rules";
  const kindFilter = opts.kinds?.length ? `AND kind IN (${opts.kinds.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(`SELECT ${cols} FROM events WHERE session_id = ? ${kindFilter} ORDER BY seq`)
    .all(sessionId, ...(opts.kinds ?? [])) as EventRow[];
  return rows.map((r) => ({
    ...r,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    raw: JSON.parse(r.raw) as unknown,
    risk_rules: JSON.parse(r.risk_rules) as string[],
  }));
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
