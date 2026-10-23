// OpenCode adapter. Format notes: docs/log-formats.md.
//
// OpenCode keeps every session in one SQLite database. The ingest pipeline works per file, so
// discover() returns one virtual path per session: `<database>#<session id>`.
// Only the session, message and part tables are read; never the account or credential tables.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  excerpt,
  oneLine,
  type EventKind,
  type NormalizedEvent,
  type NormalizedRecord,
  type ParseWarning,
  type Session,
  type SourceAdapter,
} from "../model.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const DB_FILE = "opencode.db";

/** Part types that carry no action. `patch` is a working-tree snapshot diff: it also holds edits made
 * by other programs while the session ran, so it is not attributed to the agent. */
const IGNORED_PARTS = new Set(["step-start", "step-finish", "patch", "compaction", "snapshot"]);

/** `~/.local/share/opencode` on every OS observed (Windows included); XDG_DATA_HOME is honoured (inference). */
export function defaultOpencodeRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg || path.join(os.homedir(), ".local", "share"), "opencode");
}

function splitVirtual(file: string): { db: string; sessionId: string } | null {
  const i = file.lastIndexOf("#");
  if (i < 0) return null;
  return { db: file.slice(0, i), sessionId: file.slice(i + 1) };
}

function openReadOnly(db: string): Database.Database {
  return new Database(db, { readonly: true, fileMustExist: true });
}

const iso = (ms: unknown): string | null => {
  const n = typeof ms === "number" ? ms : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return excerpt(v);
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, depth + 1)]));
  return v;
}


interface Draft {
  ts: string | null;
  kind: EventKind;
  summary: string;
  payload: Obj;
  raw: unknown;
  model: string | null;
  tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
}

function toolDraft(part: Obj, ts: string | null, model: string | null): Draft {
  const name = str(part.tool) ?? "(unnamed tool)";
  const state = isObj(part.state) ? part.state : {};
  const input = isObj(state.input) ? state.input : {};
  const meta = isObj(state.metadata) ? state.metadata : {};
  const status = str(state.status);
  const output = str(state.output);
  const error = str(state.error);
  const time = isObj(state.time) ? state.time : {};
  const duration = num(time.end) - num(time.start);
  const base: Obj = {
    tool_use_id: str(part.callID),
    status,
    is_error: status === "error" ? true : undefined,
    error: excerpt(error),
    duration_ms: num(time.start) > 0 && duration >= 0 && num(time.end) > 0 ? duration : undefined,
  };
  const draft = (kind: EventKind, summary: string, payload: Obj): Draft => ({
    ts, kind, summary, payload: { ...base, ...payload }, raw: part, model,
  });
  switch (name) {
    case "bash": {
      const command = str(input.command) ?? "";
      const exit = typeof meta.exit === "number" ? meta.exit : null;
      return draft("shell_command", `$ ${oneLine(command)}`, {
        command: excerpt(command),
        description: str(input.description),
        exit_code: exit,
        is_error: status === "error" || (exit !== null && exit !== 0),
        stdout_excerpt: excerpt(output),
        truncated: meta.truncated === true ? true : undefined,
      });
    }
    case "read": {
      const p = str(input.filePath) ?? "";
      const display = isObj(meta.display) ? meta.display : {};
      return draft("file_read", `Read ${p}`, { path: p, directory: display.type === "directory" ? true : undefined });
    }
    // Only tools seen in real logs are mapped; everything else (write, edit, grep, task, …) stays a
    // tool_call until a real session shows its input shape.
    default: {
      const title = str(state.title);
      return draft("tool_call", title ? `${name}: ${oneLine(title)}` : name, {
        tool_name: name,
        input: capStrings(input),
        output_excerpt: excerpt(output),
      });
    }
  }
}

interface Row {
  id: string;
  data: string;
}

