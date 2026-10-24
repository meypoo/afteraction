// GitHub Copilot Chat in VS Code (agent, edit and ask modes). Format notes: docs/log-formats.md.
//
// VS Code stores each chat under `User/workspaceStorage/<hash>/chatSessions/<id>.json` (older: one JSON
// object) or `.jsonl` (newer: a mutation log, replayed below). Chats opened without a folder go to
// `User/globalStorage/emptyWindowChatSessions/`. The replay rules and field names come from VS Code's own
// code (checked in the installed build); only an empty real session was available, so this is not yet
// verified against real chats. VS Code stores no token usage, so cost is unknown.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excerpt, oneLine, type NormalizedRecord, type Session, type SourceAdapter } from "../model.js";
import {
  capStrings, editDraft, isObj, listDir, mostCommonModel, readDraft, shellDraft, statFingerprint, str, timeRange,
  toEvents, toIso, tryJson, unknownDraft, writeDraft, type Draft, type Obj,
} from "./util.js";
import { fileUriToPath } from "./cursor.js";

/** VS Code's `User` folder. */
export function defaultVscodeRoot(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Code", "User");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Code", "User");
}

type Key = string | number;

/** Replays VS Code's chat session log: 0 = whole value, 1 = set at path, 2 = truncate+push array, 3 = delete. */
export function replayChatLog(text: string, onBadLine: (line: number, message: string) => void): unknown {
  let state: unknown;
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim()) return;
    const entry = tryJson(raw);
    if (!isObj(entry) || typeof entry.kind !== "number") return onBadLine(i + 1, "not a chat log entry, skipped");
    const k = Array.isArray(entry.k) ? (entry.k as Key[]) : [];
    // Keys come from the file: never let them reach Object.prototype (prototype pollution).
    if (k.some((key) => (typeof key !== "string" && typeof key !== "number") || UNSAFE_KEYS.has(String(key)))) {
      return onBadLine(i + 1, "unsafe or invalid key path, skipped");
    }
    try {
      if (entry.kind === 0) state = entry.v;
      else if (entry.kind === 1) {
        if (k.length === 0) state = entry.v;
        else (walk(state, k.slice(0, -1)) as Record<Key, unknown>)[k.at(-1)!] = entry.v;
      } else if (entry.kind === 2) {
        const parent = walk(state, k.slice(0, -1)) as Record<Key, unknown>;
        const arr = Array.isArray(parent[k.at(-1)!]) ? (parent[k.at(-1)!] as unknown[]) : [];
        // Truncate only: a huge index must not grow a giant sparse array.
        if (typeof entry.i === "number" && Number.isInteger(entry.i) && entry.i >= 0 && entry.i < arr.length) arr.length = entry.i;
        if (Array.isArray(entry.v)) arr.push(...(entry.v as unknown[]));
        parent[k.at(-1)!] = arr;
      } else if (entry.kind === 3) {
        delete (walk(state, k.slice(0, -1)) as Record<Key, unknown>)[k.at(-1)!];
      } else onBadLine(i + 1, `unknown entry kind ${entry.kind}`);
    } catch {
      onBadLine(i + 1, "entry does not fit the session, skipped");
    }
  });
  return state;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function walk(v: unknown, keys: Key[]): unknown {
  let cur = v;
  for (const key of keys) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) throw new Error("bad path");
    cur = (cur as Record<Key, unknown>)[key];
  }
  if (cur === null || typeof cur !== "object") throw new Error("bad path");
  return cur;
}

/** Markdown text of a string or `{value}` (IMarkdownString). */
const md = (v: unknown): string => (typeof v === "string" ? v : isObj(v) ? str(v.value) ?? "" : "");

function uriPath(v: unknown): string | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.fsPath === "string") return v.fsPath;
  if (v.scheme === "file" && typeof v.path === "string") return fileUriToPath(`file://${v.path}`);
  if (isObj(v.uri)) return uriPath(v.uri);
  return undefined;
}

/** First file referenced by a tool invocation: its result locations, or a file link in its message. */
function toolFile(t: Obj): string {
  if (Array.isArray(t.resultDetails)) for (const r of t.resultDetails) { const p = uriPath(r); if (p) return p; }
  const link = /\((file:\/\/\/[^)\s]+)\)/.exec(md(t.pastTenseMessage) + " " + md(t.invocationMessage));
  return link ? fileUriToPath(link[1]!) : "";
}

