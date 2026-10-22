// Claude Code adapter. Format notes: docs/log-formats.md.
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
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

/** Lines that carry session bookkeeping, not actions. Known, so no warning. */
const METADATA_TYPES = new Set([
  "custom-title", "ai-title", "agent-name", "last-prompt", "mode", "permission-mode", "atis-latch",
  "bridge-session", "cost-state", "pr-link", "frame-link", "file-history-snapshot", "file-history-delta",
  "queue-operation", "api-request", "api-request-blob", "api-request-shape", "artifact-comment-monitor",
  "artifact-autoreact-ledger", "summary",
]);

/** System subtypes that are timing/hook/recap notes rather than events. */
const IGNORED_SYSTEM_SUBTYPES = new Set([
  "turn_duration", "stop_hook_summary", "away_summary", "informational", "local_command", "compact_boundary",
]);

/** Wrappers the CLI injects as user "prompts". They are not typed by the person. */
const WRAPPER_RE =
  /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)>/;

const ISO_TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function defaultClaudeRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir ? path.join(configDir, "projects") : path.join(os.homedir(), ".claude", "projects");
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

interface MessageUsage {
  usage: Obj | undefined;
  model: string | null;
  first: Draft;
}

interface Transcript {
  file: string;
  drafts: Draft[];
  warnings: ParseWarning[];
  messages: Map<string, MessageUsage>;
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  customTitle: string | null;
  aiTitle: string | null;
}

