// Markdown "session receipt" for PR comments (SPEC.md §10). Redacted by default.
import os from "node:os";
import type { SessionRow } from "./db.js";
import { fmtDuration, truncate } from "./format.js";
import { AGENT_LABELS, type NormalizedEvent } from "./model.js";
import { isAgentStatePath, isTempPath, RULES, riskRank, SECRET_PATTERNS } from "./risk.js";

export interface ReceiptOptions {
  version: string;
  /** Mask secrets and home-directory paths. Default true. */
  redact?: boolean;
  homeDir?: string;
}

const AGENT_LABEL: Record<string, string> = AGENT_LABELS;
const KEY_PREFIX =
  /^(AKIA|ASIA|sk-ant|sk-proj|sk-svcacct|sk_live|rk_live|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|AIza|npm_|hf_|sk)/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REDACTED = "…[redacted]";

/**
 * Credentials without a recognisable prefix, masked by context: the value after a secret-looking
 * name. Only for masking; they are too fuzzy for the secret-in-output risk rule.
 */
const CONTEXT_SECRETS: RegExp[] = [
  // PEM private keys: the whole body, up to END or the end of a truncated excerpt.
  /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  // .env / shell / YAML style: API_KEY=..., export DB_PASSWORD="...", GITHUB_TOKEN: ...
  /(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*[=:]\s*["']?)(?![$%{<]|\d+\b)[^\s"'`;&|,]{6,}/g,
  // JSON: "password": "...", "apiKey": "..."
  /("(?:password|passwd|secret|client_?secret|token|access_?token|refresh_?token|api_?key|apikey|private_?key)"\s*:\s*")[^"\\]{6,}/gi,
  // Flags: --password x, --token=x, --api-key x
  /(--(?:password|passwd|token|api-key|apikey|secret|client-secret)[= ]\s*["']?)(?![$%{<-])[^\s"'`]{6,}/gi,
  // HTTP auth headers
  /(\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // Passwords in URLs: scheme://user:password@host
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{3,}(?=@)/gi,
];

/** Mask API keys and other credentials, keeping a recognisable prefix (sk-ant…[redacted]). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, "g"), (m) => (m.startsWith("-----BEGIN") ? m : `${KEY_PREFIX.exec(m)?.[0] ?? ""}${REDACTED}`));
  }
  for (const re of CONTEXT_SECRETS) out = out.replace(re, (m, keep: string) => (m.slice(keep.length).startsWith(REDACTED) ? m : keep + REDACTED));
  return out;
}

/** maskSecrets on every string in a JSON-like value. */
export function maskDeep<T>(v: T): T {
  if (typeof v === "string") return maskSecrets(v) as T;
  if (Array.isArray(v)) return v.map(maskDeep) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x)])) as T;
  }
  return v;
}