/** Cheap change detector: the session's update time plus its message and part counts and latest updates. */
function sessionFingerprint(db: Database.Database, sessionId: string): string {
  const s = db.prepare("SELECT time_updated FROM session WHERE id = ?").get(sessionId) as { time_updated: number } | undefined;
  const m = db.prepare("SELECT COUNT(*) AS n, MAX(time_updated) AS t FROM message WHERE session_id = ?").get(sessionId) as { n: number; t: number | null };
  const p = db.prepare("SELECT COUNT(*) AS n, MAX(time_updated) AS t FROM part WHERE session_id = ?").get(sessionId) as { n: number; t: number | null };
  return createHash("sha1")
    .update(`${sessionId}:${s?.time_updated ?? "missing"}:${m.n}:${m.t}:${p.n}:${p.t}`)
    .digest("hex");
}

export const opencodeAdapter: SourceAdapter = {
  id: "opencode",
  testedVersions: ["1.19.4"],

  defaultRoot: defaultOpencodeRoot,

  async discover(root = defaultOpencodeRoot()): Promise<string[]> {
    const file = path.join(root, DB_FILE);
    if (!existsSync(file)) return [];
    const db = openReadOnly(file);
    try {
      const rows = db.prepare("SELECT id FROM session ORDER BY time_created, id").all() as { id: string }[];
      return rows.map((r) => `${file}#${r.id}`);
    } catch {
      return []; // not an OpenCode database we understand
    } finally {
      db.close();
    }
  },

  async fingerprint(file: string): Promise<string> {
    const v = splitVirtual(file);
    if (!v) throw new Error(`not an OpenCode session path: ${file}`);
    const db = openReadOnly(v.db);
    try {
      return sessionFingerprint(db, v.sessionId);
    } finally {
      db.close();
    }
  },

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const v = splitVirtual(file);
    if (!v) {
      yield { type: "warning", warning: { file, line: null, message: "not an OpenCode session path (<db>#<session id>)" } };
      return;
    }
    const warnings: ParseWarning[] = [];
    const warn = (message: string) => warnings.push({ file, line: null, message });
    const db = openReadOnly(v.db);
    try {
      const s = db.prepare("SELECT * FROM session WHERE id = ?").get(v.sessionId) as Obj | undefined;
      if (!s) {
        yield { type: "warning", warning: { file, line: null, message: "session not found in database" } };
        return;
      }
      const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(v.sessionId) as Row[];
      const partStmt = db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY id");

      const drafts: Draft[] = [];
      const models = new Map<string, number>();
      let cwd: string | null = null;
      let firstPrompt: string | null = null;
      const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

      for (const row of messages) {
        let m: unknown;
        try {
          m = JSON.parse(row.data);
        } catch {
          warn(`message ${row.id}: invalid JSON, skipped`);
          continue;
        }
        if (!isObj(m)) {
          warn(`message ${row.id}: not a JSON object, skipped`);
          continue;
        }
        const role = str(m.role);
        const mTime = isObj(m.time) ? m.time : {};
        const mTs = iso(mTime.created);
        const model = str(m.modelID) ?? (isObj(m.model) ? str(m.model.modelID) : undefined) ?? null;
        if (role === "assistant" && model) models.set(model, (models.get(model) ?? 0) + 1);
        const mPath = isObj(m.path) ? m.path : {};
        if (role === "assistant") cwd ??= str(mPath.cwd) ?? null;
        const first = drafts.length;

        for (const prow of partStmt.all(row.id) as Row[]) {
          let p: unknown;
          try {
            p = JSON.parse(prow.data);
          } catch {
            warn(`part ${prow.id}: invalid JSON, skipped`);
            continue;
          }
          if (!isObj(p)) {
            warn(`part ${prow.id}: not a JSON object, skipped`);
            continue;
          }
          const type = str(p.type);
          const pTime = isObj(p.time) ? p.time : {};
          const ts = iso(pTime.start) ?? mTs;
          if (type && IGNORED_PARTS.has(type)) continue;
          if (type === "text") {
            const text = str(p.text) ?? "";
            if (role === "user") {
              const synthetic = p.synthetic === true;
              if (!synthetic) firstPrompt ??= text || null;
              drafts.push({
                ts, kind: "user_message", summary: oneLine(text) || "(empty prompt)", raw: p, model: null,
                payload: { text: excerpt(text), meta: synthetic ? true : undefined },
              });
            } else {
              drafts.push({
                ts, kind: "assistant_message", summary: oneLine(text), raw: p, model,
                payload: { text: excerpt(text), compact_summary: m.summary === true ? true : undefined },
              });
            }
            continue;
          }
          if (type === "reasoning") {
            const text = str(p.text) ?? "";
            drafts.push({
              ts, kind: "thinking", summary: text ? oneLine(text) : "(thinking; text not recorded)", raw: p, model,
              payload: { text: excerpt(text), redacted: text === "" },
            });
            continue;
          }
          if (type === "tool") {
            const state = isObj(p.state) ? p.state : {};
            const sTime = isObj(state.time) ? state.time : {};
            drafts.push(toolDraft(p, iso(sTime.start) ?? ts, model));
            continue;
          }
          const reason = `unknown part type ${JSON.stringify(type ?? null)}`;
          warn(`part ${prow.id}: ${reason}`);
          drafts.push({ ts, kind: "unknown", summary: oneLine(`Unknown: ${reason}`), payload: { reason }, raw: p, model: null });
        }

        if (isObj(m.error)) {
          const data = isObj(m.error.data) ? m.error.data : {};
          const message = str(data.message) ?? str(m.error.name) ?? "error";
          drafts.push({
            ts: iso(mTime.completed) ?? mTs, kind: "error", summary: oneLine(`Error: ${message}`), raw: m.error, model,
            payload: { source: "api", name: str(m.error.name), message: excerpt(message) },
          });
        }

        // Usage is per message; reasoning tokens are billed as output.
        const t = isObj(m.tokens) ? m.tokens : null;
        if (role === "assistant" && t) {
          const cache = isObj(t.cache) ? t.cache : {};
          const tokens = { in: num(t.input), out: num(t.output) + num(t.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) };
          totals.in += tokens.in;
          totals.out += tokens.out;
          totals.cacheRead += tokens.cacheRead;
          totals.cacheWrite += tokens.cacheWrite;
          const target = drafts[first];
          if (target) target.tokens = tokens;
          else if (tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite > 0)
            drafts.push({ ts: mTs, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: m, model, tokens });
        }
      }

      for (const w of warnings) yield { type: "warning", warning: w };

      const id = `opencode:${v.sessionId}`;
      for (const [seq, d] of drafts.entries()) {
        const tk = d.tokens;
        const event: NormalizedEvent = {
          id: `${id}:${seq}`,
          session_id: id,
          seq,
          ts: d.ts,
          kind: d.kind,
          summary: d.summary,
          payload: JSON.parse(JSON.stringify(d.payload)) as Obj, // drop undefined fields
          raw: d.raw,
          tokens_in: tk?.in ?? null,
          tokens_out: tk?.out ?? null,
          cache_read: tk?.cacheRead ?? null,
          cache_write: tk?.cacheWrite ?? null,
          usage_extra: null,
          model: d.model,
          risk_level: "none",
          risk_rules: [],
        };
        yield { type: "event", event };
      }

      let model: string | null = null;
      let best = 0;
      for (const [name, n] of models) if (n > best) [model, best] = [name, n];
      const session: Session = {
        id,
        source: "opencode",
        project_path: cwd ?? str(s.directory) ?? null,
        git_branch: null,
        started_at: iso(s.time_created),
        ended_at: iso(s.time_updated),
        model,
        title: oneLine(str(s.title) || firstPrompt || "(untitled)"),
        total_input_tokens: totals.in,
        total_output_tokens: totals.out,
        total_cache_read_tokens: totals.cacheRead,
        total_cache_write_tokens: totals.cacheWrite,
        est_cost_usd: null,
        max_risk: "none",
        source_file: file,
        source_hash: sessionFingerprint(db, v.sessionId),
      };
      yield { type: "session", session };
    } finally {
      db.close();
    }
  },
};
