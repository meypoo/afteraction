// Rule-based risk detection (SPEC.md §6). Each rule is a pure function over one event.
// Shell matching is heuristic: commands are split into segments on ; && || | and newlines,
// and most rules look at the program in command position, so "echo rm -rf x" is not a hit.
import type { NormalizedEvent, RiskLevel, Session } from "./model.js";

export interface RuleContext {
  projectPath: string | null;
}

export interface RiskRule {
  id: string;
  severity: Exclude<RiskLevel, "none">;
  description: string;
  match(event: NormalizedEvent, ctx: RuleContext): boolean;
}

const LEVEL_ORDER: RiskLevel[] = ["none", "low", "medium", "high", "critical"];
export const riskRank = (l: RiskLevel): number => LEVEL_ORDER.indexOf(l);

// ---- shell helpers ---------------------------------------------------------------------

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function command(e: NormalizedEvent): string {
  return e.kind === "shell_command" ? str(e.payload.command) : "";
}

/** The command with heredoc bodies removed: they are data (often a whole script), not commands. */
export function stripHeredocs(cmd: string): string {
  const out: string[] = [];
  const pending: { tag: string; dash: boolean }[] = [];
  for (const line of cmd.split("\n")) {
    if (pending.length) {
      const h = pending[0]!;
      if ((h.dash ? line.trim() : line.replace(/\r$/, "")) === h.tag) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) pending.push({ tag: m[3]!, dash: m[1] === "-" });
  }
  return out.join("\n");
}

/** VAR=value assignments in the command, for expanding "$VAR" in later arguments. */
function assignments(cmd: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s;&|)]+))/g)) {
    vars.set(m[1]!, m[3] ?? m[4] ?? m[5] ?? "");
  }
  return vars;
}

const unquote = (t: string) => t.replace(/^["'`]+|["'`;)]+$/g, "");

/** Prefixes that run another program: skip them to find the real command. */
const WRAPPERS = new Set(["sudo", "doas", "env", "time", "nohup", "exec", "xargs", "command", "&", "call"]);

interface Segment {
  program: string; // lower-cased basename, without .exe
  args: string[];
  sudo: boolean;
}

function segments(cmd: string): Segment[] {
  const out: Segment[] = [];
  const text = stripHeredocs(cmd);
  const vars = assignments(text);
  const expand = (t: string) => t.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name: string) => vars.get(name) ?? m);
  for (const raw of text.split(/&&|\|\||[;|\n]/)) {
    const part = expand(raw);
    let tokens = part.trim().split(/\s+/).filter(Boolean).map(unquote).filter(Boolean);
    let sudo = false;
    for (;;) {
      const first = tokens[0]?.toLowerCase();
      if (!first) break;
      if (WRAPPERS.has(first)) {
        if (first === "sudo" || first === "doas") sudo = true;
        tokens = tokens.slice(1);
        while (tokens[0]?.startsWith("-")) tokens = tokens.slice(1); // wrapper flags
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
        tokens = tokens.slice(1); // VAR=value prefix
      } else if (first === "cmd" && /^\/c$/i.test(tokens[1] ?? "")) {
        tokens = tokens.slice(2);
      } else break;
    }
    if (!tokens.length) continue;
    const program = tokens[0]!.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
    out.push({ program, args: tokens.slice(1), sudo });
  }
  return out;
}

const lower = (args: string[]) => args.map((a) => a.toLowerCase());

// ---- path helpers ----------------------------------------------------------------------

function normPath(p: string): { path: string; windows: boolean } {
  const windows = /^[a-zA-Z]:/.test(p) || p.includes("\\");
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (windows) s = s.toLowerCase();
  return { path: s, windows };
}

function isInside(p: string, root: string): boolean {
  const a = normPath(p);
  const b = normPath(root);
  const pa = b.windows ? a.path.toLowerCase() : a.path;
  return pa === b.path || pa.startsWith(b.path + "/");
}

/** OS temp directories, where agents keep scratch files. */
export function isTempPath(p: string): boolean {
  const n = "/" + p.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  return /^\/(private\/)?(var\/)?tmp(\/|$)/.test(n) || /^\/(private\/)?var\/folders\//.test(n) || /\/appdata\/local\/temp(\/|$)/.test(n) ||
    /^\/(\$tmpdir|\$\{tmpdir\}|%temp%|%tmp%|\$env:temp|\$env:tmp)(\/|$)/.test(n);
}

/** An agent's own config/memory directory (~/.claude, ~/.codex, ~/.gemini, OpenCode's data and config dirs, …). */
export const isAgentStatePath = (p: string) =>
  /(^|[\\/])\.(claude|codex|gemini|cursor|continue|aider)([\\/]|$)/.test(p) ||
  /[\\/]\.(local[\\/]share|config)[\\/]opencode([\\/]|$)/.test(p);