/** Mask API keys and replace home directories with ~. */
export function redactText(text: string, homeDir = os.homedir()): string {
  let out = maskSecrets(text);
  if (homeDir) out = out.replace(new RegExp(escapeRe(homeDir), "gi"), "~");
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/gi, "~"); // C:\Users\name
  out = out.replace(/[A-Za-z]:\/Users\/[^/\s"'`]+/gi, "~"); // C:/Users/name
  out = out.replace(/\/[a-z]\/Users\/[^/\s"'`]+/gi, "~"); // /c/Users/name (Git Bash)
  out = out.replace(/\/(home|Users)\/[^/\s"'`]+/g, "~");
  return out;
}

/**
 * Untrusted text as one inline code span. Inside a code span GitHub renders no links, images,
 * @mentions or HTML, so a prompt or path cannot inject any. Line breaks (which could end the span
 * or start a heading) become spaces, and the fence is longer than any backtick run in the text.
 */
export function code(s: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const flat = s.replace(/[\r\n\u2028\u2029\u0085]+/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (!flat.trim()) return "—";
  const longest = Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") || (flat.startsWith(" ") && flat.endsWith(" ")) ? " " : "";
  return fence + pad + flat + pad + fence;
}

function relPath(p: string, project: string | null): string {
  if (project) {
    const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
    const a = norm(p);
    const b = norm(project);
    const windows = /^[a-zA-Z]:/.test(b);
    const inside = windows ? a.toLowerCase().startsWith(b.toLowerCase() + "/") : a.startsWith(b + "/");
    if (inside) return a.slice(b.length + 1);
  }
  return p;
}

const firstLine = (s: string) => s.split("\n")[0]!.trim();
const SEVERITY = new Map(RULES.map((r) => [r.id, r.severity]));

function money(usd: number | null): string {
  if (usd === null) return "— (unknown model pricing)";
  const v = usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
  return `${v} (estimated, API-equivalent)`;
}

export function buildReceipt(session: SessionRow, events: NormalizedEvent[], opts: ReceiptOptions): string {
  const redact = opts.redact !== false;
  const home = opts.homeDir ?? os.homedir();
  const clean = (s: string) => (redact ? redactText(s, home) : s);
  const project = session.project_path;
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // Files changed: successful writes and edits, merged per path.
  const files = new Map<string, { added: number; removed: number }>();
  for (const e of events) {
    if ((e.kind !== "file_write" && e.kind !== "file_edit") || e.payload.is_error === true) continue;
    const p = str(e.payload.path);
    if (!p || isTempPath(p) || isAgentStatePath(p)) continue; // scratch files and agent memory are not part of the change
    const f = files.get(p) ?? { added: 0, removed: 0 };
    f.added += Number(e.payload.lines_added ?? 0);
    f.removed += Number(e.payload.lines_removed ?? 0);
    files.set(p, f);
  }
  const fileParts = [...files].slice(0, 10).map(([p, f]) => `${code(clean(relPath(p, project)))} (+${f.added}/−${f.removed})`);
  if (files.size > 10) fileParts.push(`… and ${files.size - 10} more`);

  // Commands: grouped by first line, in first-seen order.
  const shells = events.filter((e) => e.kind === "shell_command");
  const commands = new Map<string, number>();
  for (const e of shells) {
    const c = truncate(firstLine(str(e.payload.command)), 60);
    commands.set(c, (commands.get(c) ?? 0) + 1);
  }
  const cmdParts = [...commands].slice(0, 8).map(([c, n]) => code(clean(c)) + (n > 1 ? ` ×${n}` : ""));
  if (commands.size > 8) cmdParts.push("…");

  // Risk flags: one line per matched rule, worst first.
  const flags: { level: string; rule: string; detail: string; rank: number; seq: number }[] = [];
  for (const e of events) {
    for (const rule of e.risk_rules) {
      const level = SEVERITY.get(rule) ?? e.risk_level;
      let detail: string;
      if (e.kind === "shell_command") detail = code(clean(truncate(firstLine(str(e.payload.command)), 80)));
      else if (e.kind === "file_read") detail = `read ${code(clean(relPath(str(e.payload.path), project)))}`;
      else if (e.kind === "file_write") detail = `wrote ${code(clean(relPath(str(e.payload.path), project)))}`;
      else if (e.kind === "file_edit") detail = `edited ${code(clean(relPath(str(e.payload.path), project)))}`;
      else detail = code(clean(truncate(e.summary, 80)));
      flags.push({ level, rule, detail, rank: riskRank(level), seq: e.seq });
    }
  }
  flags.sort((a, b) => b.rank - a.rank || a.seq - b.seq);

  const lines: string[] = [];
  lines.push("### 🛫 Agent session receipt");
  lines.push(
    `**Agent:** ${AGENT_LABEL[session.source] ?? code(session.source)} · **Model:** ${session.model ? code(session.model) : "unknown"} · ` +
      `**Duration:** ${fmtDuration(session.started_at, session.ended_at)} · **Est. cost:** ${money(session.est_cost_usd)}`,
  );
  lines.push(`**Prompt:** ${code(clean(session.title))}`);
  lines.push("");
  lines.push(files.size ? `**Files changed (${files.size}):** ${fileParts.join(", ")}` : "**Files changed:** none");
  lines.push(shells.length ? `**Commands run (${shells.length}):** ${cmdParts.join(", ")}` : "**Commands run:** none");
  if (flags.length) {
    lines.push(`**⚠️ Risk flags (${flags.length}):**`);
    for (const f of flags.slice(0, 15)) lines.push(`- ${f.level} · ${f.rule} · ${f.detail}`);
    if (flags.length > 15) lines.push(`- … and ${flags.length - 15} more`);
  } else {
    lines.push("**Risk flags:** none");
  }
  lines.push("");
  lines.push(`<sub>Generated locally by afteraction v${opts.version} — transcript not uploaded.</sub>`);
  return lines.join("\n") + "\n";
}
