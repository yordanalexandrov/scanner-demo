import { describe, expect, it } from 'vitest';

import {
  ANCHOR_PHRASES,
  LEGACY_PARSER_VERSION,
  LEGACY_TIMING_VERSION,
  MONTH_NAME_TABLES,
  PARSER_VERSION,
  PRICING_VERSION,
  TIMING_VERSION,
  barcodeScanCreateSchema,
  elapsed,
  imageCostUsd,
  median,
  now,
  ocrResponseSchema,
  parserVersionSchema,
  pricing,
  timingVersionSchema,
  tokenCostUsd,
  vlmOcrResponseSchema,
} from './index.js';

describe('shared contracts', () => {
  it('validates an OcrResponse and rejects a malformed one', () => {
    const response = {
      engine: 'mlkit',
      rawText: 'BEST BEFORE 31.12.2027',
      blocks: [{ text: '31.12.2027', bbox: [12, 40, 180, 30], confidence: null }],
      engineMs: 84.2,
      engineMsScope: 'inference',
      serverTotalMs: null,
      imageWidth: 1600,
      imageHeight: 1200,
      usage: null,
      costEstimateUsd: null,
      pricingVersion: PRICING_VERSION,
    };

    expect(ocrResponseSchema.parse(response).engine).toBe('mlkit');
    // A missing confidence is null, never 1.0 - ADR-5. Out-of-range values must not slip through.
    expect(
      ocrResponseSchema.safeParse({
        ...response,
        blocks: [{ text: 'x', bbox: null, confidence: 1.4 }],
      }).success,
    ).toBe(false);
  });

  it('carries the model answer and the prompt version on the VLM response only', () => {
    const base = {
      engine: 'vlm:openai/gpt-5.4-mini',
      rawText: 'BEST BEFORE\n31.12.2027',
      blocks: [
        // No geometry, which is the normal case for this engine: the parser falls through to
        // `latest-of-pair` or `sole-candidate` and records which rule decided - ADR-4.
        { text: 'BEST BEFORE', bbox: null, confidence: null },
        { text: '31.12.2027', bbox: null, confidence: null },
      ],
      engineMs: 3120,
      engineMsScope: 'inference+network',
      serverTotalMs: null,
      imageWidth: 1200,
      imageHeight: 1600,
      usage: { inputTokens: 1842, outputTokens: 96 },
      costEstimateUsd: 0.0018135,
      pricingVersion: PRICING_VERSION,
    };

    const parsed = vlmOcrResponseSchema.parse({
      ...base,
      parsedDate: '2027-12-31',
      modelReasoning: 'The packaging prints BEST BEFORE above 31.12.2027.',
      promptVersion: 'prompt-v1',
    });

    expect(parsed.parsedDate).toBe('2027-12-31');
    expect(parsed.promptVersion).toBe('prompt-v1');

    // The three extra fields are required here and absent from the base contract. A VLM response
    // that lost `promptVersion` in transit must fail rather than arrive as an attempt nobody can
    // attribute to a prompt - phase 09 criterion 10, ADR-24.
    expect(vlmOcrResponseSchema.safeParse(base).success).toBe(false);
    // And no other engine may ship these fields: `ocrResponseSchema` strips them, so a `parsedDate`
    // on the GCV route would silently disappear instead of looking like a model answer.
    expect(ocrResponseSchema.parse({ ...base, parsedDate: '2027-12-31' })).not.toHaveProperty(
      'parsedDate',
    );
  });

  it('prices what it knows and says nothing about what it does not', () => {
    // Phase 08 filled the Cloud Vision entry in and bumped the version to the retrieval date at the
    // same time, because a version covering two different price sets identifies neither - ADR-11.
    expect(PRICING_VERSION).toBe('2026-08-03');

    const gcv = pricing['gcv:builtin/stable'];
    expect(gcv?.usd).toBe(1.5);
    // A figure with no provenance is a figure written from memory. Both fields, or the price is not
    // trustworthy - criterion 5.
    expect(gcv?.source).toBe('https://cloud.google.com/vision/pricing');
    expect(gcv?.retrieved).toBe(PRICING_VERSION);

    for (const entry of Object.values(pricing)) {
      // An unknown cost must never be indistinguishable from a free one.
      expect(entry.usd === null || entry.usd === 0 || entry.retrieved !== null).toBe(true);
    }
  });

  it('turns a price into what one image costs, per unit rather than per rate', () => {
    // $1.50 per 1000 units is $0.0015 an image. Reading `usd` directly here would overstate a
    // single attempt by three orders of magnitude - which is why the conversion lives in one place.
    expect(imageCostUsd('gcv:builtin/stable')).toBeCloseTo(0.0015, 10);
    // A measured zero, not a placeholder: the table says these have no per-call cost.
    expect(imageCostUsd('mlkit')).toBe(0);
    expect(imageCostUsd('onnx-paddleocr')).toBe(0);
    // An engine with no entry at all is unknown, and unknown is `null` rather than free.
    expect(imageCostUsd('vlm:openai/not-yet')).toBeNull();
    // A token-priced engine has no per-image price at all. It must not fall through to a zero.
    expect(imageCostUsd('vlm:openai/gpt-5.4-mini')).toBeNull();
  });

  it('re-derives a token cost from the usage stored on the attempt', () => {
    // The figure an export has to be able to reproduce: 1,842 input and 96 output tokens at
    // $0.75/$4.50 per 1M. Computed the long way here on purpose - a test that called the same
    // helper twice would only prove the helper is deterministic - phase 09 criterion 5.
    const usage = { inputTokens: 1842, outputTokens: 96 };
    const expected = (1842 * 0.75 + 96 * 4.5) / 1_000_000;

    expect(tokenCostUsd('vlm:openai/gpt-5.4-mini', usage)).toBe(expected);
    expect(tokenCostUsd('vlm:openai/gpt-5.4', usage)).toBe((1842 * 2.5 + 96 * 15) / 1_000_000);

    // Every route to "not known" ends at `null`, never at `0` - ADR-11. A model nobody priced, a
    // call that reported no tokens, and an engine that is not token priced are all unknown here.
    expect(tokenCostUsd('vlm:openai/not-yet', usage)).toBeNull();
    expect(tokenCostUsd('vlm:openai/gpt-5.4-mini', null)).toBeNull();
    expect(tokenCostUsd('gcv:builtin/stable', usage)).toBeNull();

    // A zero-token call is a real zero. It is reachable only from a response that reported one, and
    // that is a fact about the call rather than a missing price.
    expect(tokenCostUsd('vlm:openai/gpt-5.4-mini', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('prices every VLM model it names, with provenance', () => {
    for (const [engine, entry] of Object.entries(pricing)) {
      if (!engine.startsWith('vlm:')) {
        continue;
      }

      // Token priced, both halves filled, and both traceable to a page and a date. An entry with
      // one half priced would silently halve the cost column.
      expect(entry.unit).toBe('per-1M-tokens');
      expect(typeof entry.inputUsd).toBe('number');
      expect(typeof entry.outputUsd).toBe('number');
      expect(entry.source).not.toBeNull();
      expect(entry.retrieved).toBe(PRICING_VERSION);
    }
  });

  it('accepts only declared parser and timing semantics', () => {
    // Every past version stays accepted - rows recorded under older rules keep saying so, and a
    // schema that stopped parsing them would make the history unreadable rather than obsolete.
    expect(parserVersionSchema.options).toEqual(['parser-v1', 'parser-v2', 'parser-v3']);
    expect(parserVersionSchema.options).toContain(LEGACY_PARSER_VERSION);
    expect(parserVersionSchema.options).toContain(PARSER_VERSION);
    expect(timingVersionSchema.options).toEqual([LEGACY_TIMING_VERSION, TIMING_VERSION]);
    expect(parserVersionSchema.safeParse('parser-typo').success).toBe(false);
    expect(timingVersionSchema.safeParse('timing-typo').success).toBe(false);
  });

  it('measures durations from a monotonic clock', () => {
    const start = now();
    const spent = elapsed(start);
    expect(spent).toBeGreaterThanOrEqual(0);
    expect(elapsed(start)).toBeGreaterThanOrEqual(spent);
  });

  it('takes a median that an empty set cannot fake', () => {
    // No measurements is not a measurement of zero - global constraint.
    expect(median([])).toBeNull();
    expect(median([42])).toBe(42);
    // Odd length: the middle element, regardless of the order it arrived in.
    expect(median([300, 100, 200])).toBe(200);
    // Even length: the two straddling the middle, averaged.
    expect(median([100, 200, 300, 400])).toBe(250);
    // The caller's array is left in the order it renders.
    const values = [300, 100, 200];
    median(values);
    expect(values).toEqual([300, 100, 200]);
  });

  it('accepts a barcode scan the phone can produce and nothing more', () => {
    const scan = { value: '4006381333931', decodeMs: 412.7, device: 'Pixel 7 (Android 15)' };

    expect(barcodeScanCreateSchema.parse(scan).value).toBe('4006381333931');
    // The server assigns `id` and `scannedAt`; a client sending either is a defect, not a hint.
    expect(barcodeScanCreateSchema.safeParse({ ...scan, scannedAt: 1 }).success).toBe(false);
    expect(barcodeScanCreateSchema.safeParse({ ...scan, value: '400638133393' }).success).toBe(
      false,
    );
  });

  it('covers the same languages in the anchor and month tables', () => {
    const anchorLocales = new Set(ANCHOR_PHRASES.map((a) => a.locale));
    const monthLocales = new Set(MONTH_NAME_TABLES.map((t) => t.locale));
    expect([...anchorLocales].sort()).toEqual([...monthLocales].sort());
    for (const table of MONTH_NAME_TABLES) {
      expect(table.full).toHaveLength(12);
      expect(table.abbreviated).toHaveLength(12);
    }
  });
});
