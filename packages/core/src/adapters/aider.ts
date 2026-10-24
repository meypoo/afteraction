// Aider adapter. Format notes: docs/log-formats.md.
//
// Aider appends every run to `.aider.chat.history.md` in the repository it was started in. Each run
// starts with `# aider chat started at <local time>`; prompts are `#### ` lines, Aider's own messages
// are `> ` blockquotes and the model's replies are plain Markdown. One file holds many runs, so
// discover() returns `<file>#<run number>`. Format from Aider's source (aider/io.py,
// aider/coders/base_coder.py). Not yet verified against real logs.
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excerpt, oneLine, type NormalizedRecord, type Session, type SourceAdapter } from "../model.js";
import { mostCommonModel, shellDraft, statFingerprint, sumTokens, toEvents, type Draft } from "./util.js";

export const AIDER_HISTORY = ".aider.chat.history.md";
const START_RE = /^# aider chat started at (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*$/;
/** Folders never searched for history files. */
const SKIP_DIRS = new Set(["node_modules", ".git", "AppData", "Library", ".cache", ".npm", ".pnpm-store", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next"]);
const MAX_DEPTH = 3;
const MAX_DIRS = 8000;

export function defaultAiderRoot(): string {
  return os.homedir();
}

/** Bounded search for history files under root. */
async function findHistories(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: [string, number][] = [[root, 0]];
  let seen = 0;
  while (queue.length && seen < MAX_DIRS) {
    const [dir, depth] = queue.shift()!;
    seen++;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === AIDER_HISTORY) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
        queue.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return out.sort();
}

interface Run {
  start: string;
  lines: string[];
}

/** Splits a history file into runs. Text before the first header (if any) is ignored. */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = START_RE.exec(line);
    if (m) runs.push({ start: m[1]!, lines: [] });
    else runs.at(-1)?.lines.push(line);
  }
  return runs;
}

const hasPrompt = (r: Run) => r.lines.some((l) => l.startsWith("#### "));

/** "2.3k" → 2300, "1.2M" → 1200000. */
function tokenCount(s: string): number {
  const m = /^([\d.]+)([kM]?)$/.exec(s.trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "M" ? 1e6 : 1));
}

/** Aider writes local time without a zone. */
function localIso(s: string): string | null {
  const d = new Date(s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseRun(run: Run, repoRoot: string): { drafts: Draft[]; model: string | null } {
  const ts = localIso(run.start);
  const drafts: Draft[] = [];
  let model: string | null = null;
  let prompt: string[] = [];
  let reply: string[] = [];
  const flushPrompt = () => {
    if (!prompt.length) return;
    const text = prompt.join("\n");
    prompt = [];
    const cmd = /^\/run (.+)$|^!(.+)$/.exec(text);
    if (cmd) drafts.push(shellDraft({ ts, model: null, raw: { prompt: text } }, cmd[1] ?? cmd[2]!, { cwd: repoRoot, user_initiated: true }));
    else drafts.push({ ts, kind: "user_message", summary: oneLine(text) || "(empty prompt)", payload: { text: excerpt(text), command: text.startsWith("/") ? true : undefined }, raw: { prompt: text }, model: null });
  };
  const flushReply = () => {
    const text = reply.join("\n").trim();
    reply = [];
    if (text) drafts.push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text) }, raw: { reply: text }, model });
  };
  for (const raw of run.lines) {
    const line = raw.replace(/ {2}$/, ""); // Markdown line break Aider adds
    if (line.startsWith("#### ")) {
      flushReply();
      prompt.push(line.slice(5) === "<blank>" ? "" : line.slice(5));
      continue;
    }
    flushPrompt();
    if (line.startsWith("> ") || line === ">") {
      flushReply();
      const msg = line.slice(2).trim();
      let m: RegExpExecArray | null;
      if ((m = /^(?:Main model|Model): (\S+)/.exec(msg))) model = m[1]!.replace(/^[a-z-]+\//, "");
      else if ((m = /^Tokens: ([\d.]+[kM]?) sent(?:, ([\d.]+[kM]?) cache write)?(?:, ([\d.]+[kM]?) cache hit)?, ([\d.]+[kM]?) received\./.exec(msg))) {
        const cacheWrite = m[2] ? tokenCount(m[2]) : 0;
        const cacheRead = m[3] ? tokenCount(m[3]) : 0;
        const tokens = { in: Math.max(0, tokenCount(m[1]!) - cacheWrite - cacheRead), out: tokenCount(m[4]!), cacheRead, cacheWrite };
        const target = [...drafts].reverse().find((d) => d.kind === "assistant_message" && !d.tokens);
        if (target) target.tokens = tokens;
        else drafts.push({ ts, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: { usage: msg }, model, tokens });
      } else if ((m = /^Applied edit to (.+)$/.exec(msg))) {
        const p = path.resolve(repoRoot, m[1]!);
        drafts.push({ ts, kind: "file_edit", summary: `Edit ${p}`, payload: { path: p }, raw: { tool: msg }, model });
      } else if ((m = /^Running (.+)$/.exec(msg))) {
        drafts.push(shellDraft({ ts, model, raw: { tool: msg } }, m[1]!, { cwd: repoRoot }));
      } else if ((m = /^Commit ([0-9a-f]{7,40}) (.*)$/.exec(msg))) {
        drafts.push({ ts, kind: "tool_call", summary: oneLine(`git commit ${m[1]}: ${m[2]}`), payload: { tool_name: "git_commit", input: { hash: m[1], message: m[2] } }, raw: { tool: msg }, model });
      }
      // other notices (repo map, warnings, prompts to add files) carry no action
      continue;
    }
    reply.push(raw);
  }
  flushPrompt();
  flushReply();
  return { drafts, model };
}

