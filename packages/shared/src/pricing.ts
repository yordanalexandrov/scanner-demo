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
 *
 * `2026-08-03` is the date the Cloud Vision figure below was read. Attempts recorded before phase 08
 * carry `"unset"`, and that is the point of the field: the two sets were priced by different tables
 * and a single version covering both would identify neither.
 */
export const PRICING_VERSION = '2026-08-03';

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
    // DOCUMENT_TEXT_DETECTION, the 1,001-5,000,000 units/month tier. **The first 1000 units a month
    // are free and that is deliberately not what this number says** - the estimate answers "what
    // would this cost at scale", so at benchmark volumes the billing console will read $0.00 while
    // this column does not. The 5,000,001+ tier is $0.60 per 1000 and is not the rate a POC would
    // ever reach - ADR-11.
    usd: 1.5,
    source: 'https://cloud.google.com/vision/pricing',
    retrieved: '2026-08-03',
    notes:
      'DOCUMENT_TEXT_DETECTION, 1,001-5,000,000 units/month tier. Free tier ignored. One image is one unit.',
  },
  // Phase 09 adds one entry per model actually used, under the exact engine string, e.g.
  // 'vlm:openai/<model>': { unit: 'per-1M-tokens', usd: null, inputUsd: …, outputUsd: …, … }
};

/** `undefined` when the engine has no entry at all, which is a different thing from an unknown price. */
export function getPriceEntry(engine: string): PriceEntry | undefined {
  return pricing[engine];
}

/**
 * What one image costs on this engine, in USD - the number that becomes `costEstimateUsd`.
 *
 * It exists because the table's units differ and a per-call figure does not: `per-1000-images` is a
 * rate and `self-hosted` is already per call, so an engine adapter dividing by 1000 in one file and
 * not in another is exactly how a cost column stops meaning one thing. `null` propagates rather than
 * collapsing to `0` - an unknown cost must never be indistinguishable from a free one, ADR-11.
 *
 * Token-priced engines return `null` here on purpose: their cost is a function of the usage a call
 * reported, not of the image, and phase 09 computes it from `usage` at the point where that exists.
 */
export function imageCostUsd(engine: string): number | null {
  const entry = getPriceEntry(engine);

  if (entry === undefined || entry.usd === null) {
    return null;
  }

  switch (entry.unit) {
    case 'per-1000-images':
      return entry.usd / 1000;
    case 'on-device':
    case 'self-hosted':
      return entry.usd;
    case 'per-1M-tokens':
      return null;
  }
}
