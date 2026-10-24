// Continue adapter (VS Code / JetBrains extension and `cn` CLI). Format notes: docs/log-formats.md.
//
// Continue saves each chat as `~/.continue/sessions/<sessionId>.json` (a `Session`: title,
// workspaceDirectory, history of `{message, toolCallStates}`), with `sessions.json` listing
// `{sessionId, title, dateCreated, workspaceDirectory}`. Messages carry no timestamps; the session's
// creation time is used for all of them. Field and tool names come from Continue's source
// (core/index.d.ts, core/tools/builtIn.ts, 2026-10). Not yet verified against real logs.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excerpt, oneLine, type NormalizedRecord, type Session, type SourceAdapter } from "../model.js";
import {
  capStrings, editDraft, isObj, lineCount, listDir, num, readDraft, shellDraft, statFingerprint, str, sumTokens, toEvents,
  toIso, tryJson, unknownDraft, writeDraft, type Draft, type Obj,
} from "./util.js";
import { fileUriToPath } from "./cursor.js";

export function defaultContinueRoot(): string {
  return path.join(process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".continue"), "sessions");
}

/** MessageContent: a string or an array of `{type: "text", text}` / image parts. */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (isObj(p) && p.type === "text" ? str(p.text) ?? "" : isObj(p) ? `[${String(p.type)}]` : "")).filter(Boolean).join("\n");
  return "";
}

const pathOf = (v: unknown): string => {
  const s = str(v) ?? "";
  return s.startsWith("file://") ? fileUriToPath(s) : s;
};

function toolDraft(state: Obj, model: string | null, ts: string | null): Draft {
  const call = isObj(state.toolCall) ? state.toolCall : {};
  const fn = isObj(call.function) ? call.function : {};
  const name = str(fn.name) ?? "(unnamed tool)";
  const args: Obj = isObj(state.parsedArgs) ? state.parsedArgs : (isObj(tryJson(fn.arguments)) ? tryJson(fn.arguments) : {}) as Obj;
  const status = str(state.status);
  const output = Array.isArray(state.output) ? state.output.filter(isObj).map((o) => str(o.content) ?? "").join("\n") : "";
  const base = { ts, model, raw: state };
  const common: Obj = { tool_use_id: str(state.toolCallId) ?? str(call.id), status, is_error: status === "errored" || status === "canceled" };
  switch (name) {
    case "run_terminal_command":
      return shellDraft(base, str(args.command) ?? "", { ...common, exit_code: null, stdout_excerpt: excerpt(output || undefined), run_in_background: args.waitForCompletion === false ? true : undefined });
    case "read_file":
    case "read_file_range":
      return readDraft(base, pathOf(args.filepath), common);
    case "create_new_file":
      return writeDraft(base, pathOf(args.filepath), str(args.contents) ?? "", common);
    case "single_find_and_replace":
      return editDraft(base, pathOf(args.filepath), str(args.old_string) ?? "", str(args.new_string) ?? "", common);
    case "multi_edit": {
      const edits = Array.isArray(args.edits) ? args.edits.filter(isObj) : [];
      return editDraft(base, pathOf(args.filepath), edits.map((e) => str(e.old_string) ?? "").join("\n…\n"), edits.map((e) => str(e.new_string) ?? "").join("\n…\n"), {
        ...common,
        chunks: edits.length,
        lines_added: edits.reduce((n, e) => n + lineCount(str(e.new_string) ?? ""), 0),
        lines_removed: edits.reduce((n, e) => n + lineCount(str(e.old_string) ?? ""), 0),
      });
    }
    case "edit_existing_file":
      return editDraft(base, pathOf(args.filepath), "", str(args.changes) ?? "", common);
    case "fetch_url_content": {
      const url = str(args.url) ?? "";
      return { ...base, kind: "web_fetch", summary: `Fetch ${url}`, payload: { ...common, url } };
    }
    default:
      return { ...base, kind: "tool_call", summary: name, payload: { ...common, tool_name: name, input: capStrings(args), output_excerpt: excerpt(output || undefined) } };
  }
}

interface IndexEntry {
  dateCreated: string | null;
}

async function readIndex(dir: string): Promise<Map<string, IndexEntry>> {
  const out = new Map<string, IndexEntry>();
  try {
    const list = tryJson(await readFile(path.join(dir, "sessions.json"), "utf8"));
    if (Array.isArray(list))
      for (const e of list) if (isObj(e) && str(e.sessionId)) out.set(e.sessionId as string, { dateCreated: toIso(Number(e.dateCreated) || e.dateCreated) });
  } catch {
    // no index: times stay unknown
  }
  return out;
}