function splitVirtual(file: string): { file: string; run: number } | null {
  const m = /^(.*)#(\d+)$/.exec(file);
  return m ? { file: m[1]!, run: Number(m[2]) } : null;
}

export const aiderAdapter: SourceAdapter = {
  id: "aider",
  testedVersions: ["Aider source 2026-10 (not yet verified against real logs)"],

  defaultRoot: defaultAiderRoot,

  async discover(root = defaultAiderRoot()): Promise<string[]> {
    const out: string[] = [];
    for (const f of await findHistories(root)) {
      let text: string;
      try {
        text = await readFile(f, "utf8");
      } catch {
        continue;
      }
      splitRuns(text).forEach((r, i) => {
        if (hasPrompt(r)) out.push(`${f}#${i}`);
      });
    }
    return out;
  },

  async fingerprint(file: string): Promise<string> {
    const v = splitVirtual(file);
    return statFingerprint([v ? v.file : file]);
  },

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const v = splitVirtual(file);
    if (!v) {
      yield { type: "warning", warning: { file, line: null, message: "not an Aider run path (<history file>#<run>)" } };
      return;
    }
    const run = splitRuns(await readFile(v.file, "utf8"))[v.run];
    if (!run) {
      yield { type: "warning", warning: { file, line: null, message: "run not found in history file" } };
      return;
    }
    const repoRoot = path.dirname(v.file);
    const { drafts } = parseRun(run, repoRoot);
    const id = `aider:${createId(v.file, run.start, v.run)}`;
    for (const event of toEvents(id, drafts)) yield { type: "event", event };
    const totals = sumTokens(drafts);
    const prompt = drafts.find((d) => d.kind === "user_message")?.payload.text;
    const start = localIso(run.start);
    const session: Session = {
      id,
      source: "aider",
      project_path: repoRoot,
      git_branch: null,
      started_at: start,
      ended_at: start,
      model: mostCommonModel(drafts),
      title: oneLine((typeof prompt === "string" && prompt) || "(untitled)"),
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_write_tokens: totals.cacheWrite,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await aiderAdapter.fingerprint(file),
    };
    yield { type: "session", session };
  },
};

/** Stable id from the file and run: start time plus a short hash of the folder. */
function createId(file: string, start: string, n: number): string {
  let h = 0;
  for (const c of path.dirname(file)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${h.toString(16).padStart(8, "0")}-${start.replace(/\D/g, "")}-${n}`;
}
