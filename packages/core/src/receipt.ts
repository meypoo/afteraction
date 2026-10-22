// Markdown "session receipt" for PR comments (SPEC.md §10). Redacted by default.
import os from "node:os";
import type { SessionRow } from "./db.js";
import { fmtDuration, truncate } from "./format.js";
import type { NormalizedEvent } from "./model.js";
import { isAgentStatePath, isTempPath, RULES, riskRank, SECRET_PATTERNS } from "./risk.js";

export interface ReceiptOptions {
  version: string;
  /** Mask secrets and home-directory paths. Default true. */
  redact?: boolean;
  homeDir?: string;
}

const AGENT_LABEL: Record<string, string> = { claude_code: "Claude Code", codex: "Codex" };
const KEY_PREFIX = /^(AKIA|ASIA|sk-ant|sk-proj|sk-svcacct|sk_live|rk_live|gh[pousr]_|sk)/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mask API keys, keeping a recognisable prefix (sk-ant…[redacted]). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(re.source, "g"), (m) => `${KEY_PREFIX.exec(m)?.[0] ?? ""}…[redacted]`);
  }
  return out;
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

/** Inline code span that survives backticks inside the text. */
function code(s: string): string {
  if (!s.includes("`")) return "`" + s + "`";
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return "``" + pad + s + pad + "``";
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
  const fileParts = [...files].slice(0, 10).map(([p, f]) => `${clean(relPath(p, project))} (+${f.added}/−${f.removed})`);
  if (files.size > 10) fileParts.push(`… and ${files.size - 10} more`);

  // Commands: grouped by first line, in first-seen order.
  const shells = events.filter((e) => e.kind === "shell_command");
  const commands = new Map<string, number>();
  for (const e of shells) {
    const c = truncate(firstLine(str(e.payload.command)), 60);
    commands.set(c, (commands.get(c) ?? 0) + 1);
  }
  const cmdParts = [...commands].slice(0, 8).map(([c, n]) => {
    const shown = clean(c);
    return (shown.includes("`") || /[*_<>|]/.test(shown) ? code(shown) : shown) + (n > 1 ? ` ×${n}` : "");
  });
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
      else detail = clean(truncate(e.summary, 80));
      flags.push({ level, rule, detail, rank: riskRank(level), seq: e.seq });
    }
  }
  flags.sort((a, b) => b.rank - a.rank || a.seq - b.seq);

  const lines: string[] = [];
  lines.push("### 🛫 Agent session receipt");
  lines.push(
    `**Agent:** ${AGENT_LABEL[session.source] ?? session.source} · **Model:** ${session.model ?? "unknown"} · ` +
      `**Duration:** ${fmtDuration(session.started_at, session.ended_at)} · **Est. cost:** ${money(session.est_cost_usd)}`,
  );
  lines.push(`**Prompt:** "${clean(session.title).replace(/"/g, "'")}"`);
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
  lines.push(`<sub>Generated locally by flightrec v${opts.version} — transcript not uploaded.</sub>`);
  return lines.join("\n") + "\n";
}
