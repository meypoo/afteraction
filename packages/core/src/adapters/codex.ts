// Codex adapter (Codex CLI and Codex Desktop rollouts). Format notes: docs/log-formats.md.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
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

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const ISO_TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

/** Turns Codex Desktop creates when it imports another agent's session (e.g. a Claude Code transcript). */
const IMPORT_TURN_RE = /^external-import-/;

/** User-role messages Codex injects as context. They are not typed by the person. */
const INJECTED_RE =
  /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions|<external_codex_apps_|<turn_aborted>|<user_shell_command>|<subagent_notification>)/;

/** Function names that run a shell command. */
const SHELL_TOOLS = new Set(["shell", "container.exec", "shell_command", "exec_command", "local_shell"]);

/**
 * event_msg subtypes that mirror response items or carry UI/bookkeeping state.
 * Known, so no warning. Usage and command results are read from the ones handled below.
 */
const IGNORED_EVENT_MSGS = new Set([
  "task_started", "task_complete", "turn_started", "turn_complete", "user_message", "agent_message",
  "agent_message_delta", "agent_reasoning", "agent_reasoning_delta", "agent_reasoning_raw_content",
  "agent_reasoning_section_break", "item_started", "exec_command_begin", "exec_command_output_delta",
  "patch_apply_begin", "mcp_tool_call_begin", "mcp_tool_call_end", "web_search_begin", "web_search_end",
  "turn_diff", "plan_update", "thread_settings_applied", "session_configured", "background_event",
  "entered_review_mode", "exited_review_mode", "get_history_entry_response", "mcp_list_tools_response",
  "list_custom_prompts_response", "conversation_path", "shutdown_complete", "exec_approval_request",
  "apply_patch_approval_request", "view_image_tool_call", "token_count_delta",
]);

/** Top-level line types that carry no actions. */
const IGNORED_LINE_TYPES = new Set(["world_state", "token_usage_record_delta"]);

export function defaultCodexRoot(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

interface Tokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Draft {
  ts: string | null;
  kind: EventKind;
  summary: string;
  payload: Obj;
  raw: unknown;
  model: string | null;
  tokens?: Tokens;
  /** Placeholder for a Codex Desktop `exec` script; dropped when the script's commands are logged. */
  drop?: boolean;
  /** Commands and file changes an `exec` script ran, logged after the script's own usage record. */
  children?: Draft[];
  child?: boolean;
}

interface Usage {
  /** Drafts logged since the previous usage line: [from, to). */
  from: number;
  to: number;
  tokens: Tokens;
}

/** Recursively cap long strings so payload inputs stay small; full data is kept in `raw`. */
function capStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return excerpt(v);
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.map((x) => capStrings(x, depth + 1));
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, depth + 1)]));
  return v;
}

