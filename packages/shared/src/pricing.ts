import type { Usage } from './schemas/ocr.js';

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
 * `2026-08-03` is the date the Cloud Vision figure below was read, and also the date the OpenAI
 * figures were. Phase 09 therefore does not move it: one version identifies one price set, and both
 * sets were read from their providers' pages on the same day. Attempts recorded before phase 08
 * carry `"unset"`, and that is the point of the field: those were priced by a different table and a
 * single version covering both would identify neither.
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
  /**
   * One entry per model actually used, under the exact engine string - ADR-11.
   *
   * **Only the models this phase ran are here, and that is deliberate.** An engine string with no
   * entry yields `costEstimateUsd: null`, which is the correct answer for a model nobody has priced:
   * an operator who points `VLM_MODEL` at a third model gets an honest "unknown" rather than a
   * number borrowed from a different model. Adding one is reading two figures off the page below and
   * writing them here beside their retrieval date.
   *
   * `usd` is `null` on both because a flat per-image price does not exist for these: the cost is a
   * function of the tokens a call reported, computed by {@link tokenCostUsd} from the `usage` stored
   * on the attempt. That is what makes a cost figure in the export re-derivable rather than merely
   * believed - phase 09 criterion 5.
   */
  'vlm:openai/gpt-5.4-mini': {
    unit: 'per-1M-tokens',
    usd: null,
    inputUsd: 0.75,
    outputUsd: 4.5,
    source: 'https://developers.openai.com/api/docs/pricing',
    retrieved: '2026-08-03',
    notes:
      'Standard tier, short context. Batch and cached-input discounts ignored: neither is used here.',
  },
  'vlm:openai/gpt-5.4': {
    unit: 'per-1M-tokens',
    usd: null,
    inputUsd: 2.5,
    outputUsd: 15,
    source: 'https://developers.openai.com/api/docs/pricing',
    retrieved: '2026-08-03',
    notes:
      'As above. Priced so a model change is a comparison rather than a gap in the cost column.',
  },
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

/**
 * What one token-priced call cost, in USD, from the usage that call actually reported.
 *
 * **The point of this function is that it is a pure function of two stored fields.** `usage` and
 * `pricingVersion` are persisted on the attempt, so anyone holding an export can call this and get
 * the number back - a cost in the report is auditable rather than something the harness asserts
 * about itself. That is phase 09 criterion 5, and it is why the arithmetic lives here rather than
 * inside the provider that happens to know the token counts.
 *
 * `null` propagates from every direction it can come from - no entry, an entry that is not token
 * priced, a price not yet filled in, or a call that reported no usage. None of those is a free call
 * and none of them may render as `$0.00` - ADR-11.
 */
export function tokenCostUsd(engine: string, usage: Usage | null): number | null {
  const entry = getPriceEntry(engine);

  if (entry === undefined || usage === null || entry.unit !== 'per-1M-tokens') {
    return null;
  }

  const { inputUsd, outputUsd } = entry;

  if (
    inputUsd === null ||
    inputUsd === undefined ||
    outputUsd === null ||
    outputUsd === undefined
  ) {
    return null;
  }

  return (usage.inputTokens * inputUsd + usage.outputTokens * outputUsd) / 1_000_000;
}