export const continueAdapter: SourceAdapter = {
  id: "continue",
  testedVersions: ["Continue source 2026-10 (not yet verified against real logs)"],

  defaultRoot: defaultContinueRoot,

  async discover(root = defaultContinueRoot()): Promise<string[]> {
    return (await listDir(root)).filter((n) => n.endsWith(".json") && n !== "sessions.json").sort().map((n) => path.join(root, n));
  },

  fingerprint: (file) => statFingerprint([file]),

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const s = tryJson(await readFile(file, "utf8"));
    if (!isObj(s) || !Array.isArray(s.history)) {
      yield { type: "warning", warning: { file, line: null, message: "not a Continue session" } };
      return;
    }
    if (s.history.length === 0) return;
    const sessionId = str(s.sessionId) ?? path.basename(file, ".json");
    const ts = (await readIndex(path.dirname(file))).get(sessionId)?.dateCreated ?? null;
    const model = str(s.chatModelTitle) ?? null;
    const drafts: Draft[] = [];
    for (const [i, item] of s.history.entries()) {
      const msg = isObj(item) && isObj(item.message) ? item.message : null;
      if (!msg) {
        yield { type: "warning", warning: { file, line: null, message: `history ${i}: no message` } };
        drafts.push(unknownDraft(ts, "history item without a message", item));
        continue;
      }
      const role = str(msg.role);
      const text = contentText(msg.content);
      const it = item as Obj;
      if (role === "user") drafts.push({ ts, kind: "user_message", summary: oneLine(text) || "(empty prompt)", payload: { text: excerpt(text) }, raw: msg, model: null });
      else if (role === "thinking") drafts.push({ ts, kind: "thinking", summary: oneLine(text) || "(thinking; text not recorded)", payload: { text: excerpt(text), redacted: !text } , raw: msg, model });
      else if (role === "assistant") {
        const first = drafts.length;
        const reasoning = isObj(it.reasoning) ? str(it.reasoning.text) : undefined;
        if (reasoning) drafts.push({ ts, kind: "thinking", summary: oneLine(reasoning), payload: { text: excerpt(reasoning) }, raw: it.reasoning, model });
        if (text.trim()) drafts.push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text) }, raw: msg, model });
        for (const st of Array.isArray(it.toolCallStates) ? it.toolCallStates : []) if (isObj(st)) drafts.push(toolDraft(st, model, ts));
        const u = isObj(msg.usage) ? msg.usage : null;
        if (u) {
          const pd = isObj(u.promptTokensDetails) ? u.promptTokensDetails : {};
          const cd = isObj(u.completionTokensDetails) ? u.completionTokensDetails : {};
          const cacheRead = num(pd.cachedTokens) + num(pd.cacheReadTokens);
          const cacheWrite = num(pd.cacheWriteTokens);
          const tokens = { in: Math.max(0, num(u.promptTokens) - cacheRead - cacheWrite), out: num(u.completionTokens) + num(cd.reasoningTokens), cacheRead, cacheWrite };
          if (drafts[first]) drafts[first]!.tokens = tokens;
          else drafts.push({ ts, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: msg, model, tokens });
        }
      } else if (role === "tool") {
        const prev = [...drafts].reverse().find((d) => d.payload.tool_use_id === str(msg.toolCallId));
        if (prev && prev.kind !== "file_read" && prev.payload.stdout_excerpt === undefined && prev.payload.output_excerpt === undefined) {
          prev.payload[prev.kind === "shell_command" ? "stdout_excerpt" : "output_excerpt"] = excerpt(text);
        }
      } else if (role === "system") {
        // the system prompt is not an action
      } else {
        const reason = `unknown role ${JSON.stringify(role ?? null)}`;
        yield { type: "warning", warning: { file, line: null, message: `history ${i}: ${reason}` } };
        drafts.push(unknownDraft(ts, reason, msg));
      }
    }
    const id = `continue:${sessionId}`;
    for (const event of toEvents(id, drafts)) yield { type: "event", event };
    const totals = sumTokens(drafts);
    const prompt = drafts.find((d) => d.kind === "user_message")?.payload.text;
    const ws = str(s.workspaceDirectory);
    const session: Session = {
      id,
      source: "continue",
      project_path: ws ? pathOf(ws) : null,
      git_branch: null,
      started_at: ts,
      ended_at: ts,
      model,
      title: oneLine(str(s.title) && s.title !== "New Session" ? (s.title as string) : (typeof prompt === "string" && prompt) || "(untitled)"),
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_write_tokens: totals.cacheWrite,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await statFingerprint([file]),
    };
    yield { type: "session", session };
  },
};
