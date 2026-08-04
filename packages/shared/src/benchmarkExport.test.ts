import { describe, expect, it } from 'vitest';

import { benchmarkExportSchema, buildBenchmarkExport } from './benchmarkExport.js';
import { LEGACY_PARSER_VERSION, PARSER_VERSION } from './parserVersion.js';
import type { Attempt } from './schemas/attempt.js';
import { LEGACY_TIMING_VERSION, TIMING_VERSION } from './timingVersion.js';

/**
 * The export is the analysis surface, so what these tests defend is that a file found later is
 * still readable: it says which semantics its rows were recorded under and which filters produced
 * it, and it validates against the same schemas the harness itself writes through.
 */

let counter = 0;

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  counter += 1;

  return {
    id: `attempt-${counter}`,
    imageId: 'image-1',
    captureGroupId: 'group-1',
    method: 'mlkit',
    inputVariant: 'upload',
    device: 'Pixel Test (Android 15)',
    ocr: null,
    parse: null,
    vlm: null,
    timing: {
      captureMs: null,
      downscaleMs: null,
      uploadMs: null,
      downloadMs: null,
      requestMs: null,
      engineMs: null,
      serverTotalMs: null,
      parseMs: 1,
      totalMs: 100,
    },
    referenceDate: '2026-06-01',
    parserVersion: PARSER_VERSION,
    timingVersion: TIMING_VERSION,
    pricingVersion: '2026-08-03',
    promptVersion: null,
    error: null,
    createdAt: 1_780_000_000_000 + counter,
    ...overrides,
  };
}

const NO_FILTERS = {
  method: null,
  source: null,
  inputVariant: null,
  parserVersion: null,
  timingVersion: null,
} as const;

describe('buildBenchmarkExport', () => {
  it('describes the versions actually present in the rows, not the ones this build carries', () => {
    const file = buildBenchmarkExport({
      exportedAt: '2026-08-04T09:00:00.000Z',
      filters: NO_FILTERS,
      images: [],
      barcodeScans: [],
      attempts: [
        attempt({
          parserVersion: LEGACY_PARSER_VERSION,
          timingVersion: LEGACY_TIMING_VERSION,
          pricingVersion: 'unset',
        }),
        attempt(),
        attempt(),
      ],
    });

    // Both versions, de-duplicated and sorted, so a reader sees the file mixes semantics before
    // computing anything over it - ADR-21, ADR-22.
    expect(file.parserVersions).toEqual([LEGACY_PARSER_VERSION, PARSER_VERSION]);
    expect(file.timingVersions).toEqual([TIMING_VERSION, LEGACY_TIMING_VERSION].sort());
    expect(file.pricingVersions).toEqual(['2026-08-03', 'unset']);
    expect(benchmarkExportSchema.parse(file).schemaVersion).toBe('1');
  });

  it('records the filters it was taken under, because the rows alone do not imply them', () => {
    const file = buildBenchmarkExport({
      exportedAt: '2026-08-04T09:00:00.000Z',
      filters: { ...NO_FILTERS, source: 'camera', inputVariant: 'upload' },
      images: [],
      barcodeScans: [],
      attempts: [attempt()],
    });

    // A set filtered to camera runs and one that happens to contain only camera runs are
    // indistinguishable afterwards, and only the first supports a capture-latency figure.
    expect(file.filters.source).toBe('camera');
    expect(file.filters.method).toBeNull();
  });

  it('keeps barcode scans out of attempts and in their own array - ADR-1', () => {
    const file = buildBenchmarkExport({
      exportedAt: '2026-08-04T09:00:00.000Z',
      filters: NO_FILTERS,
      images: [],
      attempts: [attempt()],
      barcodeScans: [
        { id: 'scan-1', value: '3800123456789', decodeMs: 412.5, device: 'x', scannedAt: 1 },
      ],
    });

    expect(benchmarkExportSchema.parse(file).barcodeScans).toHaveLength(1);
    expect(file.attempts.map((row) => row.id)).not.toContain('scan-1');
  });

  it('produces an empty file rather than a missing one when nothing matched the filters', () => {
    const file = buildBenchmarkExport({
      exportedAt: '2026-08-04T09:00:00.000Z',
      filters: { ...NO_FILTERS, method: 'vlm' },
      images: [],
      attempts: [],
      barcodeScans: [],
    });

    expect(benchmarkExportSchema.safeParse(file).success).toBe(true);
    expect(file.parserVersions).toEqual([]);
  });
});
