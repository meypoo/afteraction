// Incremental ingestion: discover files, skip unchanged ones, re-parse the rest.
import { createHash } from "node:crypto";
import { eventCost, loadPrices, sessionCost, type Prices } from "./cost.js";
import { getEvents, getFingerprint, getMeta, listSessions, replaceSession, setMeta, updateDerived, type Db } from "./db.js";
import type { NormalizedEvent, ParseWarning, Session, SourceAdapter } from "./model.js";
import { applyRisks, RULES } from "./risk.js";

export interface SourceConfig {
  adapter: SourceAdapter;
  /** Overrides the adapter's default location. */
  root?: string;
}

export interface IngestOptions {
  sources: SourceConfig[];
  /** Re-parse every file even if unchanged. */
  full?: boolean;
  /** Price table; defaults to the bundled prices.json. */
  prices?: Prices;
  onWarning?: (w: ParseWarning) => void;
  onError?: (file: string, err: unknown) => void;
}

export interface IngestReport {
  filesSeen: number;
  filesParsed: number;
  filesSkipped: number;
  filesFailed: number;
  sessions: number;
  events: number;
  warnings: number;
  /** Sessions whose risk flags and costs were recomputed because rules or prices changed. */
  recomputed: number;
  ms: number;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex");

/** Changes whenever a rule is added, removed or edited. */
export const RULES_HASH = hash(RULES.map((r) => `${r.id}:${r.severity}:${r.match.toString()}`).join("\n"));

// Changed files are re-parsed whole. Byte-offset appends (SPEC §11) are a later optimisation:
// tool results arrive lines after their calls, so partial parses need carried-over state.
export async function ingest(db: Db, opts: IngestOptions): Promise<IngestReport> {
  const started = Date.now();
  const prices = opts.prices ?? loadPrices();
  const pricesHash = hash(JSON.stringify(prices));
  const report: IngestReport = {
    filesSeen: 0, filesParsed: 0, filesSkipped: 0, filesFailed: 0, sessions: 0, events: 0, warnings: 0, recomputed: 0, ms: 0,
  };
  for (const { adapter, root } of opts.sources) {
    const files = await adapter.discover(root ?? adapter.defaultRoot());
    for (const file of files) {
      report.filesSeen++;
      try {
        const fingerprint = await adapter.fingerprint(file);
        if (!opts.full && getFingerprint(db, file) === fingerprint) {
          report.filesSkipped++;
          continue;
        }
        const events: NormalizedEvent[] = [];
        const warnings: ParseWarning[] = [];
        let session: Session | null = null;
        for await (const rec of adapter.parse(file)) {
          if (rec.type === "event") events.push(rec.event);
          else if (rec.type === "session") session = rec.session;
          else {
            warnings.push(rec.warning);
            opts.onWarning?.(rec.warning);
          }
        }
        applyRisks(events, session);
        for (const e of events) e.est_cost_usd = eventCost(e, prices).usd;
        const cost = sessionCost(events, prices);
        if (session) session.est_cost_usd = cost.usd;
        replaceSession(db, { sourceFile: file, source: adapter.id, fingerprint, session, events, warnings, unpricedModels: cost.unpricedModels });
        report.filesParsed++;
        if (session) report.sessions++;
        report.events += events.length;
        report.warnings += warnings.length;
      } catch (err) {
        // A file we cannot read (permissions, deleted mid-run) must not stop the rest.
        report.filesFailed++;
        opts.onError?.(file, err);
      }
    }
  }

  // New rules or prices apply to sessions already stored, without re-reading their logs.
  if (getMeta(db, "rules_hash") !== RULES_HASH || getMeta(db, "prices_hash") !== pricesHash) {
    report.recomputed = recomputeDerived(db, prices);
    setMeta(db, "rules_hash", RULES_HASH);
    setMeta(db, "prices_hash", pricesHash);
  }
  report.ms = Date.now() - started;
  return report;
}

export function recomputeDerived(db: Db, prices: Prices): number {
  let n = 0;
  for (const s of listSessions(db)) {
    const events = getEvents(db, s.id);
    applyRisks(events, s);
    for (const e of events) e.est_cost_usd = eventCost(e, prices).usd;
    const cost = sessionCost(events, prices);
    updateDerived(db, s.id, events, { max_risk: s.max_risk, est_cost_usd: cost.usd, unpriced_models: cost.unpricedModels });
    n++;
  }
  return n;
}