/** Drop encrypted reasoning and repeated instructions from `raw`; the log file keeps them. */
function slimRaw(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(slimRaw);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) {
    const bulky =
      (typeof x === "string" && x.length > 256 && k === "encrypted_content") ||
      k === "base_instructions" ||
      k === "instructions" ||
      k === "developer_instructions" ||
      k === "user_instructions";
    out[k] = bulky ? `[omitted]` : slimRaw(x);
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!isObj(b)) return "";
      if (typeof b.text === "string") return b.text;
      return b.type === "input_image" ? "[image]" : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseJson(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const SHELL_FLAG = new Set(["-c", "-lc", "-Command", "-command", "/c", "/C"]);

/** A command as one string: the script given to `bash -lc` / `pwsh -Command`, else argv joined. */
function commandText(cmd: unknown): { command: string; shell?: string } {
  if (typeof cmd === "string") return { command: cmd };
  if (!Array.isArray(cmd)) return { command: "" };
  const argv = cmd.filter((x): x is string => typeof x === "string");
  const exe = path.basename((argv[0] ?? "").replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
  const shell = /^(pwsh|powershell)$/.test(exe) ? "powershell" : /^(bash|sh|zsh|dash)$/.test(exe) ? "bash" : exe === "cmd" ? "cmd" : undefined;
  const flag = argv.findIndex((a, i) => i > 0 && SHELL_FLAG.has(a));
  if (shell && flag > 0 && flag + 1 < argv.length) return { command: argv.slice(flag + 1).join(" "), shell };
  return { command: argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "), shell };
}

/** Exit code and output from a shell function result, in the JSON or the plain-text format. */
function shellOutput(output: unknown): { exitCode: number | null; text: string; durationMs?: number } {
  let o = output;
  if (isObj(o) && "content" in o) o = o.content; // {content, success} form
  const text = typeof o === "string" ? o : contentText(o);
  const j = parseJson(text);
  if (isObj(j) && "output" in j) {
    const meta = isObj(j.metadata) ? j.metadata : {};
    const secs = typeof meta.duration_seconds === "number" ? meta.duration_seconds : undefined;
    return {
      exitCode: typeof meta.exit_code === "number" ? meta.exit_code : null,
      text: str(j.output) ?? "",
      durationMs: secs === undefined ? undefined : Math.round(secs * 1000),
    };
  }
  const m = /^(?:Process exited with code|Exit code:?)\s*(-?\d+)/m.exec(text);
  const body = /\nOutput:\n([\s\S]*)$/.exec(text);
  return { exitCode: m ? Number(m[1]) : null, text: body ? body[1]!.replace(/^\n/, "") : text };
}

const lineCount = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

function diffCounts(diff: string): [number, number] {
  let added = 0;
  let removed = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return [added, removed];
}

interface FileChange {
  op: "add" | "update" | "delete";
  path: string;
  movePath?: string;
  content?: string;
  diff?: string;
}

/** Parse an apply_patch envelope (`*** Begin Patch` … `*** End Patch`) into per-file changes. */
export function parseApplyPatch(patch: string): FileChange[] {
  const out: FileChange[] = [];
  let cur: FileChange | null = null;
  let body: string[] = [];
  const flush = () => {
    if (!cur) return;
    if (cur.op === "add") cur.content = body.map((l) => (l.startsWith("+") ? l.slice(1) : l)).join("\n") + (body.length ? "\n" : "");
    if (cur.op === "update") cur.diff = body.join("\n") + (body.length ? "\n" : "");
    out.push(cur);
    cur = null;
    body = [];
  };
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line))) {
      flush();
      cur = { op: m[1]!.toLowerCase() as FileChange["op"], path: m[2]!.trim() };
    } else if ((m = /^\*\*\* Move to: (.+)$/.exec(line)) && cur) {
      cur.movePath = m[1]!.trim();
    } else if (/^\*\*\* (Begin|End) Patch/.test(line) || line === "*** End of File") {
      if (line.startsWith("*** End Patch")) flush();
    } else if (cur) {
      body.push(line);
    }
  }
  flush();
  return out;
}

/** Changes from a Codex Desktop FileChange item: {path: {type, content | unified_diff, move_path}}. */
function fileChangesFromItem(changes: unknown): FileChange[] {
  if (!isObj(changes)) return [];
  const out: FileChange[] = [];
  for (const [p, c] of Object.entries(changes)) {
    if (!isObj(c)) continue;
    const t = str(c.type);
    if (t === "add") out.push({ op: "add", path: p, content: str(c.content) ?? "" });
    else if (t === "delete") out.push({ op: "delete", path: p });
    else out.push({ op: "update", path: p, diff: str(c.unified_diff) ?? str(c.diff) ?? "", movePath: str(c.move_path) });
  }
  return out;
}