const isAbsolute = (p: string) => p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("~");

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

// ---- rule-specific matchers ------------------------------------------------------------

const BUILD_DIRS = new Set(["node_modules", "dist", "build", ".next", "target"]);

interface RmCall {
  targets: string[];
  cwd: string;
}

/** Recursive + forced deletes in bash, PowerShell and cmd syntax. */
function recursiveForceDeletes(e: NormalizedEvent): RmCall[] {
  const out: RmCall[] = [];
  const cwd = str(e.payload.cwd);
  for (const s of segments(command(e))) {
    const args = s.args;
    const la = lower(args);
    let recursive = false;
    let force = false;
    if (s.program === "rm" || s.program === "remove-item" || s.program === "ri" || s.program === "del" || s.program === "rmdir" || s.program === "rd") {
      for (const a of la) {
        if (/^-[a-z]*r[a-z]*$/.test(a) && !a.startsWith("--") && a.length <= 4) {
          recursive = true;
          if (a.includes("f")) force = true;
        }
        if (/^-[a-z]*f[a-z]*$/.test(a) && a.length <= 4 && !a.startsWith("--")) {
          force = true;
          if (/r/.test(a.slice(1))) recursive = true;
        }
        if (a === "--recursive" || a === "-recurse" || a === "/s") recursive = true;
        if (a === "--force" || a === "-force" || a === "-fo" || a === "/q") force = true;
      }
    }
    if (!(recursive && force)) continue;
    const targets = args.filter((a) => !/^-/.test(a) && !/^\/[sqSQ]$/.test(a));
    out.push({ targets, cwd });
  }
  return out;
}

const ROOT_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$home", "${home}", "$home/", "$home/*", "$env:userprofile", "$env:homedrive", "%userprofile%"]);

function isRootTarget(t: string, cwd: string, projectPath: string | null): boolean {
  const l = t.toLowerCase();
  if (ROOT_TARGETS.has(l)) return true;
  if (/^[a-z]:[\\/]?\*?$/.test(l)) return true; // C:\ or C:\*
  if ((l === "*" || l === "./*" || l === ".\\*") && projectPath && cwd && normPath(cwd).path === normPath(projectPath).path) return true;
  return false;
}

const FETCHERS = "curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod";
const SHELLS = "sh|bash|zsh|dash|ksh|fish|python3?|node|perl|ruby|iex|invoke-expression|pwsh|powershell";
const PIPE_TO_SHELL = [
  // `| python -c "..."` runs the -c code with the download as stdin data, so it is excluded.
  new RegExp(`\\b(${FETCHERS})\\b[^;&\\n]*\\|\\s*(sudo\\s+)?(${SHELLS})\\b(?!\\s+-[ce]\\b)`, "i"),
  /\b(bash|sh|zsh)\s+<\(\s*(curl|wget)\b/i,
  /\b(bash|sh|zsh)\s+-c\s+["']?\$\(\s*(curl|wget)\b/i,
  /\b(eval|source)\s+["']?\$\(\s*(curl|wget)\b/i, // eval "$(curl …)"
  /(^|[\s;&|(])(source|\.)\s+<\(\s*(curl|wget)\b/i, // source <(curl …)
  /\b(iex|invoke-expression)\s*\(+\s*(iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+net\.webclient)\b/i,
];

/** The git subcommand and its arguments, skipping global flags like -C <dir>. */
function gitCalls(e: NormalizedEvent): { sub: string; args: string[] }[] {
  const out: { sub: string; args: string[] }[] = [];
  for (const s of segments(command(e))) {
    if (s.program !== "git") continue;
    let i = 0;
    while (i < s.args.length && s.args[i]!.startsWith("-")) i += /^-(C|c)$/.test(s.args[i]!) ? 2 : 1;
    const sub = s.args[i]?.toLowerCase();
    if (sub) out.push({ sub, args: s.args.slice(i + 1) });
  }
  return out;
}

function isSecretPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").toLowerCase();
  const b = baseName(norm);
  if (/^\.env(\..+)?$/.test(b) && !/\.(example|sample|template|dist)$/.test(b)) return true;
  if (b.endsWith(".pem") || b.endsWith(".key")) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)/.test(b) && !b.endsWith(".pub")) return true;
  if (b === ".npmrc") return true;
  if (norm.endsWith(".aws/credentials")) return true;
  return false;
}

