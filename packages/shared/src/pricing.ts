/**
 * The price table, keyed by the `engine` string itself so a stored attempt looks its own price up
 * with no mapping layer in between - ADR-11.
 *
 * Rules that make the cost column trustworthy rather than decorative:
 *
 * - A price that is still `null` yields `costEstimateUsd: null`, never `0`. An unknown cost must not
 *   render as a free one.
 * - Numbers are read off the provider's public pricing page at implementation time, never written
 *   from memory, and each entry records the URL and the date it was read.
 * - Filling in a price bumps {@link PRICING_VERSION} to that retrieval date, because a version that
 *   covers two different price sets identifies nothing.
 * - Free tiers are ignored on purpose. The estimate answers "what would this cost at scale", which
 *   is the decision the benchmark informs.
 */

/**
 * Bumped to the retrieval date (`YYYY-MM-DD`) by whichever phase fills a price in. `"unset"` means
 * no real price has been recorded yet - phases 08 and 09 change this.
 */
export const PRICING_VERSION = 'unset';

export type PriceUnit = 'on-device' | 'self-hosted' | 'per-1000-images' | 'per-1M-tokens';

export interface PriceEntry {
  readonly unit: PriceUnit;
  /** Flat price per unit. `null` while unknown. Not used by token-priced entries. */
  readonly usd: number | null;
  /** Token pricing, for `per-1M-tokens` entries only. */
  readonly inputUsd?: number | null;
  readonly outputUsd?: number | null;
  /** URL of the pricing page the figure came from. `null` while the price is unknown. */
  readonly source: string | null;
  /** ISO date the figure was read. `null` while the price is unknown. */
  readonly retrieved: string | null;
  readonly notes?: string;
}

export const pricing: Readonly<Record<string, PriceEntry>> = {
  mlkit: {
    unit: 'on-device',
    usd: 0,
    source: null,
    retrieved: null,
    notes: 'Runs on the handset; no per-call cost exists to look up.',
  },
  'onnx-paddleocr': {
    unit: 'self-hosted',
    usd: 0,
    source: null,
    retrieved: null,
    notes: 'Marginal cost only; the VPS is a sunk cost. Not a claim that the method is free.',
  },
  'onnx-paddleocr-cyrillic': {
    unit: 'self-hosted',
    usd: 0,
    source: null,
    retrieved: null,
    notes: 'As above.',
  },
  'gcv:builtin/stable': {
    unit: 'per-1000-images',
    usd: null,
    source: null,
    retrieved: null,
    notes: 'Filled in by phase 08 from the Cloud Vision pricing page. Free tier ignored.',
  },
  // Phase 09 adds one entry per model actually used, under the exact engine string, e.g.
  // 'vlm:openai/<model>': { unit: 'per-1M-tokens', usd: null, inputUsd: …, outputUsd: …, … }
};

/** `undefined` when the engine has no entry at all, which is a different thing from an unknown price. */
export function getPriceEntry(engine: string): PriceEntry | undefined {
  return pricing[engine];
}
