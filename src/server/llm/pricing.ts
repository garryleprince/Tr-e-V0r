/**
 * Prices in USD per million tokens, used to enforce the daily LLM budget.
 * Anthropic list prices as of 2026-06-24 (first-party API). A model missing from
 * the table is costed at the most expensive known rate, so the budget can only
 * be over-counted, never under-counted.
 */

export interface ModelPrice {
  readonly input: number;
  readonly output: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const FALLBACK_PRICE: ModelPrice = { input: 10, output: 50 };

export interface TokenCounts {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

export function costUsd(model: string, t: TokenCounts): { cost: number; estimated: boolean } {
  const known = MODEL_PRICES[model];
  const p = known ?? FALLBACK_PRICE;
  const cost =
    (t.input * p.input + t.cacheWrite * p.input * 1.25 + t.cacheRead * p.input * 0.1 + t.output * p.output) / 1_000_000;
  return { cost, estimated: known === undefined };
}
