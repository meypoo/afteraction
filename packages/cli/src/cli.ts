import { Command, InvalidArgumentError, Option } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ADAPTERS,
  buildReceipt,
  COST_LABEL,
  defaultDbPath,
  listRisks,
  loadPrices,
  maskSecrets,
  RULES,
  fileTouches,
  getEvents,
  getSession,
  ingest,
  listSessions,
  openDb,
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
} from "@flightrec/core";


export const VERSION = "0.1.0";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
};

/** Thrown for user errors; the message is printed without a stack trace. */
export class CliError extends Error {}

interface GlobalOpts {
  db?: string;
  source: string[];
}

function parseSourceFlag(value: string, prev: string[]): string[] {
  const m = /^([a-z_]+)=(.+)$/.exec(value);
  if (!m || !ADAPTERS[m[1]!]) {
    throw new InvalidArgumentError(`expected name=path with name one of: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return [...prev, value];
}

function sourcesFrom(opts: GlobalOpts): SourceConfig[] {
  const expandHome = (p: string) => (p === "~" || /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);
  const overrides = new Map(opts.source.map((s) => [s.slice(0, s.indexOf("=")), expandHome(s.slice(s.indexOf("=") + 1))]));
  return Object.entries(ADAPTERS).map(([name, adapter]) => ({ adapter, root: overrides.get(name) }));
}

const MAX_PRINTED_WARNINGS = 20;

async function runIngest(db: Db, opts: GlobalOpts, full: boolean, io: Io): Promise<IngestReport> {
  let printed = 0;
  const report = await ingest(db, {
    sources: sourcesFrom(opts),
    full,
    onWarning: (w) => {
      if (printed++ < MAX_PRINTED_WARNINGS) io.err(`warning: ${w.file}:${w.line ?? "?"} ${w.message}`);
    },
    onError: (file, err) => io.err(`error: could not ingest ${file}: ${err instanceof Error ? err.message : String(err)}`),
  });
  if (report.warnings > MAX_PRINTED_WARNINGS) {
    io.err(`… and ${report.warnings - MAX_PRINTED_WARNINGS} more warnings (see "flightrec doctor")`);
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

const AGENT_LABEL: Record<string, string> = { claude_code: "Claude Code", codex: "Codex" };

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

export function buildProgram(io: Io = defaultIo, state: CliState = {}): Command {
  const program = new Command();
  const openFor = (cmd: Command): Db => {
    const g = cmd.optsWithGlobals<GlobalOpts>();
    state.db ??= openDb(g.db ?? defaultDbPath());
    return state.db;
  };

  program
    .name("flightrec")
    .description("See what your coding agent did: commands, files, tokens. 100% local.")
    .version(VERSION)
    .option("--db <path>", "database file", undefined)
    .option("--source <name=path>", "override a log location, e.g. claude=~/.claude/projects (repeatable)", parseSourceFlag, [])
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .action(async (_opts, cmd: Command) => {
      await runIngest(openFor(cmd), cmd.optsWithGlobals<GlobalOpts>(), false, io);
      io.out('The web UI is not built yet (milestone M3). Try "flightrec list" or "flightrec show <id>".');
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
    .addOption(new Option("--risk <level>", "only sessions at or above this risk").choices(RISKS))
    .option("--limit <n>", "max rows", (v) => Number.parseInt(v, 10), 50)
    .option("--json", "print JSON")
    .action((opts: { since?: string; project?: string; risk?: RiskLevel; limit: number; json?: boolean }, cmd: Command) => {
      let rows;
      try {
        rows = listSessions(openFor(cmd), opts);
      } catch (e) {
        throw new CliError(e instanceof Error ? e.message : String(e));
      }
      if (opts.json) return io.out(JSON.stringify(rows, null, 2));
      if (!rows.length) return io.out('No sessions found. Run "flightrec ingest" first, or loosen the filters.');
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
    .argument("<session-id>", "full id, uuid, or a unique prefix")
    .option("--json", "print JSON (session, events, files)")
    .option("--reveal", "show secrets instead of masking them")
    .action((query: string, opts: { json?: boolean; reveal?: boolean }, cmd: Command) => {
      const d = openFor(cmd);
      const id = resolveSession(d, query);
      if (!id) throw new CliError(`No single session matches "${query}". Use "flightrec list" to see ids.`);
      const s = getSession(d, id)!;
      const events = getEvents(d, id);
      if (opts.json) return io.out(JSON.stringify({ session: s, events, files: fileTouches(d, id) }, null, 2));
      const files = fileTouches(d, id);
      const mask = (t: string) => (opts.reveal ? t : maskSecrets(t));
      const flagged = events.filter((e) => e.risk_level !== "none").length;
      const unpriced = JSON.parse(s.unpriced_models) as string[];
      io.out(mask(s.title));
      io.out(
        [
          `${AGENT_LABEL[s.source] ?? s.source} · ${s.model ?? "unknown model"}`,
          `${s.project_path ?? "—"}${s.git_branch ? ` (${s.git_branch})` : ""}`,
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
    .command("risks")
    .description("list flagged events across sessions, grouped by rule")
    .option("--since <when>", "only events since, e.g. 7d, 24h, 2026-01-31")
    .addOption(new Option("--level <level>", "minimum severity").choices(RISKS.slice(1)).default("low"))
    .option("--reveal", "show secrets instead of masking them")
    .option("--json", "print JSON")
    .action((opts: { since?: string; level: RiskLevel; reveal?: boolean; json?: boolean }, cmd: Command) => {
      let rows;
      try {
        rows = listRisks(openFor(cmd), { since: opts.since, level: opts.level });
      } catch (e) {
        throw new CliError(e instanceof Error ? e.message : String(e));
      }
      if (opts.json) return io.out(JSON.stringify(rows, null, 2));
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
    .argument("<session-id>", "full id, uuid, or a unique prefix")
    .option("-o, --output <file>", "write to a file instead of stdout")
    .option("--no-redact", "keep secrets and home-directory paths")
    .action((query: string, opts: { output?: string; redact: boolean }, cmd: Command) => {
      const d = openFor(cmd);
      const id = resolveSession(d, query);
      if (!id) throw new CliError(`No single session matches "${query}". Use "flightrec list" to see ids.`);
      const md = buildReceipt(getSession(d, id)!, getEvents(d, id), { version: VERSION, redact: opts.redact });
      if (opts.output) {
        writeFileSync(opts.output, md, "utf8");
        io.out(`Receipt written to ${opts.output}`);
      } else {
        io.out(md.trimEnd());
      }
    });

  program
    .command("doctor")
    .description("show discovered log sources, stored counts and parse warnings")
    .action(async (_opts, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOpts>();
      const dbPath = g.db ?? defaultDbPath();
      io.out(`flightrec ${VERSION} · node ${process.versions.node} · ${process.platform}`);
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
      if (!counts.length) io.out('  empty: run "flightrec ingest"');
      for (const c of counts) io.out(`  ${c.source.padEnd(12)} ${c.sessions} sessions · ${c.events} events`);
      const w = warningSummary(d, 10);
      io.out("");
      io.out(`Parse warnings: ${w.total}`);
      for (const f of w.byFile.slice(0, 10)) io.out(`  ${String(f.count).padStart(5)}  ${f.source_file}`);
      if (w.sample.length) {
        io.out("  first warnings:");
        for (const s of w.sample) io.out(`    ${s.file}:${s.line ?? "?"} ${s.message}`);
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
