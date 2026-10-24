import { Command, InvalidArgumentError, Option } from "commander";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  ADAPTERS,
  AGENT_LABELS,
  buildReceipt,
  COST_LABEL,
  defaultDbPath,
  listRisks,
  loadPrices,
  maskDeep,
  maskSecrets,
  RULES,
  safeTerminal,
  fileTouches,
  getEvents,
  getSession,
  ingest,
  listSessions,
  openDb,
  parseSince,
  purgeSessions,
  resolveSession,
  sourceCounts,
  warningSummary,
  baseName,
  fmtDateTime,
  fmtDuration,
  fmtTime,
  fmtTokens,
  table,
  truncate,
  type Db,
  type IngestReport,
  type RiskLevel,
  type SourceConfig,
} from "@afteraction/core";
import { writeDemoLogs } from "./demo.js";
import { newToken, startServer } from "./server.js";


export const VERSION = "0.1.0";
const DEFAULT_PORT = 4317;

/** Built web UI: copied next to the bundle by scripts/build.mjs, else the workspace's web package. */
function webRoot(): string {
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
  if (existsSync(path.join(bundled, "index.html"))) return bundled;
  try {
    return path.join(path.dirname(createRequire(import.meta.url).resolve("@afteraction/web/package.json")), "dist");
  } catch {
    return bundled;
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // no browser available: the URL is printed anyway
  }
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

// Log text (titles, commands, paths, warnings) reaches these lines, so on a terminal control
// characters are made visible instead of being interpreted as escape sequences.
const defaultIo: Io = {
  out: (s) => process.stdout.write((process.stdout.isTTY ? safeTerminal(s) : s) + "\n"),
  err: (s) => process.stderr.write((process.stderr.isTTY ? safeTerminal(s) : s) + "\n"),
};

/** Thrown for user errors; the message is printed without a stack trace. */
export class CliError extends Error {}

interface GlobalOpts {
  db?: string;
  source: string[];
  config?: string;
  /** false with --no-default-sources: read only the sources named by --source or the config file. */
  defaultSources: boolean;
}

/** ~/.afteraction/config.json (or --config): defaults that command-line flags override. */
interface Config {
  db?: string;
  port?: number;
  sources?: Record<string, string>;
}

const expandHome = (p: string) => (p === "~" || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

function loadConfig(explicit?: string): Config {
  const file = explicit ?? path.join(os.homedir(), ".afteraction", "config.json");
  if (!existsSync(file)) {
    if (explicit) throw new CliError(`Config file not found: ${file}`);
    return {};
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliError(`Invalid config file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const bad = (why: string) => new CliError(`Invalid config file ${file}: ${why}`);
  if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw bad("expected a JSON object");
  const c = cfg as Record<string, unknown>;
  if (c.db !== undefined && (typeof c.db !== "string" || !c.db)) throw bad('"db" must be a path');
  if (c.port !== undefined && (!Number.isInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65535)) {
    throw bad('"port" must be an integer from 1 to 65535');
  }
  if (c.sources !== undefined && (typeof c.sources !== "object" || c.sources === null || Array.isArray(c.sources))) {
    throw bad('"sources" must be an object of name: path');
  }
  for (const [name, root] of Object.entries((c.sources ?? {}) as Record<string, unknown>)) {
    if (!ADAPTERS[name]) throw bad(`unknown source "${name}" (known: ${Object.keys(ADAPTERS).join(", ")})`);
    if (typeof root !== "string" || !root) throw bad(`source "${name}" must be a path`);
  }
  return c as Config;
}

function dbPathFor(g: GlobalOpts): string {
  const cfg = loadConfig(g.config);
  return g.db ? expandHome(g.db) : cfg.db ? expandHome(cfg.db) : defaultDbPath();
}

function positiveInt(value: string): number {
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new InvalidArgumentError("expected a whole number of at least 1");
  return Number(value);
}

function parseSourceFlag(value: string, prev: string[]): string[] {
  const m = /^([a-z_]+)=(.+)$/.exec(value);
  if (!m || !ADAPTERS[m[1]!]) {
    throw new InvalidArgumentError(`expected name=path with name one of: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return [...prev, value];
}

function sourcesFrom(opts: GlobalOpts): SourceConfig[] {
  const overrides = new Map(Object.entries(loadConfig(opts.config).sources ?? {}).map(([k, v]) => [k, expandHome(v)]));
  for (const s of opts.source) overrides.set(s.slice(0, s.indexOf("=")), expandHome(s.slice(s.indexOf("=") + 1)));
  return Object.entries(ADAPTERS)
    .filter(([name]) => opts.defaultSources !== false || overrides.has(name))
    .map(([name, adapter]) => ({ adapter, root: overrides.get(name) }));
}

const MAX_PRINTED_WARNINGS = 20;

async function runIngest(db: Db, opts: GlobalOpts, full: boolean, io: Io): Promise<IngestReport> {
  let printed = 0;
  const report = await ingest(db, {
    sources: sourcesFrom(opts),
    full,
    onWarning: (w) => {
      if (printed++ < MAX_PRINTED_WARNINGS) io.err(maskSecrets(`warning: ${w.file}:${w.line ?? "?"} ${w.message}`));
    },
    onError: (file, err) => io.err(maskSecrets(`error: could not ingest ${file}: ${err instanceof Error ? err.message : String(err)}`)),
  });
  if (report.warnings > MAX_PRINTED_WARNINGS) {
    io.err(`… and ${report.warnings - MAX_PRINTED_WARNINGS} more warnings (see "afteraction doctor")`);
  }
  io.out(
    `Ingested ${report.filesSeen} files: ${report.filesParsed} parsed, ${report.filesSkipped} unchanged` +
      (report.filesFailed ? `, ${report.filesFailed} failed` : "") +
      ` · ${report.events} events · ${report.warnings} warnings` +
      (report.recomputed ? ` · re-scored ${report.recomputed} sessions (rules or prices changed)` : "") +
      ` · ${(report.ms / 1000).toFixed(1)}s`,
  );
  return report;
}

const AGENT_LABEL: Record<string, string> = AGENT_LABELS;

const fmtCost = (usd: number | null) => (usd === null ? "—" : usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

function costNote(): string {
  const p = loadPrices();
  return `Cost: ${COST_LABEL.toLowerCase()} · prices as of ${p.last_updated}${p.confirmed ? "" : " (not yet confirmed)"} · — means a model without a price`;
}
const RISKS: RiskLevel[] = ["none", "low", "medium", "high", "critical"];

/** Holds the database opened by a command so the caller can close it, even after an error. */
export interface CliState {
  db?: Db;
}

/** A throwaway database of made-up sessions in a temp dir; the caller closes it and removes `dir`. */
async function openDemo(state: CliState, io: Io): Promise<{ db: Db; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "afteraction-demo-"));
  const db = (state.db = openDb(path.join(dir, "demo.db")));
  const report = await ingest(db, { sources: [{ adapter: ADAPTERS.claude!, root: writeDemoLogs(dir) }] });
  io.out(`Demo mode: ${report.sessions} sample sessions (made up; your own logs are not read).`);
  return { db, dir };
}

export function buildProgram(io: Io = defaultIo, state: CliState = {}): Command {
  const program = new Command();
  const openFor = (cmd: Command): Db => {
    const g = cmd.optsWithGlobals<GlobalOpts>();
    state.db ??= openDb(dbPathFor(g));
    return state.db;
  };

  program
    .name("afteraction")
    .description("See what your coding agent did: commands, files, tokens. 100% local.")
    .version(VERSION)
    .option("--db <path>", "database file", undefined)
    .option("--source <name=path>", "override a log location, e.g. claude=~/.claude/projects (repeatable)", parseSourceFlag, [])
    .option("--no-default-sources", "read only the sources given with --source or in the config file")
    .option("--config <path>", "config file (default ~/.afteraction/config.json)")
    .option("--port <n>", `web UI port (default ${DEFAULT_PORT})`, (v) => Number.parseInt(v, 10))
    .option("--no-open", "don't open the browser")
    .option("--demo", "show made-up sample sessions instead of your own logs (nothing is saved)")
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .action(async (opts: { port?: number; open: boolean; demo?: boolean }, cmd: Command) => {
      let db: Db;
      let demoDir: string | undefined;
      if (opts.demo) {
        ({ db, dir: demoDir } = await openDemo(state, io));
        opts.port ??= DEFAULT_PORT;
      } else {
        db = openFor(cmd);
        opts.port ??= loadConfig(cmd.optsWithGlobals<GlobalOpts>().config).port ?? DEFAULT_PORT;
        await runIngest(db, cmd.optsWithGlobals<GlobalOpts>(), false, io);
      }
      if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new CliError(`Invalid --port "${opts.port}"`);
      let server;
      try {
        server = await startServer({ db, port: opts.port, webRoot: webRoot(), version: VERSION, token: newToken() });
      } catch (e) {
        if ((e as { code?: string }).code === "EADDRINUSE") {
          throw new CliError(`Port ${opts.port} is in use (is afteraction already running?). Try --port ${opts.port + 1}.`);
        }
        throw e;
      }
      io.out(`Afteraction is running at ${server.url} (local only; the link carries this launch's access token). Press Ctrl+C to stop.`);
      if (opts.open) openBrowser(server.url);
      await new Promise<void>((resolve) => {
        const stop = () => {
          void server.close().then(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      if (demoDir) {
        db.close();
        state.db = undefined;
        rmSync(demoDir, { recursive: true, force: true });
      }
    });

  program
    .command("ingest")
    .description("read new and changed agent logs into the database")
    .option("--full", "re-parse every file, not just changed ones")
    .action(async (opts: { full?: boolean }, cmd: Command) => {
      await runIngest(openFor(cmd), cmd.optsWithGlobals<GlobalOpts>(), !!opts.full, io);
    });

  program
    .command("list")
    .description("list ingested sessions, newest first")
    .option("--since <when>", "only sessions active since, e.g. 7d, 24h, 2026-01-31")
    .option("--project <path>", "only sessions whose project path contains this")
    .addOption(new Option("--agent <name>", "only sessions from this agent").choices(Object.keys(ADAPTERS)))
    .addOption(new Option("--risk <level>", "only sessions at or above this risk").choices(RISKS))
    .option("--search <text>", "only sessions whose prompts, messages or commands match")
    .option("--limit <n>", "max rows", positiveInt, 50)
    .option("--json", "print JSON (secrets masked unless --reveal)")
    .option("--reveal", "show secrets instead of masking them")
    .action((opts: { since?: string; project?: string; agent?: string; risk?: RiskLevel; search?: string; limit: number; json?: boolean; reveal?: boolean }, cmd: Command) => {
      let rows;
      try {
        rows = listSessions(openFor(cmd), { ...opts, source: opts.agent ? ADAPTERS[opts.agent]!.id : undefined, q: opts.search });
      } catch (e) {
        throw new CliError(e instanceof Error ? e.message : String(e));
      }
      if (!opts.reveal) rows = maskDeep(rows);
      if (opts.json) return io.out(JSON.stringify(rows, null, 2));
      if (!rows.length) return io.out('No sessions found. Run "afteraction ingest" first, or loosen the filters.');
      io.out(
        table(
          ["STARTED", "AGENT", "PROJECT", "DURATION", "EVENTS", "TOKENS", "EST. COST", "RISK", "ID", "TITLE"],
          rows.map((s) => [
            fmtDateTime(s.started_at),
            AGENT_LABEL[s.source] ?? s.source,
            truncate(baseName(s.project_path), 24),
            fmtDuration(s.started_at, s.ended_at),
            String(s.event_count),
            fmtTokens(s.total_input_tokens + s.total_output_tokens + s.total_cache_read_tokens + s.total_cache_write_tokens),
            fmtCost(s.est_cost_usd),
            s.max_risk,
            s.id.replace(/^[a-z]+:/, "").slice(0, 8),
            truncate(s.title, 60),
          ]),
        ),
      );
      io.out("");
      io.out(costNote());
    });

  program
    .command("show")
    .description("print a session's timeline")
    .argument("<session-id>", "full id, uuid, a unique prefix, or \"latest\"")
    .option("--json", "print JSON: session, events, files (secrets masked unless --reveal)")
    .option("--reveal", "show secrets instead of masking them")
    .action((query: string, opts: { json?: boolean; reveal?: boolean }, cmd: Command) => {
      const d = openFor(cmd);
      const id = resolveSession(d, query);
      if (!id) throw new CliError(`No single session matches "${query}". Use "afteraction list" to see ids.`);
      const s = getSession(d, id)!;
      const events = getEvents(d, id);
      if (opts.json) {
        const all = { session: s, events, files: fileTouches(d, id) };
        return io.out(JSON.stringify(opts.reveal ? all : maskDeep(all), null, 2));
      }
      const files = fileTouches(d, id);
      const mask = (t: string) => (opts.reveal ? t : maskSecrets(t));
      const flagged = events.filter((e) => e.risk_level !== "none").length;
      const unpriced = JSON.parse(s.unpriced_models) as string[];
      io.out(mask(s.title));
      io.out(
        [
          `${AGENT_LABEL[s.source] ?? s.source} · ${s.model ?? "unknown model"}`,
          mask(`${s.project_path ?? "—"}${s.git_branch ? ` (${s.git_branch})` : ""}`),
          `${fmtDateTime(s.started_at)} → ${fmtDateTime(s.ended_at)} (${fmtDuration(s.started_at, s.ended_at)})`,
          `tokens: ${fmtTokens(s.total_input_tokens)} in · ${fmtTokens(s.total_output_tokens)} out · ` +
            `${fmtTokens(s.total_cache_read_tokens)} cache read · ${fmtTokens(s.total_cache_write_tokens)} cache write`,
          `est. cost: ${fmtCost(s.est_cost_usd)} (${COST_LABEL.toLowerCase()})` +
            (unpriced.length ? ` · no price for ${unpriced.join(", ")}` : ""),
          `risk: ${s.max_risk}${flagged ? ` (${flagged} flagged events)` : ""}`,
          `${events.length} events · ${files.length} files touched · id ${s.id}`,
        ].join("\n"),
      );
      io.out("");
      for (const e of events) {
        const nested = e.payload.subagent_id && e.kind !== "subagent_end" ? "  ↳ " : "";
        const failed = e.payload.is_error === true ? " ✗" : "";
        const risk = e.risk_level !== "none" ? `  ⚠ ${e.risk_level}: ${e.risk_rules.join(", ")}` : "";
        io.out(`${String(e.seq).padStart(4)}  ${fmtTime(e.ts)}  ${e.kind.padEnd(17)} ${nested}${mask(truncate(e.summary, 100))}${failed}${risk}`);
      }
    });

  program
    .command("tui")
    .alias("browse")
    .description("browse sessions full-screen in the terminal (j/k to move, r for the next risk)")
    .argument("[session-id]", "open this session directly: full id, uuid, a unique prefix, or \"latest\"")
    .option("--no-ingest", "skip reading new logs first")
    .action(async (query: string | undefined, opts: { ingest: boolean }, cmd: Command) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new CliError('"afteraction tui" needs an interactive terminal. Use "afteraction list" and "afteraction show" instead.');
      }
      const g = cmd.optsWithGlobals<GlobalOpts & { demo?: boolean }>();
      let d: Db;
      let demoDir: string | undefined;
      if (g.demo) ({ db: d, dir: demoDir } = await openDemo(state, io));
      else {
        d = openFor(cmd);
        if (opts.ingest) await runIngest(d, g, false, io);
      }
      let initialSessionId: string | undefined;
      if (query) {
        initialSessionId = resolveSession(d, query) ?? undefined;
        if (!initialSessionId) throw new CliError(`No single session matches "${query}". Use "afteraction list" to see ids.`);
      }
      const { runTui } = await import("./tui.js");
      try {
        await runTui({ sessions: () => listSessions(d), events: (id) => getEvents(d, id) }, { initialSessionId });
      } finally {
        if (demoDir) {
          d.close();
          state.db = undefined;
          rmSync(demoDir, { recursive: true, force: true });
        }
      }
    });

  program
    .command("risks")
    .description("list flagged events across sessions, grouped by rule")
    .option("--since <when>", "only events since, e.g. 7d, 24h, 2026-01-31")
    .addOption(new Option("--level <level>", "minimum severity").choices(RISKS.slice(1)).default("low"))
    .option("--reveal", "show secrets instead of masking them")
    .option("--json", "print JSON (secrets masked unless --reveal)")
    .action((opts: { since?: string; level: RiskLevel; reveal?: boolean; json?: boolean }, cmd: Command) => {
      let rows;
      try {
        rows = listRisks(openFor(cmd), { since: opts.since, level: opts.level });
      } catch (e) {
        throw new CliError(e instanceof Error ? e.message : String(e));
      }
      if (opts.json) return io.out(JSON.stringify(opts.reveal ? rows : maskDeep(rows), null, 2));
      if (!rows.length) return io.out("No flagged events.");
      const mask = (t: string) => (opts.reveal ? t : maskSecrets(t));
      for (const rule of RULES) {
        const hits = rows.filter((r) => r.risk_rules.includes(rule.id));
        if (!hits.length) continue;
        io.out(`${rule.severity.toUpperCase()}  ${rule.id} (${hits.length}) · ${rule.description}`);
        for (const h of hits.slice(0, 20)) {
          io.out(
            `  ${fmtDateTime(h.ts)}  ${h.session_id.replace(/^[a-z]+:/, "").slice(0, 8)}  ` +
              `${truncate(baseName(h.project_path), 18).padEnd(18)}  ${mask(truncate(h.summary, 90))}`,
          );
        }
        if (hits.length > 20) io.out(`  … and ${hits.length - 20} more (use --json for all)`);
        io.out("");
      }
      io.out(`${rows.length} flagged events. Rules are heuristics: check each hit before acting on it.`);
    });

  program
    .command("receipt")
    .description("Markdown summary of a session for a PR comment (secrets and home paths redacted)")
    .argument("<session-id>", "full id, uuid, a unique prefix, or \"latest\"")
    .option("-o, --output <file>", "write to a file instead of stdout")
    .option("--no-redact", "keep secrets and home-directory paths")
    .action((query: string, opts: { output?: string; redact: boolean }, cmd: Command) => {
      const d = openFor(cmd);
      const id = resolveSession(d, query);
      if (!id) throw new CliError(`No single session matches "${query}". Use "afteraction list" to see ids.`);
      const md = buildReceipt(getSession(d, id)!, getEvents(d, id), { version: VERSION, redact: opts.redact });
      if (opts.output) {
        writeFileSync(opts.output, md, "utf8");
        io.out(`Receipt written to ${opts.output}`);
      } else {
        io.out(md.trimEnd());
      }
    });

  program
    .command("purge")
    .description("delete stored sessions (your agents' own log files are never touched)")
    .option("--before <when>", "only sessions that ended before this, e.g. 30d or 2026-01-31 (default: all)")
    .option("--yes", "actually delete; without it, only report what would go")
    .action((opts: { before?: string; yes?: boolean }, cmd: Command) => {
      const d = openFor(cmd);
      let cutoff: string | undefined;
      try {
        cutoff = opts.before ? parseSince(opts.before) : undefined;
      } catch (e) {
        throw new CliError(e instanceof Error ? e.message.replace("--since", "--before") : String(e));
      }
      const matching = listSessions(d).filter((s) => !cutoff || (s.ended_at ?? s.started_at ?? "") < cutoff);
      const what = `${matching.length} sessions (${matching.reduce((a, s) => a + s.event_count, 0)} events)` +
        (cutoff ? ` that ended before ${cutoff.slice(0, 10)}` : "");
      if (!opts.yes) {
        io.out(`Would delete ${what} from the afteraction database. Re-run with --yes to delete.`);
        return;
      }
      const r = purgeSessions(d, { before: cutoff });
      io.out(`Deleted ${r.sessions} sessions (${r.events} events). Unchanged logs stay out until "afteraction ingest --full".`);
    });

  program
    .command("doctor")
    .description("show discovered log sources, stored counts and parse warnings")
    .action(async (_opts, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const dbPath = dbPathFor(g);
      io.out(`afteraction ${VERSION} · node ${process.versions.node} · ${process.platform}`);
      io.out("");
      io.out("Sources:");
      for (const { adapter, root } of sourcesFrom(g)) {
        const dir = root ?? adapter.defaultRoot();
        const files = await adapter.discover(dir);
        const status = existsSync(dir) ? `${files.length} session files` : "not found";
        io.out(`  ${adapter.id.padEnd(12)} ${dir}  (${status}; tested with ${adapter.testedVersions.join("–")})`);
      }
      io.out("");
      io.out(`Database: ${dbPath}`);
      const d = openFor(cmd);
      const counts = sourceCounts(d);
      if (!counts.length) io.out('  empty: run "afteraction ingest"');
      for (const c of counts) io.out(`  ${c.source.padEnd(12)} ${c.sessions} sessions · ${c.events} events`);
      const w = warningSummary(d, 10);
      io.out("");
      io.out(`Parse warnings: ${w.total}`);
      for (const f of w.byFile.slice(0, 10)) io.out(`  ${String(f.count).padStart(5)}  ${f.source_file}`);
      if (w.sample.length) {
        io.out("  first warnings:");
        for (const s of w.sample) io.out(maskSecrets(`    ${s.file}:${s.line ?? "?"} ${s.message}`));
      }
    });

  return program;
}

export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  const state: CliState = {};
  const program = buildProgram(io, state);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`error: ${e.message}`);
      return 1;
    }
    const code = (e as { code?: string; exitCode?: number }).code;
    if (typeof code === "string" && code.startsWith("commander.")) {
      // commander already printed help/version/usage errors
      return (e as { exitCode?: number }).exitCode ?? 1;
    }
    io.err(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return 1;
  } finally {
    state.db?.close();
  }
}
