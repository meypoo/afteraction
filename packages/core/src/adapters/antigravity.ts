// Google Antigravity adapter. Format notes: docs/log-formats.md.
//
// Antigravity encrypts its conversation files (`conversations/<uuid>.pb`). Newer versions also write a
// readable step log at `brain/<uuid>/.system_generated/logs/transcript.jsonl`; when it exists the session
// gets a full timeline. Otherwise the session is built from metadata only: the title, workspace and times
// in `agyhub_summaries_proto.pb` plus the agent's plan/task/walkthrough artifacts in `brain/<uuid>/`.
// If Antigravity ever stores readable transcripts elsewhere, add a reader next to `parseTranscript` and
// return its path from `discover()`.
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
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

const ISO_TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRANSCRIPT = path.join(".system_generated", "logs", "transcript.jsonl");
const SUMMARIES = "agyhub_summaries_proto.pb";

/** Steps injected by Antigravity itself. Known, so no warning. */
const IGNORED_STEPS = new Set(["SYSTEM_MESSAGE", "EPHEMERAL_MESSAGE", "CONVERSATION_HISTORY"]);

/** Steps that carry the result of the model's previous tool call. */
const RESULT_STEPS = new Set([
  "RUN_COMMAND", "VIEW_FILE", "CODE_ACTION", "GREP_SEARCH", "LIST_DIRECTORY", "GENERIC",
]);

export function defaultAntigravityRoot(): string {
  return path.join(os.homedir(), ".gemini", "antigravity");
}

// ---------------------------------------------------------------------------------------------
// agyhub_summaries_proto.pb: plain protobuf without a published schema. Field numbers below were
// matched against the Antigravity UI by hand (see docs/log-formats.md).

interface ProtoField {
  no: number;
  wire: number;
  int?: bigint;
  bytes?: Buffer;
}