function fileDrafts(changes: FileChange[], base: Omit<Draft, "kind" | "summary" | "payload">, extra: Obj): Draft[] {
  return changes.map((c) => {
    if (c.op === "add") {
      const content = c.content ?? "";
      return {
        ...base, kind: "file_write", summary: `Write ${c.path}`,
        payload: {
          ...extra, path: c.path, operation: "create", content_excerpt: excerpt(content),
          bytes: Buffer.byteLength(content, "utf8"), lines_added: lineCount(content), lines_removed: 0,
        },
      };
    }
    if (c.op === "delete") {
      return { ...base, kind: "file_write", summary: `Delete ${c.path}`, payload: { ...extra, path: c.path, operation: "delete" } };
    }
    const diff = c.diff ?? "";
    const [added, removed] = diffCounts(diff);
    return {
      ...base, kind: "file_edit", summary: c.movePath ? `Edit ${c.path} → ${c.movePath}` : `Edit ${c.path}`,
      payload: {
        ...extra, path: c.path, move_path: c.movePath, unified_diff: excerpt(diff),
        // new_excerpt lets content rules (e.g. destructive SQL) see the added lines.
        new_excerpt: excerpt(diff.split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n")),
        lines_added: added, lines_removed: removed,
      },
    };
  });
}

function toTokens(u: Obj): Tokens {
  // OpenAI counts cached tokens inside input_tokens; the model stores them separately.
  const cached = num(u.cached_input_tokens);
  return {
    in: Math.max(0, num(u.input_tokens) - cached),
    out: num(u.output_tokens),
    cacheRead: cached,
    cacheWrite: num(u.cache_write_input_tokens),
  };
}

interface Parsed {
  drafts: Draft[];
  warnings: ParseWarning[];
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  models: Map<string, number>;
}

async function parseRollout(file: string): Promise<Parsed> {
  const t: Parsed = {
    drafts: [], warnings: [], sessionId: null, cwd: null, gitBranch: null, firstTs: null, lastTs: null, title: null,
    models: new Map(),
  };
  const pending = new Map<string, Draft[]>();
  const records: Usage[] = []; // token_usage_record lines (Codex Desktop)
  const counts: Usage[] = []; // event_msg token_count (Codex CLI)
  const warnedTypes = new Set<string>();
  let lastTotal = -1;
  let responseStart = 0;
  let model: string | null = null;
  let importing = false;
  let openExec: Draft | null = null;
  let lastTs: string | null = null;
  let lineNo = 0;

  const warn = (message: string) => t.warnings.push({ file, line: lineNo, message });
  const push = (d: Draft) => {
    t.drafts.push(d);
    return d;
  };
  const pushChild = (d: Draft) => {
    push(d);
    if (!openExec) return;
    d.child = true;
    d.payload.via = "exec";
    openExec.drop = true;
    (openExec.children ??= []).push(d);
  };
  const unknown = (raw: unknown, reason: string) => {
    warn(reason);
    push({ ts: lastTs, kind: "unknown", summary: oneLine(`Unknown: ${reason}`), payload: { reason }, raw, model: null });
  };
  const usage = (list: Usage[], u: unknown) => {
    if (isObj(u)) list.push({ from: responseStart, to: t.drafts.length, tokens: toTokens(u) });
    responseStart = t.drafts.length;
  };

  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    lineNo++;
    const lineText = rawLine.replace(/^\uFEFF/, "").trim();
    if (!lineText) continue;
    let o: unknown;
    try {
      o = slimRaw(JSON.parse(lineText));
    } catch {
      warn("invalid JSON");
      continue;
    }
    if (!isObj(o)) {
      warn("line is not a JSON object");
      continue;
    }

    // Early rollouts had no envelope: a bare meta line, then bare response items.
    let type = str(o.type);
    let p: Obj = isObj(o.payload) ? o.payload : {};
    if (!("payload" in o)) {
      if (lineNo === 1 && typeof o.id === "string" && !type) [type, p] = ["session_meta", o];
      else if (o.record_type === "state") continue;
      else [type, p] = ["response_item", o];
    }

    const tsRaw = o.timestamp ?? (type === "session_meta" ? p.timestamp : undefined);
    if (tsRaw !== undefined) {
      if (typeof tsRaw === "string" && ISO_TS_RE.test(tsRaw) && Number.isFinite(Date.parse(tsRaw))) {
        lastTs = tsRaw;
      } else {
        warn(`invalid timestamp ${JSON.stringify(tsRaw)}; using previous`);
      }
    }
    const ts = lastTs;
    const stamp = () => {
      if (!ts) return;
      if (!t.firstTs || ts < t.firstTs) t.firstTs = ts;
      if (!t.lastTs || ts > t.lastTs) t.lastTs = ts;
    };

    if (type === "session_meta") {
      t.sessionId ??= str(p.id) ?? str(p.session_id) ?? null;
      if (!t.cwd && str(p.cwd)) t.cwd = str(p.cwd)!;
      if (!t.gitBranch && isObj(p.git) && str(p.git.branch)) t.gitBranch = str(p.git.branch)!;
      continue;
    }
    if (type === "turn_context") {
      model = str(p.model) ?? model;
      if (!t.cwd && str(p.cwd)) t.cwd = str(p.cwd)!;
      continue;
    }
    if (type && IGNORED_LINE_TYPES.has(type)) continue;

    if (type === "event_msg") {
      const sub = String(p.type);
      if (sub === "task_started" || sub === "turn_started") {
        importing = IMPORT_TURN_RE.test(str(p.turn_id) ?? "");
        continue;
      }
      if (importing) continue;
      if (sub === "token_count") {
        // Repeated with the same totals after some events; count each response once.
        const info = isObj(p.info) ? p.info : null;
        const total = info && isObj(info.total_token_usage) ? num(info.total_token_usage.total_tokens) : -1;
        if (info && total !== lastTotal) {
          lastTotal = total;
          usage(counts, info.last_token_usage);
        }
        continue;
      }
      if (sub === "exec_command_end") {
        const d = pending.get(str(p.call_id) ?? "")?.[0];
        if (d) {
          if (typeof p.exit_code === "number") d.payload.exit_code = p.exit_code;
          const out = str(p.aggregated_output) ?? str(p.formatted_output);
          if (out !== undefined) d.payload.stdout_excerpt = excerpt(out);
          else {
            d.payload.stdout_excerpt = excerpt(p.stdout);
            d.payload.stderr_excerpt = excerpt(p.stderr);
          }
          if (isObj(p.duration)) d.payload.duration_ms = Math.round(num(p.duration.secs) * 1000 + num(p.duration.nanos) / 1e6);
          d.payload.is_error = typeof p.exit_code === "number" && p.exit_code !== 0;
        }
        continue;
      }
      if (sub === "patch_apply_end") {
        for (const d of pending.get(str(p.call_id) ?? "") ?? []) {
          d.payload.is_error = p.success === false;
          if (p.success === false) d.payload.error = excerpt(str(p.stderr) || str(p.stdout));
        }
        continue;
      }
      if (sub === "turn_aborted") {
        stamp();
        push({ ts, kind: "error", summary: `Turn aborted (${str(p.reason) ?? "unknown"})`, payload: { source: "turn", reason: str(p.reason) }, raw: o, model: null });
        continue;
      }
      if (sub === "error" || sub === "stream_error") {
        stamp();
        const message = str(p.message) ?? "";
        push({ ts, kind: "error", summary: oneLine(`Error: ${message}`), payload: { source: "api", message: excerpt(message) }, raw: o, model: null });
        continue;
      }
      if (sub === "item_completed" && isObj(p.item)) {
        const item = p.item;
        const it = str(item.type);
        if (it === "CommandExecution") {
          stamp();
          const { command, shell } = commandText(item.command);
          const dur = isObj(item.duration) ? Math.round(num(item.duration.secs) * 1000 + num(item.duration.nanos) / 1e6) : undefined;
          const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
          const status = str(item.status);
          pushChild({
            ts, kind: "shell_command", summary: `$ ${oneLine(command)}`, raw: o, model,
            payload: {
              command: excerpt(command), shell, cwd: str(item.cwd)?.replace(/^file:\/\/\/?/, ""), status,
              exit_code: exitCode, stdout_excerpt: excerpt(item.aggregated_output), duration_ms: dur,
              is_error: status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0),
            },
          });
        } else if (it === "FileChange") {
          stamp();
          const status = str(item.status);
          fileDrafts(fileChangesFromItem(item.changes), { ts, raw: o, model }, {
            status, is_error: status === "failed" || status === "declined" ? true : undefined,
          }).forEach(pushChild);
        }
        // UserMessage / AgentMessage / Reasoning items mirror response items.
        continue;
      }
      if (!IGNORED_EVENT_MSGS.has(sub) && !warnedTypes.has(sub)) {
        warnedTypes.add(sub);
        warn(`unknown event_msg type "${sub}"`);
      }
      continue;
    }

    if (type === "token_usage_record") {
      if (!importing) usage(records, p.usage);
      continue;
    }

    if (type === "compacted") {
      if (importing) continue;
      stamp();
      const text = str(p.message) ?? "";
      push({ ts, kind: "user_message", summary: oneLine(text) || "(compacted history)", payload: { text: excerpt(text), meta: true, compact_summary: true }, raw: o, model: null });
      continue;
    }

    if (type !== "response_item") {
      unknown(o, `unknown line type ${JSON.stringify(type ?? null)}`);
      continue;
    }
    if (importing) continue;

    const rt = str(p.type);
    switch (rt) {
      case "message": {
        const role = str(p.role);
        if (role === "developer" || role === "system") continue; // instructions
        stamp();
        const text = contentText(p.content);
        if (role === "assistant") {
          push({ ts, kind: "assistant_message", summary: oneLine(text), payload: { text: excerpt(text), phase: str(p.phase) }, raw: o, model });
          if (model) t.models.set(model, (t.models.get(model) ?? 0) + 1);
        } else if (role === "user") {
          const meta = isObj(p.internal_chat_message_metadata_passthrough)
            ? p.internal_chat_message_metadata_passthrough
            : undefined;
          const kinds = meta && Array.isArray(meta.content_item_kinds) ? meta.content_item_kinds : null;
          const injected = kinds ? !kinds.includes("user.text") : INJECTED_RE.test(text);
          const images = Array.isArray(p.content) ? p.content.filter((b) => isObj(b) && b.type === "input_image").length : 0;
          const payload: Obj = { text: excerpt(text) };
          if (images) payload.images = images;
          if (injected) payload.meta = true;
          push({ ts, kind: "user_message", summary: text ? oneLine(text) : "(image)", payload, raw: o, model: null });
          if (!injected && t.title === null && text.trim()) t.title = oneLine(text);
        } else {
          unknown(o, `unknown message role "${String(role)}"`);
        }
        continue;
      }
      case "reasoning": {
        stamp();
        const summary = Array.isArray(p.summary) ? contentText(p.summary) : "";
        const full = Array.isArray(p.content) ? contentText(p.content) : "";
        const text = full || summary;
        push({
          ts, kind: "thinking", raw: o, model,
          summary: text ? oneLine(text.replace(/\*\*/g, "")) : "(reasoning; text not recorded)",
          payload: { text: excerpt(text), summary_only: !full && !!summary ? true : undefined, redacted: text === "" },
        });
        continue;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call": {
        stamp();
        const callId = str(p.call_id) ?? str(p.id) ?? "";
        const name = rt === "local_shell_call" ? "local_shell" : str(p.name) ?? "(unnamed tool)";
        const args: Obj = rt === "local_shell_call"
          ? (isObj(p.action) ? p.action : {})
          : rt === "function_call"
            ? ((v) => (isObj(v) ? v : {}))(parseJson(p.arguments))
            : {};
        const input = rt === "custom_tool_call" ? str(p.input) ?? "" : undefined;
        const base = { ts, raw: o as unknown, model };
        let ds: Draft[];
        if (SHELL_TOOLS.has(name)) {
          const { command, shell } = commandText(args.command ?? args.cmd);
          const cwd = str(args.workdir) ?? str(args.working_directory) ?? undefined;
          ds = [{ ...base, kind: "shell_command", summary: `$ ${oneLine(command)}`, payload: { call_id: callId, command: excerpt(command), shell, cwd } }];
        } else if (name === "apply_patch") {
          const patch = input ?? str(args.input) ?? str(args.patch) ?? "";
          ds = fileDrafts(parseApplyPatch(patch), base, { call_id: callId });
          if (!ds.length) ds = [{ ...base, kind: "tool_call", summary: "apply_patch", payload: { call_id: callId, tool_name: name, input: excerpt(patch) } }];
        } else if (name === "exec" && rt === "custom_tool_call") {
          // Codex Desktop runs tools from a JS script; the commands it ran follow as CommandExecution items.
          const d: Draft = { ...base, kind: "tool_call", summary: oneLine(`exec: ${input}`), payload: { call_id: callId, tool_name: name, input: excerpt(input) } };
          openExec = d;
          ds = [d];
        } else {
          ds = [{
            ...base, kind: "tool_call", summary: name,
            payload: { call_id: callId, tool_name: name, input: input !== undefined ? excerpt(input) : capStrings(args) },
          }];
        }
        ds.forEach(push);
        if (model) t.models.set(model, (t.models.get(model) ?? 0) + 1);
        if (callId) pending.set(callId, ds);
        continue;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = str(p.call_id) ?? "";
        const ds = pending.get(callId);
        const out = shellOutput(p.output);
        if (openExec && ds?.includes(openExec)) openExec = null;
        if (!ds) {
          stamp();
          push({ ts, kind: "tool_result", summary: oneLine(`Result: ${out.text}`), payload: { call_id: callId, content_excerpt: excerpt(out.text) }, raw: o, model: null });
          continue;
        }
        for (const d of ds) {
          const pl = d.payload;
          if (d.ts && ts) {
            const ms = Date.parse(ts) - Date.parse(d.ts);
            if (Number.isFinite(ms) && ms >= 0) pl.duration_ms ??= ms;
          }
          if (d.kind === "shell_command") {
            if (pl.exit_code === undefined) pl.exit_code = out.exitCode;
            if (pl.stdout_excerpt === undefined) pl.stdout_excerpt = excerpt(out.text);
            if (out.durationMs !== undefined) pl.duration_ms = out.durationMs;
            pl.is_error ??= out.exitCode !== null && out.exitCode !== 0;
          } else if (d.kind === "tool_call") {
            pl.result_excerpt = excerpt(out.text);
          } else if (pl.is_error === undefined && /^(apply_patch verification failed|Error|error:)/.test(out.text)) {
            pl.is_error = true;
            pl.error = excerpt(out.text);
          }
          d.raw = { call: d.raw, output: o };
        }
        continue;
      }
      case "web_search_call": {
        stamp();
        const action = isObj(p.action) ? p.action : {};
        const query = str(action.query) ?? "";
        const url = str(action.url);
        push(url
          ? { ts, kind: "web_fetch", summary: `Fetch ${url}`, payload: { url }, raw: o, model }
          : { ts, kind: "tool_call", summary: oneLine(`Web search: ${query}`), payload: { tool_name: "web_search", input: { query } }, raw: o, model });
        continue;
      }
      case "additional_tools":
        continue; // tool definitions sent to the model
      default:
        unknown(o, `unknown response item "${String(rt)}"`);
    }
  }

  // Codex Desktop logs one token_usage_record per response; older CLIs only token_count.
  // A response's usage goes on its first model-made event; a dropped exec script hands it to its first command.
  for (const { from, to, tokens } of records.length ? records : counts) {
    let d = t.drafts.slice(from, to).find((x) => !x.child && x.kind !== "user_message");
    if (d?.drop) d = d.children?.[0];
    d ??= t.drafts.slice(0, to).reverse().find((x) => !x.drop);
    if (!d) continue;
    if (d.tokens) {
      d.tokens.in += tokens.in;
      d.tokens.out += tokens.out;
      d.tokens.cacheRead += tokens.cacheRead;
      d.tokens.cacheWrite += tokens.cacheWrite;
    } else {
      d.tokens = { ...tokens };
    }
  }
  t.drafts = t.drafts.filter((d) => !d.drop);
  return t;
}

