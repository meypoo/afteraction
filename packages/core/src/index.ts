export * from "./model.js";
export * from "./db.js";
export * from "./ingest.js";
export { claudeCodeAdapter, defaultClaudeRoot } from "./adapters/claude-code.js";

import { claudeCodeAdapter } from "./adapters/claude-code.js";
import type { SourceAdapter } from "./model.js";

/** Adapters by the name used in `--source name=path`. */
export const ADAPTERS: Record<string, SourceAdapter> = {
  claude: claudeCodeAdapter,
};
