// Cursor adapter (Agent / Composer chats). Format notes: docs/log-formats.md.
//
// Cursor keeps chats in the VS Code-style global state database `User/globalStorage/state.vscdb`,
// table `cursorDiskKV`: `composerData:<composerId>` holds a chat's header and the ordered list of its
// messages ("bubbles"); each bubble is stored under `bubbleId:<composerId>:<bubbleId>`. Older chats
// keep their bubbles inline in `composerData.conversation`. The composerData shape was checked against
// a real (empty-draft) database from Cursor 2.1.39; bubble fields come from Cursor's own code and
// public notes. Not yet verified against real chats.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { excerpt, oneLine, type NormalizedRecord, type Session, type SourceAdapter } from "../model.js";
import {
  capStrings, editDraft, isObj, mostCommonModel, num, readDraft, shellDraft, str, sumTokens, timeRange, toEvents,
  toIso, tryJson, unknownDraft, writeDraft, type Draft, type Obj,
} from "./util.js";

const STATE_DB = path.join("globalStorage", "state.vscdb");

/** Cursor's `User` folder. */
export function defaultCursorRoot(): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cursor", "User");
}

/** Tool enum values from Cursor 2.1.39, used when a bubble has no tool name. */
const TOOL_BY_NUMBER: Record<number, string> = {
  5: "read_file", 6: "list_dir", 7: "edit_file", 11: "delete_file", 15: "run_terminal_cmd", 18: "web_search",
  19: "mcp", 35: "todo_write", 38: "edit_file", 39: "list_dir", 40: "read_file", 41: "grep", 42: "glob_file_search",
  49: "mcp",
};

function splitVirtual(file: string): { db: string; composerId: string } | null {
  const i = file.lastIndexOf("#");
  return i < 0 ? null : { db: file.slice(0, i), composerId: file.slice(i + 1) };
}

const openReadOnly = (file: string) => new Database(file, { readonly: true, fileMustExist: true });

function getKV(db: Database.Database, key: string): unknown {
  const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key) as { value: string | Buffer | null } | undefined;
  if (!row?.value) return undefined;
  return tryJson(typeof row.value === "string" ? row.value : row.value.toString("utf8"));
}

/** Bubble ids in order: the header list in current versions, the inline conversation in older ones. */
function bubbleRefs(composer: Obj): { id: string; inline?: Obj }[] {
  if (Array.isArray(composer.fullConversationHeadersOnly) && composer.fullConversationHeadersOnly.length)
    return composer.fullConversationHeadersOnly.filter(isObj).map((h) => ({ id: str(h.bubbleId) ?? "" }));
  if (Array.isArray(composer.conversation))
    return composer.conversation.filter(isObj).map((b) => ({ id: str(b.bubbleId) ?? "", inline: b }));
  return [];
}

const hasMessages = (composer: unknown) => isObj(composer) && bubbleRefs(composer).length > 0;

function firstStr(o: Obj, ...keys: string[]): string | undefined {
  for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
  return undefined;
}

