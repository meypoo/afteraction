// Cline adapter, also reading its forks Roo Code and Kilo Code. Format notes: docs/log-formats.md.
//
// Each task is a folder `<extension global storage>/tasks/<taskId>/` with `ui_messages.json` (what
// the chat panel shows: prompts, replies, commands, tool use, per-request token usage),
// `api_conversation_history.json` and `task_metadata.json`. Field names come from Cline's source
// (apps/vscode/src/shared/ExtensionMessage.ts, 2026-10). Not yet verified against real logs.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excerpt, oneLine, type NormalizedRecord, type Session, type SourceAdapter } from "../model.js";
import {
  capStrings, editDraft, isObj, lineCount, listDir, mostCommonModel, num, readDraft, statFingerprint, str, sumTokens,
  timeRange, toEvents, toIso, tryJson, unknownDraft, writeDraft, type Draft, type Obj,
} from "./util.js";

/** Extension ids: Cline, Roo Code, Kilo Code. */
const EXTENSIONS = ["saoudrizwan.claude-dev", "rooveterinaryinc.roo-cline", "kilocode.kilo-code"];
/** Editors whose `User/globalStorage` may hold one of the extensions. */
const EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf", "Antigravity"];

function editorUserDir(editor: string): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), editor, "User");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", editor, "User");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), editor, "User");
}

/** Every folder that may contain `tasks/`. A `--source cline=<dir>` root is searched the same way. */
function taskRoots(root?: string): string[] {
  if (root && path.resolve(root) !== path.resolve(defaultClineRoot())) return [root];
  const out = [path.join(os.homedir(), ".cline", "data")];
  for (const e of EDITORS) for (const x of EXTENSIONS) out.push(path.join(editorUserDir(e), "globalStorage", x));
  return out;
}

export function defaultClineRoot(): string {
  return path.join(editorUserDir("Code"), "globalStorage", EXTENSIONS[0]!);
}

/** `say`/`ask` values that carry no action. Known, so no warning. */
const IGNORED = new Set([
  "api_req_finished", "api_req_retried", "deleted_api_reqs", "checkpoint_created", "shell_integration_warning",
  "shell_integration_warning_with_suggestion", "info", "hook_status", "hook_output_stream", "load_mcp_documentation",
  "conditional_rules_applied", "compaction", "condense", "summarize_task", "resume_task", "resume_completed_task",
  "mcp_notification", "subagent_usage", "clineignore_error", "browser_action_result", "report_bug", "new_task",
  "command_permission_denied", "mcp_server_request_started", "user_feedback_diff", "use_subagents", "subagent",
]);

function toolDraft(t: Obj, base: { ts: string | null; model: string | null; raw: unknown }): Draft {
  const name = str(t.tool) ?? "(unnamed tool)";
  const p = str(t.path) ?? "";
  const common = { tool_name: name, outside_workspace: t.operationIsLocatedInWorkspace === false ? true : undefined };
  switch (name) {
    case "readFile":
      return readDraft(base, p, common);
    case "newFileCreated":
      return writeDraft(base, p, str(t.content) ?? "", common);
    case "editedExistingFile":
    case "appliedDiff":
    case "searchAndReplace":
    case "insertContent": {
      const diff = str(t.diff) ?? str(t.content) ?? "";
      // Cline sends SEARCH/REPLACE blocks; split them into old and new text where present.
      const blocks = [...diff.matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g)];
      const oldText = blocks.map((b) => b[1]).join("\n…\n");
      const newText = blocks.length ? blocks.map((b) => b[2]).join("\n…\n") : diff;
      return editDraft(base, p, oldText, newText, {
        ...common,
        unified_diff: blocks.length ? undefined : excerpt(diff),
        lines_added: blocks.length ? blocks.reduce((n, b) => n + lineCount(b[2]!), 0) : lineCount(newText),
        lines_removed: blocks.reduce((n, b) => n + lineCount(b[1]!), 0),
      });
    }
    case "webFetch":
      return { ...base, kind: "web_fetch", summary: `Fetch ${p}`, payload: { ...common, url: p } };
    default:
      return {
        ...base, kind: "tool_call", summary: oneLine(p ? `${name}: ${p}` : name),
        payload: { ...common, input: capStrings(t) },
      };
  }
}

