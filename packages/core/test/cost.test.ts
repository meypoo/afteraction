import { describe, expect, it } from "vitest";
import { eventCost, loadPrices, priceFor, sessionCost, type Prices } from "../src/cost.js";
import type { NormalizedEvent } from "../src/model.js";

const prices = loadPrices();
const M = 1_000_000;

function ev(model: string | null, t: Partial<Pick<NormalizedEvent, "tokens_in" | "tokens_out" | "cache_read" | "cache_write" | "usage_extra">>): NormalizedEvent {
  return {
    id: "s:0", session_id: "s", seq: 0, ts: null, kind: "assistant_message", summary: "", payload: {}, raw: null,
    tokens_in: t.tokens_in ?? 0, tokens_out: t.tokens_out ?? 0, cache_read: t.cache_read ?? 0, cache_write: t.cache_write ?? 0,
    usage_extra: t.usage_extra ?? null, model, risk_level: "none", risk_rules: [],
  };
}

describe("prices.json", () => {
  it("has a last_updated date and complete numbers for every model", () => {
    expect(prices.last_updated).toMatch(/^\d{4}-\d\d-\d\d$/);
    for (const [model, p] of Object.entries(prices.models)) {
      for (const k of ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"] as const) {
        expect(p[k], `${model}.${k}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("priceFor", () => {
  it("matches exact ids and dated snapshots, nothing else", () => {
    expect(priceFor("claude-opus-5-5", prices)).toBe(prices.models["claude-opus-5-5"]);
    expect(priceFor("claude-haiku-4-5-20251001", prices)).toBe(prices.models["claude-haiku-4-5"]);
    expect(priceFor("claude-opus-5-5-fancy", prices)).toBeNull();
    expect(priceFor("gpt-5", prices)).toBeNull();
    expect(priceFor(null, prices)).toBeNull();
  });
});

describe("eventCost", () => {
  it("prices input, output, cache read and 5m cache writes", () => {
    expect(eventCost(ev("claude-opus-5-5", { tokens_in: M, tokens_out: M, cache_read: M, cache_write: M }), prices).usd).toBeCloseTo(4 + 20 + 0.2 + 5);
  });

  it("splits cache writes into 5m and 1h", () => {
    const e = ev("claude-opus-5-5", { cache_write: M, usage_extra: { cache_write_1h: 400_000 } });
    expect(eventCost(e, prices).usd).toBeCloseTo(0.6 * 5 + 0.4 * 8);
  });

  it("uses long-prompt rates when a Haiku 5.5 request is over the threshold", () => {
    const short = ev("claude-haiku-5-5", { tokens_in: 50_000, tokens_out: 1000 });
    const long = ev("claude-haiku-5-5", { tokens_in: 20_000, cache_read: 90_000, tokens_out: 1000 });
    expect(eventCost(short, prices).usd).toBeCloseTo((50_000 * 0.1 + 1000 * 0.5) / M);
    expect(eventCost(long, prices).usd).toBeCloseTo((20_000 * 0.5 + 90_000 * 0.05 + 1000 * 2.5) / M);
  });

  it("applies fast mode, US inference and web search charges", () => {
    const fast = ev("claude-opus-5-5", { tokens_in: M, tokens_out: M, cache_read: M, usage_extra: { speed: "fast" } });
    expect(eventCost(fast, prices).usd).toBeCloseTo(8 + 40 + 0.2 * 2); // cache multipliers stack on fast prices
    const us = ev("claude-sonnet-5-5", { tokens_in: M, usage_extra: { inference_geo: "us" } });
    expect(eventCost(us, prices).usd).toBeCloseTo(2 * 1.1);
    const web = ev("claude-sonnet-5-5", { usage_extra: { web_search_requests: 3 } });
    expect(eventCost(web, prices).usd).toBeCloseTo(0.03);
  });

  it("returns null for unknown models and for fast mode without fast prices", () => {
    expect(eventCost(ev("mystery-model", { tokens_in: 10 }), prices)).toEqual({ usd: null, unpricedModel: "mystery-model" });
    expect(eventCost(ev("claude-sonnet-5-5", { tokens_in: 10, usage_extra: { speed: "fast" } }), prices).usd).toBeNull();
  });

  it("treats events without tokens as free regardless of model", () => {
    expect(eventCost(ev("<synthetic>", {}), prices)).toEqual({ usd: 0 });
  });
});

describe("sessionCost", () => {
  it("sums priced events", () => {
    const r = sessionCost([ev("claude-opus-5-5", { tokens_in: M }), ev("claude-sonnet-5-5", { tokens_out: M })], prices);
    expect(r.usd).toBeCloseTo(4 + 10);
    expect(r.unpricedModels).toEqual([]);
  });

  it("is null (never a guess) when any event with tokens uses an unpriced model", () => {
    const r = sessionCost([ev("claude-opus-5-5", { tokens_in: M }), ev("mystery", { tokens_out: 5 }), ev("<synthetic>", {})], prices);
    expect(r).toEqual({ usd: null, unpricedModels: ["mystery"] });
  });

  it("uses a custom price table", () => {
    const custom: Prices = { ...prices, models: { "m-1": { input: 1, output: 2, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 } } };
    expect(sessionCost([ev("m-1", { tokens_in: M, tokens_out: M })], custom).usd).toBeCloseTo(3);
  });
});
