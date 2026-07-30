import { describe, expect, it } from 'vitest';

import { groupAttempts } from './attemptGroups.js';
import type { Attempt } from './schemas/attempt.js';
import type { ExpiryStatus } from './schemas/parse.js';

/**
 * The grouping these tests defend is the one the specification asks for in the Library and History:
 * every individual run, plus a median per group, with `(method, inputVariant)` as the key. Getting
 * the key wrong is not a display bug - it silently averages a full-resolution read together with a
 * downscaled one and reports the result as one number - ADR-2.
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
    pricingVersion: 'unset',
    promptVersion: null,
    error: null,
    createdAt: 1_780_000_000_000 + counter,
    ...overrides,
  };
}

/** A parse result carrying a date, so `extractedCount` has something real to count. */
function parsed(status: ExpiryStatus): Attempt['parse'] {
  return {
    expiry: { date: '2027-03-12', precision: 'day', status, raw: '12.03.2027' },
    productionDate: null,
    rule: 'sole-candidate',
    ambiguous: false,
    confidence: { score: 0.8, signals: ['anchor-matched'] },
    candidates: [],
    referenceDate: '2026-06-01',
  };
}

describe('groupAttempts', () => {
  it('keys on (method, inputVariant) rather than on method alone - ADR-2', () => {
    const groups = groupAttempts([
      attempt({ inputVariant: 'upload', timing: { ...attempt().timing, totalMs: 900 } }),
      attempt({ inputVariant: 'original', timing: { ...attempt().timing, totalMs: 2_100 } }),
    ]);

    expect(groups).toHaveLength(2);
    // The downscaled read and the full-resolution one stay apart. Averaged, they would report
    // 1500 ms as the typical on-device latency, which is true of neither variant.
    expect(groups.map((group) => group.inputVariant)).toEqual(['upload', 'original']);
    expect(groups.map((group) => group.medianTotalMs)).toEqual([900, 2_100]);
  });

  it('reports a median with the run count it was taken over', () => {
    const groups = groupAttempts([
      attempt({ timing: { ...attempt().timing, totalMs: 100 } }),
      attempt({ timing: { ...attempt().timing, totalMs: 300 } }),
      attempt({ timing: { ...attempt().timing, totalMs: 200 } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.runCount).toBe(3);
    expect(groups[0]?.medianTotalMs).toBe(200);
    // Every run is kept, not collapsed into the median - spec, § Screens — Image library.
    expect(groups[0]?.attempts).toHaveLength(3);
  });

  it('takes the engine median over the runs that reported one, and counts the failures', () => {
    const groups = groupAttempts([
      attempt({ timing: { ...attempt().timing, engineMs: 80 } }),
      attempt({ timing: { ...attempt().timing, engineMs: 120 } }),
      // A failed run has no engine time at all. Counting it as 0 ms would make an engine that
      // cannot read a package look like the fastest one in the comparison.
      attempt({ error: 'ML Kit failed to read the image' }),
    ]);

    expect(groups[0]?.runCount).toBe(3);
    expect(groups[0]?.medianEngineMs).toBe(100);
    expect(groups[0]?.failureCount).toBe(1);
  });

  it('counts an expired date as an extraction - ADR-7', () => {
    const groups = groupAttempts([
      attempt({ parse: parsed('valid') }),
      attempt({ parse: parsed('expired') }),
      attempt({ parse: null }),
    ]);

    // The engine read the date correctly and the product is old. Scoring that as a failure would
    // penalise whichever engine reads best on a dataset shot from real packaging.
    expect(groups[0]?.extractedCount).toBe(2);
  });

  it('orders groups by the declared method order, not by insertion order', () => {
    const groups = groupAttempts([
      attempt({ method: 'vlm' }),
      attempt({ method: 'mlkit', inputVariant: 'original' }),
      attempt({ method: 'gcv' }),
      attempt({ method: 'mlkit', inputVariant: 'upload' }),
    ]);

    expect(groups.map((group) => `${group.method}/${group.inputVariant}`)).toEqual([
      'mlkit/upload',
      'mlkit/original',
      'gcv/upload',
      'vlm/upload',
    ]);
  });

  it('has no group at all for an empty set, rather than an empty group', () => {
    expect(groupAttempts([])).toEqual([]);
  });
});
