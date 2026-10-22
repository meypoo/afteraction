// Incremental ingestion: discover files, skip unchanged ones, re-parse the rest.
import { getFingerprint, replaceSession, type Db } from "./db.js";
import type { NormalizedEvent, ParseWarning, Session, SourceAdapter } from "./model.js";

export interface SourceConfig {
  adapter: SourceAdapter;
  /** Overrides the adapter's default location. */
  root?: string;
}

export interface IngestOptions {
  sources: SourceConfig[];
  /** Re-parse every file even if unchanged. */
  full?: boolean;
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
  ms: number;
}

// Changed files are re-parsed whole. Byte-offset appends (SPEC §11) are a later optimisation:
// tool results arrive lines after their calls, so partial parses need carried-over state.
export async function ingest(db: Db, opts: IngestOptions): Promise<IngestReport> {
  const started = Date.now();
  const report: IngestReport = {
    filesSeen: 0, filesParsed: 0, filesSkipped: 0, filesFailed: 0, sessions: 0, events: 0, warnings: 0, ms: 0,
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
        replaceSession(db, { sourceFile: file, source: adapter.id, fingerprint, session, events, warnings });
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
  report.ms = Date.now() - started;
  return report;
}
