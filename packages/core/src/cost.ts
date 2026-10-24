// Cost estimation from token counts and prices.json (SPEC.md §7).
// Always "estimated, API-equivalent": subscription users do not pay per token.
import { readFileSync } from "node:fs";
import type { NormalizedEvent, UsageExtra } from "./model.js";

export const COST_LABEL = "Estimated, API-equivalent pricing";

export interface Rates {
  input: number;
  output: number;
  cache_read: number;
  /** Short-lived cache writes: Anthropic's 5-minute cache, OpenAI's 30-minute cache. */
  cache_write_5m: number;
  /** Long-lived cache writes: Anthropic's 1-hour cache, OpenAI's 12-hour cache. */
  cache_write_1h: number;
}

export interface ModelPrice extends Rates {
  /** Fast-mode input/output rates; cache prices scale with them. */
  fast?: { input: number; output: number };
  /** Higher rates for requests whose prompt (input + cache read + cache write) exceeds over_tokens. */
  long_prompt?: Rates & { over_tokens: number };
}

export interface Prices {
  last_updated: string;
  confirmed: boolean;
  source: string;
  web_search_per_1k: number;
  us_inference_geo_multiplier: number;
  models: Record<string, ModelPrice>;
}

const DEFAULT_PRICES = new URL("../prices.json", import.meta.url);

export function loadPrices(file: string | URL = DEFAULT_PRICES): Prices {
  return JSON.parse(readFileSync(file, "utf8")) as Prices;
}

/** Exact model id, or a dated snapshot of one (claude-haiku-4-5-20251001 → claude-haiku-4-5). */
export function priceFor(model: string | null, prices: Prices): ModelPrice | null {
  if (!model) return null;
  return prices.models[model] ?? prices.models[model.replace(/-\d{8}$/, "")] ?? null;
}

const n = (v: number | null | undefined) => (typeof v === "number" && v > 0 ? v : 0);

export interface EventCost {
  usd: number | null;
  unpricedModel?: string;
}

type Billable = Pick<NormalizedEvent, "model" | "tokens_in" | "tokens_out" | "cache_read" | "cache_write" | "usage_extra">;

export function eventCost(e: Billable, prices: Prices): EventCost {
  const x: UsageExtra = e.usage_extra ?? {};
  const input = n(e.tokens_in);
  const output = n(e.tokens_out);
  const read = n(e.cache_read);
  const write = n(e.cache_write);
  const write1h = Math.min(n(x.cache_write_1h), write);
  const searches = n(x.web_search_requests);
  if (input + output + read + write + searches === 0) return { usd: 0 };

  const p = priceFor(e.model, prices);
  if (!p) return { usd: null, unpricedModel: e.model ?? "(unknown)" };

  let r: Rates = p;
  if (p.long_prompt && input + read + write > p.long_prompt.over_tokens) r = p.long_prompt;
  let scale = 1; // cache prices follow the input price
  let outRate = r.output;
  if (x.speed === "fast") {
    if (!p.fast) return { usd: null, unpricedModel: `${e.model} (fast)` };
    scale = p.fast.input / p.input;
    outRate = p.fast.output;
  }
  let usd =
    (input * r.input * scale +
      output * outRate +
      read * r.cache_read * scale +
      (write - write1h) * r.cache_write_5m * scale +
      write1h * r.cache_write_1h * scale) /
    1_000_000;
  if (x.inference_geo === "us") usd *= prices.us_inference_geo_multiplier;
  usd += (searches * prices.web_search_per_1k) / 1000;
  return { usd };
}

export interface SessionCost {
  usd: number | null;
  unpricedModels: string[];
}

/** Shown as the "model" when a log records no token usage at all (e.g. Antigravity): cost is unknown, not $0. */
export const NO_USAGE = "(no token usage in log)";

export function sessionCost(events: Billable[], prices: Prices): SessionCost {
  const hasUsage = events.some((e) => [e.tokens_in, e.tokens_out, e.cache_read, e.cache_write].some((t) => t !== null));
  if (events.length > 0 && !hasUsage) return { usd: null, unpricedModels: [NO_USAGE] };
  let usd = 0;
  const unpriced = new Set<string>();
  for (const e of events) {
    const c = eventCost(e, prices);
    if (c.usd === null) unpriced.add(c.unpricedModel!);
    else usd += c.usd;
  }
  return unpriced.size ? { usd: null, unpricedModels: [...unpriced].sort() } : { usd, unpricedModels: [] };
}
