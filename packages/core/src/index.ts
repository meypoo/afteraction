export * from "./model.js";
export * from "./db.js";
export * from "./ingest.js";
export * from "./format.js";
export * from "./risk.js";
export * from "./cost.js";
export * from "./receipt.js";
export { claudeCodeAdapter, defaultClaudeRoot } from "./adapters/claude-code.js";
export { codexAdapter, defaultCodexRoot, parseApplyPatch } from "./adapters/codex.js";
export { antigravityAdapter, defaultAntigravityRoot, readAntigravitySummaries } from "./adapters/antigravity.js";
export { opencodeAdapter, defaultOpencodeRoot } from "./adapters/opencode.js";

import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { antigravityAdapter } from "./adapters/antigravity.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import type { SourceAdapter } from "./model.js";

/** Adapters by the name used in `--source name=path`. */
export const ADAPTERS: Record<string, SourceAdapter> = {
  claude: claudeCodeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
  opencode: opencodeAdapter,
};
