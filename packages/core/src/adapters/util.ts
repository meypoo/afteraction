// Small helpers shared by the adapters added after Claude Code and Codex.
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { excerpt, type EventKind, type NormalizedEvent } from "../model.js";

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** An ISO string, or epoch milliseconds, as ISO; anything else as null. */
export function toIso(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === "string" && v && !Number.isNaN(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return undefined;
  }
}

/** Recursively cap long strings so payload inputs stay small; full data is kept in `raw`. */
export function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return excerpt(v);
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, depth + 1)]));
  return v;
}

export const lineCount = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const TAIL_BYTES = 64 * 1024;

/**
 * One file's change stamp: size, nanosecond mtime and a hash of its last 64 KB, so a same-size rewrite
 * inside one coarse mtime tick is still noticed. Missing files stamp as "missing".
 */
export async function fileStamp(f: string): Promise<string> {
  try {
    const s = await stat(f, { bigint: true });
    const fh = await open(f, "r");
    try {
      const len = Number(s.size < BigInt(TAIL_BYTES) ? s.size : BigInt(TAIL_BYTES));
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, Number(s.size) - len);
      return `${path.basename(f)}:${s.size}:${s.mtimeNs}:${createHash("sha1").update(buf).digest("hex")}`;
    } finally {
      await fh.close();
    }
  } catch {
    return `${path.basename(f)}:missing`;
  }
}

/** sha1 over the change stamps of the given files (missing files count too). */
export async function statFingerprint(files: string[]): Promise<string> {
  const h = createHash("sha1");
  for (const f of files) h.update((await fileStamp(f)) + "\n");
  return h.digest("hex");
}

export interface Tokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Draft {
  ts: string | null;
  kind: EventKind;
  summary: string;
  payload: Obj;
  raw: unknown;
  model: string | null;
  tokens?: Tokens;
}

export function toEvents(sessionId: string, drafts: Draft[]): NormalizedEvent[] {
  return drafts.map((d, seq) => ({
    id: `${sessionId}:${seq}`,
    session_id: sessionId,
    seq,
    ts: d.ts,
    kind: d.kind,
    summary: d.summary,
    payload: JSON.parse(JSON.stringify(d.payload)) as Obj, // drop undefined fields
    raw: d.raw,
    tokens_in: d.tokens?.in ?? null,
    tokens_out: d.tokens?.out ?? null,
    cache_read: d.tokens?.cacheRead ?? null,
    cache_write: d.tokens?.cacheWrite ?? null,
    usage_extra: null,
    model: d.model,
    risk_level: "none",
    risk_rules: [],
  }));
}

export function sumTokens(drafts: Draft[]): Tokens {
  const t: Tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const d of drafts) {
    if (!d.tokens) continue;
    t.in += d.tokens.in;
    t.out += d.tokens.out;
    t.cacheRead += d.tokens.cacheRead;
    t.cacheWrite += d.tokens.cacheWrite;
  }
  return t;
}

export function mostCommonModel(drafts: Draft[]): string | null {
  const counts = new Map<string, number>();
  for (const d of drafts) if (d.model) counts.set(d.model, (counts.get(d.model) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [m, c] of counts) if (c > n) [best, n] = [m, c];
  return best;
}

export function timeRange(drafts: Draft[]): [string | null, string | null] {
  const ts = drafts.map((d) => d.ts).filter((x): x is string => !!x).sort();
  return [ts[0] ?? null, ts.at(-1) ?? null];
}

/** Draft for an `unknown` event, with the same reason for the warning. */
export function unknownDraft(ts: string | null, reason: string, raw: unknown): Draft {
  return { ts, kind: "unknown", summary: `Unknown: ${reason}`.slice(0, 120), payload: { reason }, raw, model: null };
}

/** Normalized file operations, shared by every adapter's tool mapping. */
export function shellDraft(base: Omit<Draft, "kind" | "summary" | "payload">, command: string, payload: Obj): Draft {
  return { ...base, kind: "shell_command", summary: `$ ${command.replace(/\s+/g, " ").trim()}`.slice(0, 120), payload: { command: excerpt(command), ...payload } };
}

export function readDraft(base: Omit<Draft, "kind" | "summary" | "payload">, p: string, payload: Obj = {}): Draft {
  return { ...base, kind: "file_read", summary: `Read ${p}`, payload: { path: p, ...payload } };
}

export function writeDraft(base: Omit<Draft, "kind" | "summary" | "payload">, p: string, content: string, payload: Obj = {}): Draft {
  return {
    ...base, kind: "file_write", summary: `Write ${p}`,
    payload: { path: p, content_excerpt: excerpt(content), bytes: Buffer.byteLength(content, "utf8"), lines_added: lineCount(content), lines_removed: 0, ...payload },
  };
}

export function editDraft(base: Omit<Draft, "kind" | "summary" | "payload">, p: string, oldText: string, newText: string, payload: Obj = {}): Draft {
  return {
    ...base, kind: "file_edit", summary: `Edit ${p}`,
    payload: { path: p, old_excerpt: excerpt(oldText), new_excerpt: excerpt(newText), lines_added: lineCount(newText), lines_removed: lineCount(oldText), ...payload },
  };
}