function readVarint(b: Buffer, i: number): [bigint, number] {
  let r = 0n;
  let shift = 0n;
  for (;;) {
    if (i >= b.length) throw new Error("truncated varint");
    const x = b[i++]!;
    r |= BigInt(x & 0x7f) << shift;
    if (x < 0x80) return [r, i];
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
}

function decodeProto(b: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let i = 0;
  while (i < b.length) {
    const [key, j] = readVarint(b, i);
    i = j;
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      const [v, k] = readVarint(b, i);
      i = k;
      out.push({ no, wire, int: v });
    } else if (wire === 2) {
      const [len, k] = readVarint(b, i);
      const end = k + Number(len);
      if (end > b.length) throw new Error("truncated field");
      out.push({ no, wire, bytes: b.subarray(k, end) });
      i = end;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 5) {
      i += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

const field = (fs: ProtoField[], no: number) => fs.find((f) => f.no === no);
const fieldStr = (fs: ProtoField[], no: number) => field(fs, no)?.bytes?.toString("utf8");
const fieldMsg = (fs: ProtoField[], no: number): ProtoField[] => {
  const b = field(fs, no)?.bytes;
  return b ? decodeProto(b) : [];
};

function fieldTime(fs: ProtoField[], no: number): string | null {
  const t = fieldMsg(fs, no);
  const secs = field(t, 1)?.int;
  if (secs === undefined) return null;
  const nanos = field(t, 2)?.int ?? 0n;
  const ms = Number(secs) * 1000 + Math.floor(Number(nanos) / 1e6);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export interface AntigravitySummary {
  title: string | null;
  steps: number | null;
  created: string | null;
  updated: string | null;
  workspace: string | null;
}

function workspacePath(uri: string | undefined): string | null {
  if (!uri) return null;
  if (!uri.startsWith("file://")) return uri;
  let p: string;
  try {
    p = decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
  // file:///d:/x is a Windows drive path whatever OS reads it; file:///home/x stays POSIX.
  const drive = /^\/([a-z]):(\/.*)?$/i.exec(p);
  return drive ? `${drive[1]}:${(drive[2] ?? "/").replace(/\//g, "\\")}` : p;
}

/** Conversation summaries by uuid. Throws on a corrupt file; a missing file gives an empty map. */
export async function readAntigravitySummaries(root: string): Promise<Map<string, AntigravitySummary>> {
  let b: Buffer;
  try {
    b = await readFile(path.join(root, SUMMARIES));
  } catch {
    return new Map();
  }
  const out = new Map<string, AntigravitySummary>();
  for (const entry of decodeProto(b)) {
    if (entry.no !== 1 || !entry.bytes) continue;
    const e = decodeProto(entry.bytes);
    const uuid = fieldStr(e, 1);
    if (!uuid) continue;
    const s = fieldMsg(e, 2);
    const steps = field(s, 2)?.int;
    out.set(uuid, {
      title: fieldStr(s, 1) || null,
      steps: steps === undefined ? null : Number(steps),
      created: fieldTime(s, 7),
      updated: fieldTime(s, 3),
      workspace: workspacePath(fieldStr(fieldMsg(s, 9), 1)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

interface Draft {
  ts: string | null;
  kind: EventKind;
  summary: string;
  payload: Obj;
  raw: unknown;
}

/** Tool-call argument values are JSON-encoded strings ("\"npm test\"", "5000", "true"). */
function decodeArgs(args: unknown): Obj {
  if (!isObj(args)) return {};
  const out: Obj = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    try {
      out[k] = JSON.parse(v) as unknown;
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return excerpt(v);
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, depth + 1)]));
  return v;
}

const lineCount = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

function toolDraft(name: string, rawArgs: unknown, ts: string | null, line: Obj): Draft {
  const a = decodeArgs(rawArgs);
  const draft = (kind: EventKind, summary: string, payload: Obj): Draft => ({
    ts, kind, summary, payload: { tool_name: name, ...payload }, raw: line,
  });
  switch (name) {
    case "run_command": {
      const command = str(a.CommandLine) ?? "";
      return draft("shell_command", `$ ${oneLine(command)}`, {
        command: excerpt(command),
        cwd: str(a.Cwd),
        description: str(a.toolSummary),
      });
    }
    case "view_file": {
      const p = str(a.AbsolutePath) ?? "";
      return draft("file_read", `Read ${p}`, {
        path: p,
        start_line: typeof a.StartLine === "number" ? a.StartLine : undefined,
        end_line: typeof a.EndLine === "number" ? a.EndLine : undefined,
      });
    }
    case "write_to_file": {
      const p = str(a.TargetFile) ?? "";
      const content = str(a.CodeContent) ?? "";
      // Artifacts (plans, task lists, walkthroughs) live in Antigravity's own folder, not the project.
      if (a.IsArtifact === true) {
        return draft("tool_call", `Artifact ${path.basename(p)}`, { path: p, artifact: true, input: capStrings(a) });
      }
      return draft("file_write", `Write ${p}`, {
        path: p,
        content_excerpt: excerpt(content),
        bytes: Buffer.byteLength(content, "utf8"),
        lines_added: lineCount(content),
        lines_removed: 0,
      });
    }
    case "replace_file_content": {
      const p = str(a.TargetFile) ?? "";
      const oldText = str(a.TargetContent) ?? "";
      const newText = str(a.ReplacementContent) ?? "";
      return draft("file_edit", `Edit ${p}`, {
        path: p,
        old_excerpt: excerpt(oldText),
        new_excerpt: excerpt(newText),
        description: str(a.Description),
        lines_added: lineCount(newText),
        lines_removed: lineCount(oldText),
      });
    }
    case "multi_replace_file_content": {
      const p = str(a.TargetFile) ?? "";
      const chunks = Array.isArray(a.ReplacementChunks) ? a.ReplacementChunks.filter(isObj) : [];
      const oldText = chunks.map((c) => str(c.TargetContent) ?? "").join("\n…\n");
      const newText = chunks.map((c) => str(c.ReplacementContent) ?? "").join("\n…\n");
      return draft("file_edit", `Edit ${p}`, {
        path: p,
        old_excerpt: excerpt(oldText),
        new_excerpt: excerpt(newText),
        description: str(a.Description),
        chunks: chunks.length,
        lines_added: chunks.reduce((n, c) => n + lineCount(str(c.ReplacementContent) ?? ""), 0),
        lines_removed: chunks.reduce((n, c) => n + lineCount(str(c.TargetContent) ?? ""), 0),
      });
    }
    default: {
      const label = str(a.toolSummary);
      return draft("tool_call", label ? `${name}: ${oneLine(label)}` : name, { input: capStrings(a) });
    }
  }
}

/** Splits "Created At: …\nCompleted At: …\n<body>" into its parts. */
function resultParts(content: string): { created?: string; completed?: string; body: string } {
  let body = content;
  let created: string | undefined;
  let completed: string | undefined;
  for (;;) {
    const m = /^(Created At|Completed At): (\S+)\n/.exec(body);
    if (!m) break;
    if (m[1] === "Created At") created = m[2];
    else completed = m[2];
    body = body.slice(m[0].length);
  }
  return { created, completed, body };
}

function applyResult(d: Draft, step: Obj): void {
  const p = d.payload;
  const content = str(step.content) ?? "";
  const { created, completed, body } = resultParts(content);
  if (created && completed) {
    const ms = Date.parse(completed) - Date.parse(created);
    if (Number.isFinite(ms) && ms >= 0) p.duration_ms = ms;
  }
  if (step.status === "RUNNING") {
    p.background = true;
    const task = /task id: (\S+)/.exec(body);
    if (task) p.task_id = task[1];
  }
  switch (d.kind) {
    case "shell_command": {
      const failed = /The command failed with exit code: (-?\d+)/.exec(body);
      if (failed) p.exit_code = Number(failed[1]);
      else if (/The command completed successfully\./.test(body)) p.exit_code = 0;
      const out = /\n?\t*Output:\n\t*([\s\S]*)$/.exec(body);
      if (out) p.stdout_excerpt = excerpt(out[1]);
      p.is_error = typeof p.exit_code === "number" && p.exit_code !== 0;
      break;
    }
    case "file_edit":
    case "file_write": {
      const diff = /\[diff_block_start\]\n([\s\S]*?)\[diff_block_end\]/.exec(body);
      if (diff) p.unified_diff = excerpt(diff[1]);
      break;
    }
    case "file_read":
      break;
    default:
      p.output_excerpt = excerpt(body.trim());
  }
}

function userText(content: string): string {
  const m = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(content);
  return (m ? m[1]! : content).trim();
}

interface ParsedTranscript {
  drafts: Draft[];
  warnings: ParseWarning[];
  firstTs: string | null;
  lastTs: string | null;
  firstPrompt: string | null;
  cwd: string | null;
}

function parseTranscript(file: string, text: string): ParsedTranscript {
  const t: ParsedTranscript = { drafts: [], warnings: [], firstTs: null, lastTs: null, firstPrompt: null, cwd: null };
  const pending: Draft[] = [];
  const warn = (line: number, message: string) => t.warnings.push({ file, line, message });
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    if (!raw.trim()) return;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      warn(lineNo, "invalid JSON, line skipped");
      return;
    }
    if (!isObj(o)) {
      warn(lineNo, "line is not a JSON object, skipped");
      return;
    }
    const ts = str(o.created_at) && ISO_TS_RE.test(o.created_at as string) ? (o.created_at as string) : null;
    if (ts) {
      t.firstTs ??= ts;
      t.lastTs = ts;
    }
    const type = str(o.type);
    const content = str(o.content) ?? "";
    const push = (d: Draft) => t.drafts.push(d);

    if (type && IGNORED_STEPS.has(type)) return;
    if (type === "USER_INPUT") {
      const textIn = userText(content);
      t.firstPrompt ??= textIn || null;
      push({ ts, kind: "user_message", summary: oneLine(textIn) || "(empty prompt)", payload: { text: excerpt(textIn) }, raw: o });
      return;
    }
    if (type === "PLANNER_RESPONSE") {
      const thinking = str(o.thinking);
      if (thinking) push({ ts, kind: "thinking", summary: oneLine(thinking), payload: { text: excerpt(thinking) }, raw: o });
      if (content.trim()) push({ ts, kind: "assistant_message", summary: oneLine(content), payload: { text: excerpt(content) }, raw: o });
      const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      for (const c of calls) {
        if (!isObj(c)) continue;
        const d = toolDraft(str(c.name) ?? "(unnamed tool)", c.args, ts, o);
        if (d.kind === "shell_command" && typeof d.payload.cwd === "string") t.cwd ??= d.payload.cwd;
        push(d);
        pending.push(d);
      }
      return;
    }
    if (type === "ERROR_MESSAGE") {
      const message = str(o.error) ?? resultParts(content).body;
      push({ ts, kind: "error", summary: oneLine(`Error: ${message}`), payload: { message: excerpt(message) }, raw: o });
      return;
    }
    if (type && RESULT_STEPS.has(type)) {
      const d = pending.shift();
      if (d) applyResult(d, o);
      else push({ ts, kind: "tool_result", summary: oneLine(`Result: ${resultParts(content).body}`), payload: { step_type: type, output_excerpt: excerpt(content) }, raw: o });
      return;
    }
    const reason = `unknown step type ${JSON.stringify(type ?? null)}`;
    warn(lineNo, reason);
    push({ ts, kind: "unknown", summary: oneLine(`Unknown: ${reason}`), payload: { reason }, raw: o });
  });
  return t;
}

// ---------------------------------------------------------------------------------------------

interface Located {
  root: string;
  uuid: string;
  transcript: boolean;
}

function locate(file: string): Located | null {
  const norm = path.resolve(file);
  if (path.basename(norm) === "transcript.jsonl") {
    const brainDir = path.resolve(norm, "..", "..", "..");
    return { root: path.resolve(brainDir, "..", ".."), uuid: path.basename(brainDir), transcript: true };
  }
  if (norm.endsWith(".pb") && path.basename(path.dirname(norm)) === "conversations") {
    return { root: path.resolve(norm, "..", ".."), uuid: path.basename(norm, ".pb"), transcript: false };
  }
  return null;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface Artifact {
  name: string;
  type: string | null;
  summary: string | null;
  updated: string | null;
  text: string;
}

/** The agent's plan/task/walkthrough documents: `<name>.md` with a `<name>.md.metadata.json` beside it. */
async function readArtifacts(brainDir: string): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const name of (await listDir(brainDir)).sort()) {
    const m = /^(.+)\.metadata\.json$/.exec(name);
    if (!m) continue;
    let meta: Obj = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(brainDir, name), "utf8"));
      if (isObj(parsed)) meta = parsed;
    } catch {
      continue;
    }
    let text = "";
    try {
      text = await readFile(path.join(brainDir, m[1]!), "utf8");
    } catch {
      // metadata without its document: keep the summary
    }
    const updated = str(meta.updatedAt);
    out.push({
      name: m[1]!,
      type: str(meta.artifactType) ?? null,
      summary: str(meta.summary) ?? null,
      updated: updated && !Number.isNaN(Date.parse(updated)) ? new Date(Date.parse(updated)).toISOString() : null,
      text,
    });
  }
  return out.sort((a, b) => (a.updated ?? "").localeCompare(b.updated ?? "") || a.name.localeCompare(b.name));
}