function toolDraft(t: Obj, ts: string | null, model: string | null): Draft {
  const toolId = str(t.toolId) ?? "(unnamed tool)";
  const base = { ts, model, raw: t };
  const tsd = isObj(t.toolSpecificData) ? t.toolSpecificData : {};
  const details = isObj(t.resultDetails) ? t.resultDetails : {};
  const message = md(t.pastTenseMessage) || md(t.invocationMessage);
  const common: Obj = { tool_use_id: str(t.toolCallId), tool_name: toolId };
  if (tsd.kind === "terminal") {
    const cl = isObj(tsd.commandLine) ? tsd.commandLine : {};
    const state = isObj(tsd.terminalCommandState) ? tsd.terminalCommandState : {};
    const out = isObj(tsd.terminalCommandOutput) ? str(tsd.terminalCommandOutput.text) : undefined;
    const exit = typeof state.exitCode === "number" ? state.exitCode : null;
    return shellDraft(base, str(cl.userEdited) ?? str(cl.toolEdited) ?? str(cl.original) ?? str(tsd.command) ?? "", {
      ...common,
      exit_code: exit,
      is_error: exit !== null && exit !== 0,
      duration_ms: typeof state.duration === "number" ? state.duration : undefined,
      stdout_excerpt: excerpt(out),
      description: str(tsd.intention),
    });
  }
  const input = tryJson(details.input);
  const args: Obj = isObj(input) ? input : {};
  if (/readFile/i.test(toolId)) return readDraft(base, str(args.filePath) ?? toolFile(t), common);
  if (/createFile/i.test(toolId)) return writeDraft(base, str(args.filePath) ?? toolFile(t), str(args.content) ?? "", common);
  if (/fetchWebPage/i.test(toolId)) {
    const urls = Array.isArray(args.urls) ? args.urls.filter((u): u is string => typeof u === "string") : [];
    const url = urls[0] ?? /https?:\/\/[^\s)]+/.exec(message)?.[0] ?? "";
    return { ...base, kind: "web_fetch", summary: `Fetch ${url}`, payload: { ...common, url } };
  }
  return {
    ...base, kind: "tool_call", summary: oneLine(message ? `${toolId}: ${message}` : toolId),
    payload: { ...common, input: capStrings(input ?? undefined), message: excerpt(message) },
  };
}

function responseDrafts(parts: unknown[], ts: string | null, model: string | null): Draft[] {
  const out: Draft[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) out.push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text) }, raw: { value: text }, model });
    text = "";
  };
  for (const p of parts) {
    if (!isObj(p)) continue;
    const kind = str(p.kind);
    if (!kind || kind === "markdownContent") { text += md(p.value ?? p.content); continue; }
    if (kind === "inlineReference") { const r = p.inlineReference; text += md(isObj(r) ? (r.name ?? uriPath(r) ?? "") : ""); continue; }
    flush();
    if (kind === "thinking") {
      const t = md(p.value);
      if (t.trim()) out.push({ ts, kind: "thinking", summary: oneLine(t), payload: { text: excerpt(t) }, raw: p, model });
    } else if (kind === "toolInvocationSerialized" || kind === "toolInvocation") {
      out.push(toolDraft(p, ts, model));
    } else if (kind === "textEditGroup") {
      const edits = Array.isArray(p.edits) ? p.edits.flat().filter(isObj) : [];
      const newText = edits.map((e) => str(e.text) ?? "").join("\n");
      out.push(editDraft({ ts, model, raw: p }, uriPath(p.uri) ?? "", "", newText, { edit_count: edits.length }));
    } else if (kind === "warning" || kind === "confirmation") {
      out.push({ ts, kind: "assistant_message", summary: oneLine(`${kind}: ${md(p.content ?? p.message ?? p.title)}`), payload: { text: excerpt(md(p.content ?? p.message)), meta: true }, raw: p, model });
    }
    // codeblockUri, undoStop, prepareToolInvocation, progress and MCP-start markers carry no action
  }
  flush();
  return out;
}

