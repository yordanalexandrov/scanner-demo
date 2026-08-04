import { describe, expect, it } from 'vitest';

import { captureCostMs, groupAttempts, groupAttemptsByImage } from './attemptGroups.js';
import { LEGACY_PARSER_VERSION, PARSER_VERSION } from './parserVersion.js';
import type { Attempt } from './schemas/attempt.js';
import type { ExpiryStatus } from './schemas/parse.js';
import { LEGACY_TIMING_VERSION, TIMING_VERSION } from './timingVersion.js';

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
    parserVersion: PARSER_VERSION,
    timingVersion: TIMING_VERSION,
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
    expect(groups.map((group) => group.cohorts[0]?.medianTotalMs)).toEqual([900, 2_100]);
  });

  it('reports a median with the run count it was taken over', () => {
    const groups = groupAttempts([
      attempt({ timing: { ...attempt().timing, totalMs: 100 } }),
      attempt({ timing: { ...attempt().timing, totalMs: 300 } }),
      attempt({ timing: { ...attempt().timing, totalMs: 200 } }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.cohorts[0]?.runCount).toBe(3);
    expect(groups[0]?.cohorts[0]?.medianTotalMs).toBe(200);
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

    expect(groups[0]?.cohorts[0]?.runCount).toBe(3);
    expect(groups[0]?.cohorts[0]?.medianEngineMs).toBe(100);
    expect(groups[0]?.cohorts[0]?.failureCount).toBe(1);
  });

  it('never averages two engines of one method into one median - ADR-24', () => {
    // The case this was written for: `VLM_MODEL` selects the model, every model records
    // `method: "vlm"`, and the two were observed on 2026-08-04 at 2.2 s and 8.6 s against the same
    // image. One median over both is a number true of neither - the same failure ADR-2 describes
    // for the two image variants, one level down.
    const withEngine = (engine: string, engineMs: number, promptVersion: string): Attempt =>
      attempt({
        method: 'vlm',
        promptVersion,
        ocr: {
          engine,
          rawText: '30.06.25',
          blocks: [],
          engineMs,
          engineMsScope: 'inference+network',
          serverTotalMs: null,
          imageWidth: 1200,
          imageHeight: 1600,
          usage: null,
          costEstimateUsd: null,
          pricingVersion: 'unset',
        },
        timing: { ...attempt().timing, engineMs, totalMs: engineMs + 100 },
      });

    const groups = groupAttempts([
      withEngine('vlm:openai/gpt-5.4-mini', 2200, 'prompt-v3'),
      withEngine('vlm:openai/gpt-5.4-mini', 2300, 'prompt-v3'),
      withEngine('vlm:openai/gpt-5.6-terra', 8600, 'prompt-v3'),
    ]);

    // Still one visual group - the reader compares methods, and both models are the VLM method.
    expect(groups).toHaveLength(1);
    expect(groups[0]?.attempts).toHaveLength(3);

    const byEngine = new Map(groups[0]?.cohorts.map((c) => [c.engine, c]));
    expect([...byEngine.keys()].sort()).toEqual([
      'vlm:openai/gpt-5.4-mini',
      'vlm:openai/gpt-5.6-terra',
    ]);
    expect(byEngine.get('vlm:openai/gpt-5.4-mini')?.medianEngineMs).toBe(2250);
    expect(byEngine.get('vlm:openai/gpt-5.6-terra')?.medianEngineMs).toBe(8600);
    // The number the old key produced, and the one no cohort may report.
    expect(groups[0]?.cohorts.map((c) => c.medianEngineMs)).not.toContain(2300);

    // A prompt change splits them for the same reason a model change does - ADR-24.
    const twoPrompts = groupAttempts([
      withEngine('vlm:openai/gpt-5.4-mini', 2200, 'prompt-v2'),
      withEngine('vlm:openai/gpt-5.4-mini', 2300, 'prompt-v3'),
    ]);
    expect(twoPrompts[0]?.cohorts.map((c) => c.promptVersion).sort()).toEqual([
      'prompt-v2',
      'prompt-v3',
    ]);
  });

  it('keeps a failed run in its own cohort, because it has no engine to attribute - ADR-24', () => {
    const ok = attempt({
      method: 'gcv',
      ocr: {
        engine: 'gcv:builtin/stable',
        rawText: '',
        blocks: [],
        engineMs: 400,
        engineMsScope: 'inference+network',
        serverTotalMs: null,
        imageWidth: 1200,
        imageHeight: 1600,
        usage: null,
        costEstimateUsd: 0.0015,
        pricingVersion: '2026-08-03',
      },
      timing: { ...attempt().timing, engineMs: 400, totalMs: 500 },
    });
    // `ocr` is `null` on a failure, so the record genuinely does not know which engine it would
    // have been. Filing it under the successful one would attribute a failure to an engine that
    // may not have produced it.
    const failed = attempt({ method: 'gcv', error: 'Cloud Vision refused the call' });

    const cohorts = groupAttempts([ok, failed])[0]?.cohorts ?? [];

    expect(cohorts).toHaveLength(2);
    expect(cohorts.find((c) => c.engine === 'gcv:builtin/stable')?.failureCount).toBe(0);
    expect(cohorts.find((c) => c.engine === null)?.failureCount).toBe(1);
  });

  it('counts an expired date as an extraction - ADR-7', () => {
    const groups = groupAttempts([
      attempt({ parse: parsed('valid') }),
      attempt({ parse: parsed('expired') }),
      attempt({ parse: null }),
    ]);

    // The engine read the date correctly and the product is old. Scoring that as a failure would
    // penalise whichever engine reads best on a dataset shot from real packaging.
    expect(groups[0]?.cohorts[0]?.extractedCount).toBe(2);
  });

  it('keeps one visual group but never mixes parser or timing semantics - ADR-21, ADR-22', () => {
    const groups = groupAttempts([
      attempt({
        parserVersion: LEGACY_PARSER_VERSION,
        timingVersion: LEGACY_TIMING_VERSION,
        timing: { ...attempt().timing, totalMs: 70_000 },
        parse: null,
      }),
      attempt({
        parserVersion: PARSER_VERSION,
        timingVersion: TIMING_VERSION,
        timing: { ...attempt().timing, totalMs: 200 },
        parse: parsed('valid'),
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.attempts).toHaveLength(2);
    expect(groups[0]?.cohorts).toHaveLength(2);
    expect(
      groups[0]?.cohorts.map((cohort) => ({
        parserVersion: cohort.parserVersion,
        timingVersion: cohort.timingVersion,
        medianTotalMs: cohort.medianTotalMs,
        extractedCount: cohort.extractedCount,
      })),
    ).toEqual([
      {
        parserVersion: LEGACY_PARSER_VERSION,
        timingVersion: LEGACY_TIMING_VERSION,
        medianTotalMs: 70_000,
        extractedCount: 0,
      },
      {
        parserVersion: PARSER_VERSION,
        timingVersion: TIMING_VERSION,
        medianTotalMs: 200,
        extractedCount: 1,
      },
    ]);
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

  it('totals the costs it knows and counts the ones it does not - ADR-11', () => {
    const priced = (costEstimateUsd: number | null): Attempt =>
      attempt({
        method: 'gcv',
        ocr: {
          engine: 'gcv:builtin/stable',
          rawText: '',
          blocks: [],
          engineMs: 400,
          engineMsScope: 'inference+network',
          serverTotalMs: null,
          imageWidth: 1200,
          imageHeight: 1600,
          usage: null,
          costEstimateUsd,
          pricingVersion: '2026-08-03',
        },
        timing: { ...attempt().timing, engineMs: 400 },
      });

    const group = groupAttempts([
      priced(0.0015),
      priced(0.0015),
      // A price the table has no figure for, and a run that failed before producing one. Neither is
      // a free call, and neither may be folded into the total as a zero.
      priced(null),
      attempt({ method: 'gcv', error: 'Cloud Vision refused the call' }),
    ])[0];

    expect(group?.costUsd).toBe(0.003);
    expect(group?.unpricedCount).toBe(2);
  });

  it('reports no cost rather than a free one when nothing was priced - ADR-11', () => {
    const group = groupAttempts([attempt(), attempt()])[0];

    // `0` here would say ML Kit's two runs cost nothing *and* that the figure is known. The first
    // is true and the second is not, and only one of the two is what a reader takes from `$0.00`.
    expect(group?.costUsd).toBeNull();
    expect(group?.unpricedCount).toBe(2);
  });
});

describe('captureCostMs', () => {
  it('sums the capture-side segments, which sit outside every method total - ADR-22', () => {
    expect(
      captureCostMs({
        ...attempt().timing,
        captureMs: 300,
        downscaleMs: 120,
        uploadMs: 480,
      }),
    ).toBe(900);
  });

  it('adds up whichever segments apply, rather than requiring all three', () => {
    // A gallery import has no capture but does have a downscale and an upload.
    expect(
      captureCostMs({ ...attempt().timing, captureMs: null, downscaleMs: 120, uploadMs: 480 }),
    ).toBe(600);
  });

  it('is null, never zero, when no capture-side segment applies at all', () => {
    // A Library re-run reads an image the server already holds: it neither captured nor uploaded
    // anything. `0` would read as a free capture and drag every average built on it.
    expect(captureCostMs(attempt().timing)).toBeNull();
  });
});

describe('groupAttemptsByImage', () => {
  it('puts every method for one image on one row, newest activity first', () => {
    const rows = groupAttemptsByImage([
      attempt({ imageId: 'image-b', method: 'gcv', createdAt: 300 }),
      attempt({ imageId: 'image-a', method: 'mlkit', inputVariant: 'upload', createdAt: 100 }),
      attempt({ imageId: 'image-a', method: 'mlkit', inputVariant: 'original', createdAt: 200 }),
      attempt({ imageId: 'image-a', method: 'vlm', createdAt: 900 }),
    ]);

    expect(rows.map((row) => row.imageId)).toEqual(['image-a', 'image-b']);
    expect(rows[0]?.latestAt).toBe(900);
    // The four methods read side by side, with the two on-device variants still apart - ADR-2.
    expect(rows[0]?.groups.map((group) => `${group.method}/${group.inputVariant}`)).toEqual([
      'mlkit/upload',
      'mlkit/original',
      'vlm/upload',
    ]);
  });

  it('has no row for an empty set', () => {
    expect(groupAttemptsByImage([])).toEqual([]);
  });
});