async function antigravityFingerprint(file: string): Promise<string> {
  const loc = locate(file);
  const h = createHash("sha1");
  const files = [file];
  if (loc) {
    files.push(path.join(loc.root, SUMMARIES));
    const brainDir = path.join(loc.root, "brain", loc.uuid);
    if (!loc.transcript)
      for (const n of (await listDir(brainDir)).sort()) if (/\.(md|metadata\.json)$/.test(n)) files.push(path.join(brainDir, n));
  }
  for (const f of files) {
    try {
      const s = await stat(f);
      h.update(`${f}:${s.size}:${Math.trunc(s.mtimeMs)}\n`);
    } catch {
      h.update(`${f}:missing\n`);
    }
  }
  return h.digest("hex");
}

export const antigravityAdapter: SourceAdapter = {
  id: "antigravity",
  testedVersions: ["IDE data 2025-11 – 2026-09"],

  defaultRoot: defaultAntigravityRoot,

  async discover(root = defaultAntigravityRoot()): Promise<string[]> {
    const uuids = new Set<string>();
    for (const n of await listDir(path.join(root, "conversations"))) {
      const m = /^(.+)\.pb$/.exec(n);
      if (m && UUID_RE.test(m[1]!)) uuids.add(m[1]!);
    }
    for (const n of await listDir(path.join(root, "brain")))
      if (UUID_RE.test(n) && (await exists(path.join(root, "brain", n, TRANSCRIPT)))) uuids.add(n);
    const out: string[] = [];
    for (const uuid of [...uuids].sort()) {
      const transcript = path.join(root, "brain", uuid, TRANSCRIPT);
      out.push((await exists(transcript)) ? transcript : path.join(root, "conversations", `${uuid}.pb`));
    }
    return out;
  },

  fingerprint: antigravityFingerprint,

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const loc = locate(file);
    if (!loc) {
      yield { type: "warning", warning: { file, line: null, message: "not an Antigravity transcript or conversation file" } };
      return;
    }
    let summaries = new Map<string, AntigravitySummary>();
    try {
      summaries = await readAntigravitySummaries(loc.root);
    } catch (err) {
      yield { type: "warning", warning: { file: path.join(loc.root, SUMMARIES), line: null, message: `unreadable summaries: ${String(err)}` } };
    }
    const summary = summaries.get(loc.uuid);

    let drafts: Draft[] = [];
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    let firstPrompt: string | null = null;
    let cwd: string | null = null;
    if (loc.transcript) {
      const t = parseTranscript(file, await readFile(file, "utf8"));
      for (const w of t.warnings) yield { type: "warning", warning: w };
      ({ drafts, firstTs, lastTs, firstPrompt, cwd } = t);
    } else {
      // The transcript itself is encrypted; show the agent's documents so the session is not empty.
      for (const a of await readArtifacts(path.join(loc.root, "brain", loc.uuid))) {
        const label = a.summary ?? a.name;
        drafts.push({
          ts: a.updated,
          kind: "assistant_message",
          summary: oneLine(`${a.name}: ${label}`),
          payload: { text: excerpt(a.text), artifact: a.name, artifact_type: a.type ?? undefined, metadata_only: true },
          raw: { artifactType: a.type, summary: a.summary, updatedAt: a.updated },
        });
      }
    }

    const id = `antigravity:${loc.uuid}`;
    const events: NormalizedEvent[] = drafts.map((d, seq) => ({
      id: `${id}:${seq}`,
      session_id: id,
      seq,
      ts: d.ts,
      kind: d.kind,
      summary: d.summary,
      payload: JSON.parse(JSON.stringify(d.payload)) as Obj, // drop undefined fields
      raw: d.raw,
      tokens_in: null,
      tokens_out: null,
      cache_read: null,
      cache_write: null,
      usage_extra: null,
      model: null,
      risk_level: "none",
      risk_rules: [],
    }));
    for (const event of events) yield { type: "event", event };

    const times = [summary?.created, summary?.updated, firstTs, lastTs, ...drafts.map((d) => d.ts)]
      .filter((x): x is string => !!x)
      .sort();
    const session: Session = {
      id,
      source: "antigravity",
      project_path: summary?.workspace ?? cwd,
      git_branch: null,
      started_at: times[0] ?? null,
      ended_at: times.at(-1) ?? null,
      model: null,
      title: oneLine(summary?.title ?? firstPrompt ?? "(untitled)"),
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await antigravityFingerprint(file),
    };
    yield { type: "session", session };
  },
};