/** Recursively cap long strings so payload inputs stay small; full data is kept in `raw`. */
function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return excerpt(v);
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, depth + 1)]));
  return v;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!isObj(b)) return "";
      if (b.type === "text") return str(b.text) ?? "";
      return `[${String(b.type)}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function unifiedDiff(patch: unknown): string | undefined {
  if (!Array.isArray(patch) || patch.length === 0) return undefined;
  const out: string[] = [];
  for (const h of patch) {
    if (!isObj(h)) continue;
    out.push(`@@ -${num(h.oldStart)},${num(h.oldLines)} +${num(h.newStart)},${num(h.newLines)} @@`);
    if (Array.isArray(h.lines)) for (const l of h.lines) if (typeof l === "string") out.push(l);
  }
  return out.length ? excerpt(out.join("\n") + "\n") : undefined;
}

function toolUseDraft(block: Obj, line: Obj, ts: string | null, model: string | null): Draft {
  const name = str(block.name) ?? "(unnamed tool)";
  const input = isObj(block.input) ? block.input : {};
  const base = { tool_use_id: str(block.id) };
  const draft = (kind: EventKind, summary: string, payload: Obj): Draft => ({
    ts, kind, summary, payload: { ...base, ...payload }, raw: line, model,
  });
  switch (name) {
    case "Bash":
    case "PowerShell": {
      const command = str(input.command) ?? "";
      return draft("shell_command", `$ ${oneLine(command)}`, {
        command: excerpt(command),
        shell: name === "Bash" ? "bash" : "powershell",
        description: str(input.description),
        cwd: str(line.cwd),
        run_in_background: input.run_in_background === true ? true : undefined,
      });
    }
    case "Read": {
      const p = str(input.file_path) ?? "";
      return draft("file_read", `Read ${p}`, { path: p });
    }
    case "Write": {
      const p = str(input.file_path) ?? "";
      const content = str(input.content) ?? "";
      return draft("file_write", `Write ${p}`, {
        path: p,
        content_excerpt: excerpt(content),
        bytes: Buffer.byteLength(content, "utf8"),
      });
    }
    case "Edit": {
      const p = str(input.file_path) ?? "";
      return draft("file_edit", `Edit ${p}`, {
        path: p,
        old_excerpt: excerpt(input.old_string),
        new_excerpt: excerpt(input.new_string),
        replace_all: input.replace_all === true ? true : undefined,
      });
    }
    case "WebFetch": {
      const url = str(input.url) ?? "";
      return draft("web_fetch", `Fetch ${url}`, { url });
    }
    case "Agent":
    case "Task": {
      const description = str(input.description) ?? "";
      return draft("subagent_start", `Subagent: ${oneLine(description)}`, {
        description,
        subagent_type: str(input.subagent_type),
        prompt_excerpt: excerpt(input.prompt),
        run_in_background: input.run_in_background === true ? true : undefined,
      });
    }
    default:
      return draft("tool_call", name, { tool_name: name, input: capStrings(input) });
  }
}

function applyResult(d: Draft, block: Obj, line: Obj, ts: string | null): void {
  const isError = block.is_error === true;
  const tur = line.toolUseResult;
  const text = contentText(block.content);
  const p = d.payload;
  p.is_error = isError;
  if (isError) p.error = excerpt(typeof tur === "string" ? tur : text);
  if (d.ts && ts) {
    const ms = Date.parse(ts) - Date.parse(d.ts);
    if (Number.isFinite(ms) && ms >= 0) p.duration_ms = ms;
  }
  switch (d.kind) {
    case "shell_command": {
      if (isObj(tur)) {
        p.stdout_excerpt = excerpt(tur.stdout);
        p.stderr_excerpt = excerpt(tur.stderr);
        if (tur.interrupted === true) p.interrupted = true;
      } else if (!isError) {
        p.stdout_excerpt = excerpt(text);
      }
      // Claude Code only records an exit code on failure, inside the error string.
      const m = isError ? /^Error: Exit code (\d+)/.exec(String(p.error ?? "")) : null;
      p.exit_code = m ? Number(m[1]) : null;
      break;
    }
    case "file_read":
      if (isObj(tur) && tur.type === "image") p.image = true;
      break;
    case "file_write":
      if (isObj(tur)) {
        if (typeof tur.type === "string") p.operation = tur.type;
        p.unified_diff = unifiedDiff(tur.structuredPatch);
      }
      break;
    case "file_edit":
      if (isObj(tur)) p.unified_diff = unifiedDiff(tur.structuredPatch);
      break;
    case "subagent_start":
      if (isObj(tur)) {
        p.agent_id = str(tur.agentId);
        p.status = str(tur.status);
      }
      break;
    default:
      if (!isError) p.result_excerpt = excerpt(text);
  }
  d.raw = { tool_use: d.raw, tool_result: line };
}

async function parseTranscript(file: string, subagentId: string | null): Promise<Transcript> {
  const t: Transcript = {
    file, drafts: [], warnings: [], messages: new Map(), sessionId: null, cwd: null, gitBranch: null,
    firstTs: null, lastTs: null, title: null, customTitle: null, aiTitle: null,
  };
  const pending = new Map<string, Draft>();
  let lastTs: string | null = null;
  let lineNo = 0;

  const warn = (message: string) => t.warnings.push({ file, line: lineNo, message });
  const push = (d: Draft) => {
    if (subagentId) d.payload.subagent_id = subagentId;
    t.drafts.push(d);
    return d;
  };
  const unknown = (raw: unknown, reason: string) => {
    warn(reason);
    push({ ts: lastTs, kind: "unknown", summary: oneLine(`Unknown: ${reason}`), payload: { reason }, raw, model: null });
  };

  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    lineNo++;
    const lineText = rawLine.replace(/^\uFEFF/, "").trim();
    if (!lineText) continue;
    let o: unknown;
    try {
      o = JSON.parse(lineText);
    } catch {
      warn("invalid JSON");
      continue;
    }
    if (!isObj(o)) {
      warn("line is not a JSON object");
      continue;
    }
    const type = o.type;

    if (METADATA_TYPES.has(String(type))) {
      if (type === "custom-title") t.customTitle = str(o.customTitle) ?? t.customTitle;
      if (type === "ai-title") t.aiTitle = str(o.aiTitle) ?? t.aiTitle;
      continue;
    }

    if ("timestamp" in o) {
      const ts = o.timestamp;
      if (typeof ts === "string" && ISO_TS_RE.test(ts) && Number.isFinite(Date.parse(ts))) {
        lastTs = ts;
        if (!t.firstTs || ts < t.firstTs) t.firstTs = ts;
        if (!t.lastTs || ts > t.lastTs) t.lastTs = ts;
      } else {
        warn(`invalid timestamp ${JSON.stringify(ts)}; using previous`);
      }
    }
    if (!t.sessionId && typeof o.sessionId === "string") t.sessionId = o.sessionId;
    if (!t.cwd && typeof o.cwd === "string" && o.cwd) t.cwd = o.cwd;
    if (!t.gitBranch && typeof o.gitBranch === "string" && o.gitBranch) t.gitBranch = o.gitBranch;
    const ts = lastTs;

    if (type === "attachment") continue; // context injected into the model, not an action

    if (type === "system") {
      const subtype = String(o.subtype);
      if (subtype === "api_error") {
        const err = typeof o.error === "string" ? o.error : JSON.stringify(o.error ?? null);
        push({
          ts, kind: "error", model: null, raw: o,
          summary: `API error (retry ${num(o.retryAttempt)}/${num(o.maxRetries)})`,
          payload: { source: "api", message: excerpt(err), retry_attempt: o.retryAttempt, max_retries: o.maxRetries },
        });
      } else if (!IGNORED_SYSTEM_SUBTYPES.has(subtype)) {
        unknown(o, `unknown system subtype "${subtype}"`);
      }
      continue;
    }

    if (type === "assistant") {
      const m = o.message;
      if (!isObj(m) || !Array.isArray(m.content)) {
        unknown(o, "assistant line without message content");
        continue;
      }
      const model = str(m.model) ?? null;
      const msgId = str(m.id) ?? `${file}:${lineNo}`;
      const apiError = o.isApiErrorMessage === true || model === "<synthetic>";
      let first = t.messages.get(msgId)?.first;
      for (const block of m.content) {
        if (!isObj(block)) {
          unknown(o, "assistant content block is not an object");
          continue;
        }
        let d: Draft | undefined;
        if (apiError && block.type === "text") {
          const text = str(block.text) ?? "";
          d = push({ ts, kind: "error", summary: oneLine(`API error: ${text}`), payload: { source: "api", message: excerpt(text) }, raw: o, model });
        } else if (block.type === "text") {
          const text = str(block.text) ?? "";
          d = push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text) }, raw: o, model });
        } else if (block.type === "thinking") {
          const text = str(block.thinking) ?? "";
          d = push({
            ts, kind: "thinking", raw: o, model,
            summary: text ? oneLine(text) : "(thinking; text not recorded)",
            payload: { text: excerpt(text), redacted: text === "" },
          });
        } else if (block.type === "tool_use") {
          d = push(toolUseDraft(block, o, ts, model));
          const id = str(block.id);
          if (id) pending.set(id, d);
        } else {
          unknown(o, `unknown assistant content block "${String(block.type)}"`);
          d = t.drafts[t.drafts.length - 1];
        }
        if (!first && d) first = d;
      }
      if (first) t.messages.set(msgId, { usage: isObj(m.usage) ? m.usage : undefined, model, first });
      continue;
    }

    if (type === "user") {
      const m = o.message;
      if (!isObj(m)) {
        unknown(o, "user line without message");
        continue;
      }
      const meta = o.isMeta === true || o.isCompactSummary === true;
      const c = m.content;
      const userMessage = (text: string, images: number, isMeta: boolean) => {
        const payload: Obj = { text: excerpt(text) };
        if (images) payload.images = images;
        if (isMeta) payload.meta = true;
        if (o.isCompactSummary === true) payload.compact_summary = true;
        push({ ts, kind: "user_message", summary: text ? oneLine(text) : "(image)", payload, raw: o, model: null });
        if (!isMeta && !subagentId && t.title === null && text) t.title = oneLine(text);
      };
      if (typeof c === "string") {
        userMessage(c, 0, meta || WRAPPER_RE.test(c));
      } else if (Array.isArray(c)) {
        const texts: string[] = [];
        let images = 0;
        for (const block of c) {
          if (!isObj(block)) continue;
          if (block.type === "tool_result") {
            const id = str(block.tool_use_id) ?? "";
            const call = pending.get(id);
            if (call) {
              applyResult(call, block, o, ts);
              pending.delete(id);
            } else {
              const text = contentText(block.content);
              push({
                ts, kind: "tool_result", summary: oneLine(`Result: ${text}`), raw: o, model: null,
                payload: { tool_use_id: id, is_error: block.is_error === true, content_excerpt: excerpt(text) },
              });
            }
          } else if (block.type === "text") {
            texts.push(str(block.text) ?? "");
          } else if (block.type === "image") {
            images++;
          } else {
            unknown(o, `unknown user content block "${String(block.type)}"`);
          }
        }
        if (texts.length || images) {
          const text = texts.join("\n");
          userMessage(text, images, meta || WRAPPER_RE.test(text));
        }
      } else {
        unknown(o, "user message content is neither text nor blocks");
      }
      continue;
    }

    unknown(o, `unknown line type ${JSON.stringify(type ?? null)}`);
  }

  // Usage repeats on every line of a split message; count it once, from the last line.
  for (const { usage, first } of t.messages.values()) {
    if (!usage) continue;
    first.tokens = {
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
  }
  return t;
}

interface SubagentFile {
  agentId: string;
  file: string;
  meta: Obj;
}

async function subagentFiles(sessionFile: string): Promise<SubagentFile[]> {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ""), "subagents");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentFile[] = [];
  for (const name of names.sort()) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    let meta: Obj = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, `agent-${m[1]}.meta.json`), "utf8"));
      if (isObj(parsed)) meta = parsed;
    } catch {
      // meta.json is optional; without it the transcript is appended at the end
    }
    out.push({ agentId: m[1]!, file: path.join(dir, name), meta });
  }
  return out;
}

/** Cheap change detector: sizes and mtimes of the session file and its subagent files. */
export async function claudeFingerprint(sessionFile: string): Promise<string> {
  const files = [sessionFile, ...(await subagentFiles(sessionFile)).map((s) => s.file)];
  const h = createHash("sha1");
  for (const f of files) {
    const s = await stat(f);
    h.update(`${path.basename(f)}:${s.size}:${Math.trunc(s.mtimeMs)}\n`);
  }
  return h.digest("hex");
}

function mostCommonModel(transcripts: Transcript[]): string | null {
  const counts = new Map<string, number>();
  for (const t of transcripts)
    for (const { model } of t.messages.values())
      if (model && model !== "<synthetic>") counts.set(model, (counts.get(model) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [m, n] of counts) if (n > bestN) [best, bestN] = [m, n];
  return best;
}

export const claudeCodeAdapter: SourceAdapter = {
  id: "claude_code",
  testedVersions: ["2.1.229", "2.1.304"],

  async discover(root = defaultClaudeRoot()) {
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const d of dirs.sort()) {
      let entries;
      try {
        entries = await readdir(path.join(root, d), { withFileTypes: true });
      } catch {
        continue; // not a directory
      }
      for (const e of entries) if (e.isFile() && e.name.endsWith(".jsonl")) files.push(path.join(root, d, e.name));
    }
    return files.sort();
  },

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const main = await parseTranscript(file, null);
    const subs = await subagentFiles(file);
    const subTranscripts: Transcript[] = [];

    // Nest each subagent's events right after the Agent call that started it.
    const drafts = [...main.drafts];
    for (const sub of subs) {
      const st = await parseTranscript(sub.file, sub.agentId);
      subTranscripts.push(st);
      const description = str(sub.meta.description) ?? "";
      const end: Draft = {
        ts: st.lastTs, kind: "subagent_end", summary: oneLine(`Subagent finished: ${description}`), model: null,
        raw: sub.meta,
        payload: { agent_id: sub.agentId, subagent_id: sub.agentId, agent_type: str(sub.meta.agentType), description },
      };
      const toolUseId = str(sub.meta.toolUseId);
      const at = drafts.findIndex(
        (d) => d.kind === "subagent_start" && (d.payload.tool_use_id === toolUseId || d.payload.agent_id === sub.agentId),
      );
      if (at >= 0) {
        const start = drafts[at]!;
        start.payload.agent_id ??= sub.agentId;
        drafts.splice(at + 1, 0, ...st.drafts, end);
      } else {
        drafts.push(...st.drafts, end);
      }
    }

    const all = [main, ...subTranscripts];
    for (const t of all) for (const w of t.warnings) yield { type: "warning", warning: w };

    const sessionId = main.sessionId ?? path.basename(file, ".jsonl");
    const id = `claude:${sessionId}`;
    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    let seq = 0;
    for (const d of drafts) {
      const tk = d.tokens;
      if (tk) {
        totals.in += tk.in;
        totals.out += tk.out;
        totals.cacheRead += tk.cacheRead;
        totals.cacheWrite += tk.cacheWrite;
      }
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
        model: d.model,
        risk_level: "none",
        risk_rules: [],
      };
      seq++;
      yield { type: "event", event };
    }

    const firstTs = all.map((t) => t.firstTs).filter((x): x is string => !!x).sort()[0] ?? null;
    const lastTs = all.map((t) => t.lastTs).filter((x): x is string => !!x).sort().at(-1) ?? null;
    const session: Session = {
      id,
      source: "claude_code",
      project_path: main.cwd,
      git_branch: main.gitBranch,
      started_at: firstTs,
      ended_at: lastTs,
      model: mostCommonModel(all),
      title: main.title ?? main.customTitle ?? main.aiTitle ?? "(untitled)",
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_write_tokens: totals.cacheWrite,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await claudeFingerprint(file),
    };
    yield { type: "session", session };
  },
};
