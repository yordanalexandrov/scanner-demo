import { describe, expect, it } from 'vitest';

import {
  ANCHOR_PHRASES,
  MONTH_NAME_TABLES,
  PRICING_VERSION,
  elapsed,
  now,
  ocrResponseSchema,
  pricing,
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

  it('ships honest price placeholders', () => {
    // Phases 08 and 09 fill these in and bump the version at the same time - ADR-11.
    expect(PRICING_VERSION).toBe('unset');
    expect(pricing['gcv:builtin/stable']?.usd).toBeNull();
    for (const entry of Object.values(pricing)) {
      // An unknown cost must never be indistinguishable from a free one.
      expect(entry.usd === null || entry.usd === 0 || entry.retrieved !== null).toBe(true);
    }
  });

  it('measures durations from a monotonic clock', () => {
    const start = now();
    const spent = elapsed(start);
    expect(spent).toBeGreaterThanOrEqual(0);
    expect(elapsed(start)).toBeGreaterThanOrEqual(spent);
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