export async function codexFingerprint(file: string): Promise<string> {
  const s = await stat(file);
  return createHash("sha1").update(`${path.basename(file)}:${s.size}:${Math.trunc(s.mtimeMs)}`).digest("hex");
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
}

export const codexAdapter: SourceAdapter = {
  id: "codex",
  testedVersions: ["0.163.0-alpha.11.2"],
  defaultRoot: defaultCodexRoot,
  fingerprint: codexFingerprint,

  async discover(root = defaultCodexRoot()) {
    const files: string[] = [];
    // A Codex home has sessions/YYYY/MM/DD and archived_sessions/; any other root is searched as is.
    const subdirs = ["sessions", "archived_sessions"].map((d) => path.join(root, d));
    const home = (await Promise.all(subdirs.map((d) => stat(d).then((s) => s.isDirectory(), () => false)))).some(Boolean);
    for (const dir of home ? subdirs : [root]) await walk(dir, 4, files);
    return files.sort();
  },

  async *parse(file: string): AsyncIterable<NormalizedRecord> {
    const t = await parseRollout(file);
    for (const w of t.warnings) yield { type: "warning", warning: w };
    // A rollout that only holds an imported session (or nothing) is not a Codex session.
    if (t.drafts.length === 0) return;

    const sessionId = t.sessionId ?? /([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i.exec(file)?.[1] ?? path.basename(file, ".jsonl");
    const id = `codex:${sessionId}`;
    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    let seq = 0;
    for (const d of t.drafts) {
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
        usage_extra: null,
        model: d.model,
        risk_level: "none",
        risk_rules: [],
      };
      seq++;
      yield { type: "event", event };
    }

    let model: string | null = null;
    let best = 0;
    for (const [m, n] of t.models) if (n > best) [model, best] = [m, n];
    const session: Session = {
      id,
      source: "codex",
      project_path: t.cwd,
      git_branch: t.gitBranch,
      started_at: t.firstTs,
      ended_at: t.lastTs,
      model,
      title: t.title ?? "(untitled)",
      total_input_tokens: totals.in,
      total_output_tokens: totals.out,
      total_cache_read_tokens: totals.cacheRead,
      total_cache_write_tokens: totals.cacheWrite,
      est_cost_usd: null,
      max_risk: "none",
      source_file: file,
      source_hash: await codexFingerprint(file),
    };
    yield { type: "session", session };
  },
};
