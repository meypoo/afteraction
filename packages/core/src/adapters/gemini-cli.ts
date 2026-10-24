// Gemini CLI adapter. Format notes: docs/log-formats.md.
//
// Built from Gemini CLI 0.18.4's own ChatRecordingService (session JSON written to
// ~/.gemini/tmp/<sha256 of project root>/chats/session-<time>-<id8>.json). Not yet verified against
// real session files.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  excerpt,
  oneLine,
  type EventKind,
  type NormalizedEvent,
  type NormalizedRecord,
  type Session,
  type SourceAdapter,
} from "../model.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isoOrNull = (v: unknown): string | null => {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
};

export function defaultGeminiRoot(): string {
  return path.join(os.homedir(), ".gemini", "tmp");
}

/** Text of a PartListUnion: a string, a part, or an array of either. */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partsText).filter(Boolean).join("\n");
  if (isObj(content)) {
    if (typeof content.text === "string") return content.text;
    if (isObj(content.functionResponse)) {
      const r = content.functionResponse.response;
      if (isObj(r)) return str(r.output) ?? str(r.error) ?? JSON.stringify(r);
    }
  }
  return "";
}

/** `Command: …\nDirectory: …\nOutput: …\nError: …\nExit Code: …` from run_shell_command. */
function parseShellResult(text: string): { output?: string; error?: string; exit?: number | null; dir?: string } {
  const m = /^Command: [\s\S]*?\nDirectory: (.*)\nOutput: ([\s\S]*?)\nError: ([\s\S]*?)\nExit Code: (.*)$/m.exec(text);
  if (!m) return {};
  const exit = /^-?\d+$/.test(m[4]!.trim()) ? Number(m[4]!.trim()) : null;
  return {
    dir: m[1] === "(root)" ? undefined : m[1],
    output: m[2] === "(empty)" ? "" : m[2],
    error: m[3] === "(none)" ? undefined : m[3],
    exit,
  };
}

const lineCount = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

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

function toolDraft(call: Obj, model: string | null): Draft {
  const name = str(call.name) ?? "(unnamed tool)";
  const args = isObj(call.args) ? call.args : {};
  const status = str(call.status);
  const resultText = partsText(call.result);
  const display = str(call.resultDisplay);
  const ts = isoOrNull(call.timestamp);
  const base: Obj = { tool_use_id: str(call.id), status, is_error: status === "error" || status === "cancelled" };
  const draft = (kind: EventKind, summary: string, payload: Obj): Draft => ({
    ts, kind, summary, payload: { ...base, ...payload }, raw: call, model,
  });
  switch (name) {
    case "run_shell_command": {
      const command = str(args.command) ?? "";
      const r = parseShellResult(resultText);
      return draft("shell_command", `$ ${oneLine(command)}`, {
        command: excerpt(command),
        description: str(args.description),
        cwd: str(args.dir_path) ?? str(args.directory) ?? r.dir,
        exit_code: r.exit ?? null,
        stdout_excerpt: excerpt(r.output ?? (r.exit === undefined ? resultText : undefined)),
        stderr_excerpt: excerpt(r.error),
        is_error: base.is_error === true || (typeof r.exit === "number" && r.exit !== 0),
      });
    }
    case "read_file": {
      const p = str(args.file_path) ?? str(args.absolute_path) ?? "";
      return draft("file_read", `Read ${p}`, { path: p });
    }
    case "write_file": {
      const p = str(args.file_path) ?? "";
      const content = str(args.content) ?? "";
      return draft("file_write", `Write ${p}`, {
        path: p,
        content_excerpt: excerpt(content),
        bytes: Buffer.byteLength(content, "utf8"),
        lines_added: lineCount(content),
        lines_removed: 0,
      });
    }
    case "replace": {
      const p = str(args.file_path) ?? "";
      const oldText = str(args.old_string) ?? "";
      const newText = str(args.new_string) ?? "";
      return draft("file_edit", `Edit ${p}`, {
        path: p,
        old_excerpt: excerpt(oldText),
        new_excerpt: excerpt(newText),
        description: str(args.instruction),
        lines_added: lineCount(newText),
        lines_removed: lineCount(oldText),
      });
    }
    case "web_fetch": {
      const prompt = str(args.prompt) ?? "";
      const url = /https?:\/\/\S+/.exec(prompt)?.[0] ?? "";
      return draft("web_fetch", `Fetch ${url || oneLine(prompt)}`, { url, prompt: excerpt(prompt) });
    }
    default:
      return draft("tool_call", display ? `${name}: ${oneLine(display)}` : name, {
        tool_name: name,
        input: capStrings(args),
        output_excerpt: excerpt(resultText || display),
      });
  }
}