interface TaskFiles {
  dir: string;
  ui: string;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return tryJson(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Cline puts the working directory into the first API request's environment details. */
async function workingDirectory(dir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(dir, "api_conversation_history.json"), "utf8");
    const m = /# Current Working Directory \(([^)\n]+)\)/.exec(text);
    return m ? m[1]!.replace(/\\\\/g, "\\") : null;
  } catch {
    return null;
  }
}

export function parseClineMessages(messages: unknown[], warn: (message: string) => void, metadataModel: string | null): Draft[] {
  const drafts: Draft[] = [];
  let pendingTokens: Draft["tokens"] | undefined;
  let lastShell: Draft | null = null;
  for (const [i, m] of messages.entries()) {
    if (!isObj(m)) {
      warn(`message ${i}: not an object`);
      drafts.push(unknownDraft(null, "message is not an object", m));
      continue;
    }
    if (m.partial === true) continue; // a streaming placeholder; the final copy follows
    const ts = toIso(m.ts);
    const type = str(m.type);
    const what = type === "say" ? str(m.say) : type === "ask" ? str(m.ask) : undefined;
    const text = str(m.text) ?? "";
    const mi = isObj(m.modelInfo) ? m.modelInfo : {};
    const model = str(mi.modelId) ?? metadataModel;
    const base = { ts, model, raw: m };
    const push = (d: Draft) => {
      if (pendingTokens && d.kind !== "user_message") {
        d.tokens = pendingTokens;
        pendingTokens = undefined;
      }
      drafts.push(d);
      if (d.kind !== "shell_command") lastShell = null;
    };
    if (!what) {
      warn(`message ${i}: no say/ask value`);
      drafts.push(unknownDraft(ts, `message without say/ask (type ${JSON.stringify(type ?? null)})`, m));
      continue;
    }
    if (IGNORED.has(what)) continue;
    switch (what) {
      case "task":
      case "user_feedback":
        drafts.push({ ts, kind: "user_message", summary: oneLine(text) || "(empty prompt)", payload: { text: excerpt(text), images: Array.isArray(m.images) && m.images.length ? m.images.length : undefined }, raw: m, model: null });
        lastShell = null;
        break;
      case "api_req_started": {
        const info = tryJson(text);
        if (isObj(info)) {
          const tokens = { in: num(info.tokensIn), out: num(info.tokensOut), cacheRead: num(info.cacheReads), cacheWrite: num(info.cacheWrites) };
          if (tokens.in + tokens.out + tokens.cacheRead + tokens.cacheWrite > 0) {
            if (pendingTokens) drafts.push({ ts, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: m, model, tokens: pendingTokens });
            pendingTokens = tokens;
          }
        }
        break;
      }
      case "text":
      case "completion_result":
      case "plan_completion_result":
      case "plan_mode_respond":
      case "act_mode_respond":
      case "followup": {
        const parsed = tryJson(text);
        const body = isObj(parsed) ? str(parsed.question) ?? str(parsed.response) ?? text : text;
        if (body.trim()) push({ ...base, kind: "assistant_message", summary: oneLine(body), payload: { text: excerpt(body), question: what === "followup" ? true : undefined } });
        break;
      }
      case "reasoning":
        if (text.trim()) push({ ...base, kind: "thinking", summary: oneLine(text), payload: { text: excerpt(text) } });
        break;
      case "command": {
        const d: Draft = { ...base, kind: "shell_command", summary: `$ ${oneLine(text)}`, payload: { command: excerpt(text), exit_code: null } };
        push(d);
        lastShell = d;
        break;
      }
      case "command_output":
        if (lastShell) {
          const prev = str(lastShell.payload.stdout_excerpt) ?? "";
          lastShell.payload.stdout_excerpt = excerpt(prev ? `${prev}\n${text}` : text);
        }
        break;
      case "tool": {
        const t = tryJson(text);
        if (isObj(t)) push(toolDraft(t, base));
        else warn(`message ${i}: tool text is not JSON`);
        break;
      }
      case "use_mcp_server": {
        const t = tryJson(text);
        const o: Obj = isObj(t) ? t : {};
        const name = [str(o.serverName), str(o.toolName) ?? str(o.uri)].filter(Boolean).join("/") || "mcp";
        push({ ...base, kind: "tool_call", summary: name, payload: { tool_name: name, input: capStrings(tryJson(o.arguments) ?? o.arguments) } });
        break;
      }
      case "mcp_server_response": {
        const prev = drafts.at(-1);
        if (prev?.kind === "tool_call") prev.payload.output_excerpt = excerpt(text);
        break;
      }
      case "browser_action_launch":
      case "browser_action": {
        const t = tryJson(text);
        const o: Obj = isObj(t) ? t : { url: text };
        push({ ...base, kind: "tool_call", summary: oneLine(`browser: ${str(o.action) ?? "launch"} ${str(o.url) ?? str(o.text) ?? text}`), payload: { tool_name: "browser_action", input: capStrings(o) } });
        break;
      }
      case "error":
      case "diff_error":
      case "api_req_failed":
      case "mistake_limit_reached":
        push({ ...base, kind: "error", summary: oneLine(`Error: ${text || what}`), payload: { message: excerpt(text), source: what } });
        break;
      default:
        warn(`message ${i}: unknown ${type} value ${JSON.stringify(what)}`);
        push(unknownDraft(ts, `unknown ${type} value ${JSON.stringify(what)}`, m));
    }
  }
  if (pendingTokens) drafts.push({ ts: drafts.at(-1)?.ts ?? null, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: null, model: metadataModel, tokens: pendingTokens });
  return drafts;
}