function toolDraft(tf: Obj, ts: string | null, model: string | null, raw: unknown): Draft {
  const name = str(tf.name) ?? TOOL_BY_NUMBER[num(tf.tool)] ?? `tool_${num(tf.tool)}`;
  const params = (isObj(tryJson(tf.rawArgs)) ? tryJson(tf.rawArgs) : isObj(tryJson(tf.params)) ? tryJson(tf.params) : {}) as Obj;
  const result = tryJson(tf.result);
  const r: Obj = isObj(result) ? result : {};
  const status = str(tf.status);
  const base = { ts, model, raw };
  const common: Obj = { tool_use_id: str(tf.toolCallId), status, is_error: status === "error" ? true : undefined };
  switch (name) {
    case "run_terminal_cmd":
    case "run_terminal_command":
    case "run_terminal_command_v2": {
      const exit = typeof r.exitCode === "number" ? r.exitCode : null;
      return shellDraft(base, str(params.command) ?? "", {
        ...common,
        description: str(params.explanation),
        cwd: str(params.cwd) ?? str(r.cwd),
        run_in_background: params.is_background === true ? true : undefined,
        exit_code: exit,
        stdout_excerpt: excerpt(str(r.output) ?? (typeof result === "string" ? result : undefined)),
        is_error: status === "error" || (exit !== null && exit !== 0),
      });
    }
    case "read_file":
    case "read_file_v2":
      return readDraft(base, firstStr(params, "target_file", "targetFile", "path", "file_path") ?? "", common);
    case "write":
      return writeDraft(base, firstStr(params, "file_path", "target_file", "path") ?? "", firstStr(params, "contents", "content") ?? "", common);
    case "search_replace":
      return editDraft(base, firstStr(params, "file_path", "target_file") ?? "", str(params.old_string) ?? "", str(params.new_string) ?? "", common);
    case "edit_file":
    case "edit_file_v2":
      return editDraft(base, firstStr(params, "target_file", "targetFile", "file_path", "relativeWorkspacePath") ?? "", "", firstStr(params, "code_edit", "codeEdit", "contents") ?? "", {
        ...common, description: str(params.instructions), unified_diff: excerpt(str(r.diff)),
      });
    case "web_search":
      return { ...base, kind: "tool_call", summary: oneLine(`web_search: ${str(params.search_term) ?? ""}`), payload: { ...common, tool_name: name, input: capStrings(params) } };
    default:
      return {
        ...base, kind: "tool_call", summary: name,
        payload: { ...common, tool_name: name, input: capStrings(params), output_excerpt: excerpt(typeof result === "string" ? result : result === undefined ? undefined : JSON.stringify(result)) },
      };
  }
}

function bubbleDrafts(b: Obj, fallbackTs: string | null, model: string | null): Draft[] {
  const ts = toIso(b.createdAt) ?? toIso(isObj(b.timingInfo) ? b.timingInfo.clientStartTime : undefined) ?? fallbackTs;
  const text = str(b.text) ?? "";
  const out: Draft[] = [];
  const type = b.type;
  if (type === 1) {
    out.push({ ts, kind: "user_message", summary: oneLine(text) || "(empty prompt)", payload: { text: excerpt(text) }, raw: b, model: null });
    return out;
  }
  if (type !== 2) return [unknownDraft(ts, `unknown bubble type ${JSON.stringify(type ?? null)}`, b)];
  const thinking = isObj(b.thinking) ? str(b.thinking.text) : undefined;
  if (thinking) out.push({ ts, kind: "thinking", summary: oneLine(thinking), payload: { text: excerpt(thinking) }, raw: b, model });
  if (text.trim()) out.push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text) }, raw: b, model });
  if (isObj(b.toolFormerData)) out.push(toolDraft(b.toolFormerData, ts, model, b));
  const tc = isObj(b.tokenCount) ? b.tokenCount : null;
  if (tc && num(tc.inputTokens) + num(tc.outputTokens) > 0) {
    const tokens = { in: num(tc.inputTokens), out: num(tc.outputTokens), cacheRead: 0, cacheWrite: 0 };
    if (out[0]) out[0].tokens = tokens;
    else out.push({ ts, kind: "assistant_message", summary: "(no content)", payload: { text: "" }, raw: b, model, tokens });
  }
  return out;
}

/** composerId → workspace folder, from each workspace's own state.vscdb. */
function workspaceFolders(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const wsRoot = path.join(root, "workspaceStorage");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(wsRoot);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const db = path.join(wsRoot, d, "state.vscdb");
    const wsJson = path.join(wsRoot, d, "workspace.json");
    if (!existsSync(db) || !existsSync(wsJson)) continue;
    try {
      const ws = tryJson(readFileSync(wsJson, "utf8"));
      const uri = isObj(ws) ? str(ws.folder) : undefined;
      if (!uri) continue;
      const folder = fileUriToPath(uri);
      const conn = openReadOnly(db);
      try {
        const row = conn.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as { value: string } | undefined;
        const data = tryJson(row?.value);
        const all = isObj(data) && Array.isArray(data.allComposers) ? data.allComposers : [];
        for (const c of all) if (isObj(c) && str(c.composerId)) out.set(c.composerId as string, folder);
      } finally {
        conn.close();
      }
    } catch {
      // a locked or foreign workspace database is skipped
    }
  }
  return out;
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  let p = uri.slice("file://".length);
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep it encoded
  }
  const drive = /^\/([a-z]):(\/.*)?$/i.exec(p);
  return drive ? `${drive[1]}:${(drive[2] ?? "/").replace(/\//g, "\\")}` : p;
}

