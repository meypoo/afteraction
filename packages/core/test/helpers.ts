import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { NormalizedEvent, ParseWarning, Session, SourceAdapter } from "../src/model.js";

export const FIXTURES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

export async function collect(adapter: SourceAdapter, file: string) {
  const events: NormalizedEvent[] = [];
  const warnings: ParseWarning[] = [];
  const sessions: Session[] = [];
  for await (const rec of adapter.parse(file)) {
    if (rec.type === "event") events.push(rec.event);
    else if (rec.type === "warning") warnings.push(rec.warning);
    else sessions.push(rec.session);
  }
  return { events, warnings, sessions };
}

/** Normalized output without `raw` or machine-specific fields, compared with a file next to the fixture. */
export async function expectSnapshot(adapter: SourceAdapter, file: string, snapshotFile: string) {
  const { events, sessions } = await collect(adapter, file);
  const snapshot = {
    session: { ...sessions[0], source_file: "<fixture>", source_hash: "<hash>" },
    events: events.map(({ raw: _raw, ...rest }) => rest),
  };
  await expect(JSON.stringify(snapshot, null, 2) + "\n").toMatchFileSnapshot(snapshotFile);
}