export const clineAdapter: SourceAdapter = {
  id: "cline",
  testedVersions: ["Cline source 2026-10 (not yet verified against real logs); Roo Code and Kilo Code assumed compatible"],

  defaultRoot: defaultClineRoot,

  async discover(root?: string): Promise<string[]> {
    const out: string[] = [];
    for (const r of taskRoots(root)) {
      const tasks = path.join(r, "tasks");
      for (const id of (await listDir(tasks)).sort()) {
        const ui = path.join(tasks, id, "ui_messages.json");
        if ((await listDir(path.join(tasks, id))).includes("ui_messages.json")) out.push(ui);
      }
    }
    return out;
  },

  fingerprint: (file) => {
    const dir = path.dirname(file);
    return statFingerprint([file, path.join(dir, "task_metadata.json")]);
  },

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const task: TaskFiles = { dir: path.dirname(file), ui: file };
    const messages = await readJson(task.ui);
    if (!Array.isArray(messages)) {
      yield { type: "warning", warning: { file, line: null, message: "ui_messages.json is not a JSON array" } };
      return;
    }
    const meta = await readJson(path.join(task.dir, "task_metadata.json"));
    const usage = isObj(meta) && Array.isArray(meta.model_usage) ? meta.model_usage.filter(isObj) : [];
    const metadataModel = str(usage.at(-1)?.model_id) ?? null;

    const warnings: string[] = [];
    const drafts = parseClineMessages(messages, (w) => warnings.push(w), metadataModel);
    for (const message of warnings) yield { type: "warning", warning: { file, line: null, message } };

    const taskId = path.basename(task.dir);
    const variant = EXTENSIONS.find((x) => file.includes(x));
    const id = `cline:${taskId}`;
    for (const event of toEvents(id, drafts)) yield { type: "event", event };
    const [first, last] = timeRange(drafts);
    const totals = sumTokens(drafts);
    const prompt = drafts.find((d) => d.kind === "user_message")?.payload.text;
    const prefix = variant === "rooveterinaryinc.roo-cline" ? "[Roo] " : variant === "kilocode.kilo-code" ? "[Kilo] " : "";
    const session: Session = {
      id,
      source: "cline",
      project_path: await workingDirectory(task.dir),
      git_branch: null,
      started_at: first ?? toIso(Number(taskId)),
      ended_at: last,
      model: mostCommonModel(drafts) ?? metadataModel,
      title: oneLine(prefix + ((typeof prompt === "string" && prompt) || "(untitled)")),
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_write_tokens: totals.cacheWrite,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await clineAdapter.fingerprint(file),
    };
    yield { type: "session", session };
  },
};