export const cursorAdapter: SourceAdapter = {
  id: "cursor",
  testedVersions: ["2.1.39 (composerData only; bubbles not yet verified against real logs)"],

  defaultRoot: defaultCursorRoot,

  async discover(root = defaultCursorRoot()): Promise<string[]> {
    const file = path.join(root, STATE_DB);
    if (!existsSync(file)) return [];
    const db = openReadOnly(file);
    try {
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as { key: string; value: string | Buffer | null }[];
      const out: string[] = [];
      for (const r of rows) {
        const v = r.value === null ? undefined : tryJson(typeof r.value === "string" ? r.value : r.value.toString("utf8"));
        if (hasMessages(v)) out.push(`${file}#${r.key.slice("composerData:".length)}`); // empty drafts are skipped
      }
      return out.sort();
    } catch {
      return [];
    } finally {
      db.close();
    }
  },

  async fingerprint(file: string): Promise<string> {
    const v = splitVirtual(file);
    if (!v) throw new Error(`not a Cursor chat path: ${file}`);
    const db = openReadOnly(v.db);
    try {
      const row = db.prepare("SELECT length(value) AS n, value FROM cursorDiskKV WHERE key = ?").get(`composerData:${v.composerId}`) as { n: number; value: string } | undefined;
      const c = tryJson(row?.value);
      const last = isObj(c) ? `${String(c.lastUpdatedAt)}:${bubbleRefs(c).length}` : "missing";
      const bubbles = db.prepare("SELECT COUNT(*) AS n, SUM(length(value)) AS bytes FROM cursorDiskKV WHERE key LIKE ?").get(`bubbleId:${v.composerId}:%`) as { n: number; bytes: number | null };
      return createHash("sha1").update(`${row?.n}:${last}:${bubbles.n}:${bubbles.bytes}`).digest("hex");
    } finally {
      db.close();
    }
  },

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const v = splitVirtual(file);
    if (!v) {
      yield { type: "warning", warning: { file, line: null, message: "not a Cursor chat path (<state.vscdb>#<composer id>)" } };
      return;
    }
    const db = openReadOnly(v.db);
    let composer: unknown;
    const drafts: Draft[] = [];
    try {
      composer = getKV(db, `composerData:${v.composerId}`);
      if (!isObj(composer)) {
        yield { type: "warning", warning: { file, line: null, message: "chat not found or not JSON" } };
        return;
      }
      const model = isObj(composer.modelConfig) ? str(composer.modelConfig.modelName) ?? null : null;
      let lastTs = toIso(composer.createdAt);
      for (const ref of bubbleRefs(composer)) {
        const b = ref.inline ?? getKV(db, `bubbleId:${v.composerId}:${ref.id}`);
        if (!isObj(b)) {
          yield { type: "warning", warning: { file, line: null, message: `bubble ${ref.id}: missing or not JSON` } };
          continue;
        }
        for (const d of bubbleDrafts(b, lastTs, model)) {
          if (d.kind === "unknown") yield { type: "warning", warning: { file, line: null, message: `bubble ${ref.id}: ${String(d.payload.reason)}` } };
          drafts.push(d);
          lastTs = d.ts ?? lastTs;
        }
      }
    } finally {
      db.close();
    }

    const c = composer as Obj;
    const id = `cursor:${v.composerId}`;
    for (const event of toEvents(id, drafts)) yield { type: "event", event };
    const [first, last] = timeRange(drafts);
    const totals = sumTokens(drafts);
    const folder = workspaceFolders(path.dirname(path.dirname(v.db))).get(v.composerId) ?? null;
    const firstPrompt = drafts.find((d) => d.kind === "user_message")?.payload.text;
    const session: Session = {
      id,
      source: "cursor",
      project_path: folder,
      git_branch: null,
      started_at: toIso(c.createdAt) ?? first,
      ended_at: toIso(c.lastUpdatedAt) ?? last,
      model: mostCommonModel(drafts),
      title: oneLine(str(c.name) || (typeof firstPrompt === "string" ? firstPrompt : "") || "(untitled)"),
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await cursorAdapter.fingerprint(file),
    };
    yield { type: "session", session };
  },
};