async function folderFor(file: string): Promise<string | null> {
  // <User>/workspaceStorage/<hash>/chatSessions/<id>.json → <hash>/workspace.json
  const wsJson = path.join(path.dirname(path.dirname(file)), "workspace.json");
  try {
    const ws = tryJson(await readFile(wsJson, "utf8"));
    const uri = isObj(ws) ? str(ws.folder) : undefined;
    return uri ? fileUriToPath(uri) : null;
  } catch {
    return null;
  }
}

export const copilotAdapter: SourceAdapter = {
  id: "copilot",
  testedVersions: ["VS Code 1.10x chatSessions v3 (format from source; not yet verified against real logs)"],

  defaultRoot: defaultVscodeRoot,

  async discover(root = defaultVscodeRoot()): Promise<string[]> {
    const dirs = (await listDir(path.join(root, "workspaceStorage"))).sort().map((h) => path.join(root, "workspaceStorage", h, "chatSessions"));
    dirs.push(path.join(root, "globalStorage", "emptyWindowChatSessions"));
    const out: string[] = [];
    for (const d of dirs) {
      const names = (await listDir(d)).sort();
      // VS Code migrates old .json sessions to .jsonl and may leave both; the .jsonl is current.
      for (const n of names) if (n.endsWith(".jsonl") || (n.endsWith(".json") && !names.includes(`${n}l`))) out.push(path.join(d, n));
    }
    return out;
  },

  fingerprint: (file) => statFingerprint([file, path.join(path.dirname(path.dirname(file)), "workspace.json")]),

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const text = await readFile(file, "utf8");
    const bad: { line: number; message: string }[] = [];
    const chat = file.endsWith(".jsonl") ? replayChatLog(text, (line, message) => bad.push({ line, message })) : tryJson(text);
    for (const b of bad) yield { type: "warning", warning: { file, ...b } };
    if (!isObj(chat) || !Array.isArray(chat.requests)) {
      yield { type: "warning", warning: { file, line: null, message: "not a VS Code chat session" } };
      return;
    }
    if (chat.requests.length === 0) return; // an opened but unused chat panel
    const drafts: Draft[] = [];
    for (const [i, r] of chat.requests.entries()) {
      if (!isObj(r)) {
        drafts.push(unknownDraft(null, `request ${i} is not an object`, r));
        yield { type: "warning", warning: { file, line: null, message: `request ${i} is not an object` } };
        continue;
      }
      const ts = toIso(r.timestamp);
      const model = str(r.modelId)?.replace(/^copilot\//, "") ?? null;
      const msg = isObj(r.message) ? str(r.message.text) ?? "" : str(r.message) ?? "";
      drafts.push({ ts, kind: "user_message", summary: oneLine(msg) || "(empty prompt)", payload: { text: excerpt(msg), agent: isObj(r.agent) ? str(r.agent.id) : undefined }, raw: { requestId: r.requestId, message: r.message, modelId: r.modelId }, model: null });
      drafts.push(...responseDrafts(Array.isArray(r.response) ? r.response : [], ts, model));
      const result = isObj(r.result) ? r.result : {};
      const err = isObj(result.errorDetails) ? str(result.errorDetails.message) : undefined;
      if (err) drafts.push({ ts, kind: "error", summary: oneLine(`Error: ${err}`), payload: { message: excerpt(err) }, raw: result.errorDetails, model });
      if (r.isCanceled === true) drafts.push({ ts, kind: "error", summary: "Request cancelled", payload: { message: "cancelled", cancelled: true }, raw: null, model });
    }

    const sessionId = str(chat.sessionId) ?? path.basename(file).replace(/\.jsonl?$/, "");
    const id = `copilot:${sessionId}`;
    for (const event of toEvents(id, drafts)) yield { type: "event", event };
    const [first, last] = timeRange(drafts);
    const prompt = drafts.find((d) => d.kind === "user_message")?.payload.text;
    const session: Session = {
      id,
      source: "copilot",
      project_path: await folderFor(file),
      git_branch: null,
      started_at: toIso(chat.creationDate) ?? first,
      ended_at: toIso(chat.lastMessageDate) ?? last,
      model: mostCommonModel(drafts),
      title: oneLine(str(chat.customTitle) || (typeof prompt === "string" ? prompt : "") || "(untitled)"),
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await copilotAdapter.fingerprint(file),
    };
    yield { type: "session", session };
  },
};
