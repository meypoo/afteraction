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
export { geminiCliAdapter, defaultGeminiRoot } from "./adapters/gemini-cli.js";
export { cursorAdapter, defaultCursorRoot } from "./adapters/cursor.js";
export { copilotAdapter, defaultVscodeRoot, replayChatLog } from "./adapters/copilot.js";
export { clineAdapter, defaultClineRoot } from "./adapters/cline.js";
export { aiderAdapter, defaultAiderRoot } from "./adapters/aider.js";
export { continueAdapter, defaultContinueRoot } from "./adapters/continue.js";

import { claudeCodeAdapter } from "./adapters/claude-code.js";
import { codexAdapter } from "./adapters/codex.js";
import { antigravityAdapter } from "./adapters/antigravity.js";
import { opencodeAdapter } from "./adapters/opencode.js";
import { geminiCliAdapter } from "./adapters/gemini-cli.js";
import { cursorAdapter } from "./adapters/cursor.js";
import { copilotAdapter } from "./adapters/copilot.js";
import { clineAdapter } from "./adapters/cline.js";
import { aiderAdapter } from "./adapters/aider.js";
import { continueAdapter } from "./adapters/continue.js";
import type { SourceAdapter } from "./model.js";

/** Adapters by the name used in `--source name=path`. */
export const ADAPTERS: Record<string, SourceAdapter> = {
  claude: claudeCodeAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
  opencode: opencodeAdapter,
  gemini: geminiCliAdapter,
  cursor: cursorAdapter,
  copilot: copilotAdapter,
  cline: clineAdapter,
  aider: aiderAdapter,
  continue: continueAdapter,
};