/** The project root is stored only as its sha256; recover it from directories the session used. */
function findProjectRoot(projectHash: string | undefined, candidates: string[]): string | null {
  if (!projectHash) return null;
  const seen = new Set<string>();
  for (const c of candidates) {
    let dir = c;
    for (let i = 0; i < 32 && dir && !seen.has(dir); i++) {
      seen.add(dir);
      if (createHash("sha256").update(dir).digest("hex") === projectHash) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
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

async function fingerprint(file: string): Promise<string> {
  const s = await stat(file);
  return createHash("sha1").update(`${path.basename(file)}:${s.size}:${Math.trunc(s.mtimeMs)}`).digest("hex");
}

export const geminiCliAdapter: SourceAdapter = {
  id: "gemini_cli",
  testedVersions: ["0.18.4 (format from source; not yet verified against real logs)"],

  defaultRoot: defaultGeminiRoot,

  async discover(root = defaultGeminiRoot()): Promise<string[]> {
    const out: string[] = [];
    for (const project of (await listDir(root)).sort()) {
      const chats = path.join(root, project, "chats");
      for (const name of (await listDir(chats)).sort())
        if (name.startsWith("session-") && name.endsWith(".json")) out.push(path.join(chats, name));
    }
    return out;
  },

  fingerprint,

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    let conv: unknown;
    try {
      conv = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      yield { type: "warning", warning: { file, line: null, message: `unreadable session file: ${String(err)}` } };
      return;
    }
    if (!isObj(conv) || !Array.isArray(conv.messages)) {
      yield { type: "warning", warning: { file, line: null, message: "not a Gemini CLI conversation record" } };
      return;
    }

    const drafts: Draft[] = [];
    const models = new Map<string, number>();
    const dirs: string[] = [];
    let firstPrompt: string | null = null;
    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };

    conv.messages.forEach((m: unknown) => {
      if (!isObj(m)) {
        drafts.push({ ts: null, kind: "unknown", summary: "Unknown: message is not an object", payload: { reason: "message is not an object" }, raw: m, model: null });
        return;
      }
      const ts = isoOrNull(m.timestamp);
      const text = partsText(m.content);
      const type = str(m.type);
      switch (type) {
        case "user":
          firstPrompt ??= text.trim() || null;
          drafts.push({ ts, kind: "user_message", summary: oneLine(text) || "(empty prompt)", payload: { text: excerpt(text) }, raw: m, model: null });
          return;
        case "info":
        case "warning":
          drafts.push({ ts, kind: "user_message", summary: oneLine(`${type}: ${text}`), payload: { text: excerpt(text), meta: true, level: type }, raw: m, model: null });
          return;
        case "error":
          drafts.push({ ts, kind: "error", summary: oneLine(`Error: ${text}`), payload: { message: excerpt(text) }, raw: m, model: null });
          return;
        case "gemini": {
          const model = str(m.model) ?? null;
          if (model) models.set(model, (models.get(model) ?? 0) + 1);
          const first = drafts.length;
          for (const th of Array.isArray(m.thoughts) ? m.thoughts : []) {
            if (!isObj(th)) continue;
            const t = [str(th.subject), str(th.description)].filter(Boolean).join(": ");
            drafts.push({ ts: isoOrNull(th.timestamp) ?? ts, kind: "thinking", summary: oneLine(t) || "(thinking)", payload: { text: excerpt(t) }, raw: th, model });
          }
          if (text.trim()) drafts.push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text) }, raw: m, model });
          for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
            if (!isObj(c)) continue;
            const d = toolDraft(c, model);
            d.ts ??= ts;
            const p = str(d.payload.cwd) ?? str(d.payload.path);
            if (p && path.isAbsolute(p)) dirs.push(d.kind === "shell_command" ? p : path.dirname(p));
            drafts.push(d);
          }
          const t = isObj(m.tokens) ? m.tokens : null;
          if (t) {
            // Gemini's prompt count includes cached tokens; thoughts are billed as output.
            const cached = num(t.cached);
            const tokens = { in: Math.max(0, num(t.input) - cached), out: num(t.output) + num(t.thoughts), cacheRead: cached, cacheWrite: 0 };
            totals.in += tokens.in;
            totals.out += tokens.out;
            totals.cacheRead += tokens.cacheRead;
            const target = drafts[first];
            if (target) target.tokens = tokens;
            else drafts.push({ ts, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: m, model, tokens });
          }
          return;
        }
        default: {
          const reason = `unknown message type ${JSON.stringify(type ?? null)}`;
          drafts.push({ ts, kind: "unknown", summary: oneLine(`Unknown: ${reason}`), payload: { reason }, raw: m, model: null });
        }
      }
    });

    for (const [i, d] of drafts.entries())
      if (d.kind === "unknown") yield { type: "warning", warning: { file, line: null, message: `message ${i}: ${String(d.payload.reason)}` } };

    const sessionId = str(conv.sessionId) ?? path.basename(file, ".json");
    const id = `gemini:${sessionId}`;
    for (const [seq, d] of drafts.entries()) {
      const tk = d.tokens;
      const event: NormalizedEvent = {
        id: `${id}:${seq}`,
        session_id: id,
        seq,
        ts: d.ts,
        kind: d.kind,
        summary: d.summary,
        payload: JSON.parse(JSON.stringify(d.payload)) as Obj,
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
    const times = drafts.map((d) => d.ts).filter((x): x is string => !!x).sort();
    const session: Session = {
      id,
      source: "gemini_cli",
      project_path: findProjectRoot(str(conv.projectHash), dirs),
      git_branch: null,
      started_at: isoOrNull(conv.startTime) ?? times[0] ?? null,
      ended_at: isoOrNull(conv.lastUpdated) ?? times.at(-1) ?? null,
      model,
      title: oneLine(firstPrompt ?? "(untitled)"),
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_write_tokens: 0,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await fingerprint(file),
    };
    yield { type: "session", session };
  },
};