const FILE_READERS = new Set([
  "cat", "less", "more", "head", "tail", "bat", "type", "get-content", "gc", "source", "nl", "tac", "xxd", "od", "strings", "base64",
  "grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "select-string", "sls",
]);
/** Copiers read every argument but the last (the destination): `cp .env.example .env` reads no secret. */
const FILE_COPIERS = new Set(["cp", "scp", "rsync", "copy-item", "copy", "cpi"]);

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "OpenAI API key", re: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { name: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g },
  { name: "Stripe live key", re: /\b(sk|rk)_live_[0-9a-zA-Z]{24,}/g },
  { name: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { name: "Private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g },
];

/** Text produced by or written during an event: command output, written content, tool results. */
function outputTexts(e: NormalizedEvent): string[] {
  const p = e.payload;
  return [p.stdout_excerpt, p.stderr_excerpt, p.content_excerpt, p.new_excerpt, p.result_excerpt, p.error].map(str).filter(Boolean);
}

const hasSecret = (text: string) => SECRET_PATTERNS.some(({ re }) => new RegExp(re.source).test(text));

const PACKAGE_INSTALL: Record<string, RegExp> = {
  npm: /^(i|install|add|ci)$/, pnpm: /^(i|install|add)$/, yarn: /^add$/, bun: /^(add|install|i)$/,
  pip: /^install$/, pip3: /^install$/, brew: /^install$/, cargo: /^(add|install)$/, gem: /^install$/,
  go: /^(get|install)$/, apt: /^install$/, "apt-get": /^install$/, choco: /^install$/, winget: /^install$/,
  dnf: /^install$/, yum: /^install$/,
};

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)$/i;

const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlite", "sqlcmd", "duckdb", "clickhouse", "clickhouse-client", "cockroach", "mongosh", "supabase", "turso", "wrangler", "pg"]);

