import { describe, expect, it } from 'vitest';

import {
  ANCHOR_PHRASES,
  MONTH_NAME_TABLES,
  PRICING_VERSION,
  barcodeScanCreateSchema,
  elapsed,
  median,
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
