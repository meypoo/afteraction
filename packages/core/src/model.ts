// Normalized event model shared by every adapter (SPEC.md §5).

export type SourceId = "claude_code" | "codex";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export const EVENT_KINDS = [
  "user_message",
  "assistant_message",
  "thinking",
  "tool_call",
  "tool_result",
  "shell_command",
  "file_read",
  "file_write",
  "file_edit",
  "web_fetch",
  "subagent_start",
  "subagent_end",
  "error",
  "unknown",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export interface Session {
  id: string;
  source: SourceId;
  project_path: string | null;
  git_branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  model: string | null;
  title: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  est_cost_usd: number | null;
  max_risk: RiskLevel;
  source_file: string;
  source_hash: string;
}

export interface NormalizedEvent {
  id: string;
  session_id: string;
  seq: number;
  ts: string | null;
  kind: EventKind;
  summary: string;
  payload: Record<string, unknown>;
  raw: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Billing details beyond the four token counts; only set where the log has them. */
  usage_extra: UsageExtra | null;
  model: string | null;
  risk_level: RiskLevel;
  risk_rules: string[];
}

export interface UsageExtra {
  /** Part of cache_write that went to the 1-hour cache (priced higher than 5-minute). */
  cache_write_1h?: number;
  web_search_requests?: number;
  speed?: string;
  inference_geo?: string;
}

export interface ParseWarning {
  file: string;
  line: number | null;
  message: string;
}

export type NormalizedRecord =
  | { type: "event"; event: NormalizedEvent }
  | { type: "warning"; warning: ParseWarning }
  | { type: "session"; session: Session };

export interface SourceAdapter {
  id: SourceId;
  /** Format versions this adapter was tested against. */
  testedVersions: string[];
  /** Default location searched when no root is given. */
  defaultRoot(): string;
  discover(root?: string): Promise<string[]>;
  parse(file: string): AsyncIterable<NormalizedRecord>;
  /** Cheap value that changes whenever the file (or anything parse() reads with it) changes. */
  fingerprint(file: string): Promise<string>;
}

/** Excerpts stored in payloads are capped to keep the DB small; full data stays in `raw`. */
export const EXCERPT_BYTES = 4096;

export function excerpt(text: unknown, max = EXCERPT_BYTES): string | undefined {
  if (typeof text !== "string") return undefined;
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  // Cut on a character boundary, then mark the truncation.
  let cut = text.slice(0, max);
  while (Buffer.byteLength(cut, "utf8") > max) cut = cut.slice(0, -1);
  return cut + "…[truncated]";
}

export function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