function sqlDestructive(text: string): boolean {
  if (/\bdrop\s+(table|database|schema)\b/i.test(text)) return true;
  if (/\btruncate\s+(table\s+)?[A-Za-z_"`[][\w."`\]]*/i.test(text)) return true;
  for (const stmt of text.split(";")) {
    if (/\bdelete\s+from\s+\S+/i.test(stmt) && !/\bwhere\b/i.test(stmt)) return true;
  }
  return false;
}

// ---- rules -----------------------------------------------------------------------------

export const RULES: RiskRule[] = [
  {
    id: "destructive-rm",
    severity: "high",
    description: "Recursive forced delete of something other than a build directory",
    match: (e) =>
      recursiveForceDeletes(e).some(({ targets }) =>
        targets.length === 0 ||
        targets.some((t) => !BUILD_DIRS.has(baseName(t.replace(/^\.[\\/]/, ""))) && !isTempPath(t))),
  },
  {
    id: "rm-root-or-home",
    severity: "critical",
    description: "Recursive forced delete of /, the home directory, a drive root, or * at the project root",
    match: (e, ctx) => recursiveForceDeletes(e).some(({ targets, cwd }) => targets.some((t) => isRootTarget(t, cwd, ctx.projectPath))),
  },
  {
    id: "pipe-to-shell",
    severity: "high",
    description: "Downloaded script piped straight into a shell or interpreter",
    match: (e) => PIPE_TO_SHELL.some((re) => re.test(stripHeredocs(command(e)))),
  },
  {
    id: "git-force",
    severity: "high",
    description: "Force push, hard reset or forced clean",
    match: (e) =>
      gitCalls(e).some(({ sub, args }) => {
        const la = lower(args);
        if (sub === "push") return la.some((a) => a.startsWith("--force") || /^-[a-z]*f[a-z]*$/.test(a)) || args.some((a) => a.startsWith("+"));
        if (sub === "reset") return la.includes("--hard");
        if (sub === "clean") return la.some((a) => a === "--force" || /^-[a-z]*f[a-z]*$/.test(a));
        return false;
      }),
  },
  {
    id: "git-history-rewrite",
    severity: "medium",
    description: "Rebase, amend or filter-branch (rewrites history)",
    match: (e) =>
      gitCalls(e).some(({ sub, args }) => {
        const la = lower(args);
        if (sub === "rebase") return !la.includes("--abort") && !la.includes("--quit");
        if (sub === "commit") return la.includes("--amend");
        return sub === "filter-branch" || sub === "filter-repo";
      }),
  },
  {
    id: "secret-file-read",
    severity: "high",
    description: "Read a file that usually holds secrets (.env, keys, credentials)",
    match: (e) => {
      if (e.kind === "file_read") return isSecretPath(str(e.payload.path));
      return segments(command(e)).some((s) => {
        const copier = FILE_COPIERS.has(s.program);
        if (!FILE_READERS.has(s.program) && !copier) return false;
        const redirect = s.args.findIndex((a) => /^\d?>/.test(a));
        let args = (redirect >= 0 ? s.args.slice(0, redirect) : s.args).filter((a) => !a.startsWith("-"));
        if (copier) args = args.slice(0, -1);
        return args.some((a) => isSecretPath(a));
      });
    },
  },
  {
    id: "secret-in-output",
    severity: "high",
    description: "API key pattern in command output, written content or a tool result",
    match: (e) => outputTexts(e).some(hasSecret),
  },
  {
    id: "sudo",
    severity: "medium",
    description: "Command run with elevated privileges",
    match: (e) => segments(command(e)).some((s) => s.sudo) || /-verb\s+runas\b/i.test(command(e)),
  },
  {
    id: "package-install",
    severity: "low",
    description: "Package install (supply-chain awareness)",
    match: (e) =>
      segments(command(e)).some((s) => {
        const la = lower(s.args);
        if (/^python[0-9.]*$|^py$/.test(s.program)) return la[0] === "-m" && /^pip3?$/.test(la[1] ?? "") && la[2] === "install";
        if (s.program === "uv") return (la[0] === "pip" && la[1] === "install") || la[0] === "add";
        const re = PACKAGE_INSTALL[s.program];
        return !!re && re.test(la[0] ?? "");
      }),
  },
  {
    id: "outside-project-write",
    severity: "medium",
    description: "File written or edited outside the project directory",
    match: (e, ctx) => {
      if (e.kind !== "file_write" && e.kind !== "file_edit") return false;
      const p = str(e.payload.path);
      if (!ctx.projectPath || !p || !isAbsolute(p) || isTempPath(p) || isAgentStatePath(p)) return false;
      return !isInside(p, ctx.projectPath);
    },
  },
  {
    id: "network-exfil-hint",
    severity: "medium",
    description: "Data uploaded with curl/wget/Invoke-WebRequest to a non-local host",
    match: (e) =>
      segments(command(e)).some((s) => {
        const la = lower(s.args);
        let sends = false;
        if (s.program === "curl") sends = s.args.some((a) => /^(-d|-F|-T)/.test(a) || /^--(data|form|upload-file|json)/.test(a));
        else if (s.program === "wget") sends = la.some((a) => /^--(post|body)-(data|file)/.test(a));
        else if (/^(iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(s.program))
          sends = la.includes("-body") || la.includes("-infile") || la.some((a, i) => a === "-method" && la[i + 1] === "post");
        if (!sends) return false;
        const hosts = s.args.flatMap((a) => {
          const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(a);
          return m ? [m[1]!] : [];
        });
        return hosts.length === 0 || hosts.some((h) => !LOCAL_HOST.test(h));
      }),
  },
  {
    id: "chmod-permissive",
    severity: "low",
    description: "World-writable or recursive permission change",
    match: (e) =>
      segments(command(e)).some((s) => {
        if (s.program === "icacls") return /everyone:\(?f/i.test(s.args.join(" "));
        if (s.program !== "chmod") return false;
        return s.args.some((a) => a === "-R" || a === "--recursive" || /^0?[0-7]?[0-7]{2}[2367]$/.test(a) || /^[ugoa]*\+[rwx]*w[rwx]*$/.test(a) && /[oa]/.test(a.split("+")[0]!));
      }),
  },
  {
    id: "db-destructive",
    severity: "high",
    description: "DROP TABLE, TRUNCATE, or DELETE FROM without WHERE",
    match: (e) => {
      if (e.kind === "shell_command") {
        // SQL text in grep patterns or scripts is not executed; a database client (with its heredoc) is.
        return segments(command(e)).some((s) => DB_CLIENTS.has(s.program)) && sqlDestructive(command(e));
      }
      if ((e.kind === "file_write" || e.kind === "file_edit") && /\.sql$/i.test(str(e.payload.path)))
        return sqlDestructive(str(e.payload.content_excerpt) + "\n" + str(e.payload.new_excerpt));
      return false;
    },
  },
];

export function matchRules(event: NormalizedEvent, ctx: RuleContext): string[] {
  return RULES.filter((r) => {
    try {
      return r.match(event, ctx);
    } catch {
      return false; // a rule bug must never break ingestion
    }
  }).map((r) => r.id);
}

const SEVERITY = new Map(RULES.map((r) => [r.id, r.severity]));

/** Set risk_level/risk_rules on every event and max_risk on the session, in place. */
export function applyRisks(events: NormalizedEvent[], session: Pick<Session, "project_path" | "max_risk"> | null): void {
  const ctx: RuleContext = { projectPath: session?.project_path ?? null };
  let max: RiskLevel = "none";
  for (const e of events) {
    const ids = matchRules(e, ctx);
    let level: RiskLevel = "none";
    for (const id of ids) {
      const sev = SEVERITY.get(id)!;
      if (riskRank(sev) > riskRank(level)) level = sev;
    }
    e.risk_rules = ids;
    e.risk_level = level;
    if (riskRank(level) > riskRank(max)) max = level;
  }
  if (session) session.max_risk = max;
}
