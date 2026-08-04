/**
 * Attempts, grouped the one way they may be grouped.
 *
 * The grouping key is `(method, inputVariant)` and never `method` alone. The on-device path runs
 * against both variants of a capture, and collapsing the two into one figure would average a
 * full-resolution read together with a downscaled one - both numbers would then be wrong, and the
 * measurement of what the downscale costs, which is the reason both runs exist, would be gone
 * - ADR-2.
 *
 * It lives here rather than in the screen that first needed it for the same reason `median` does:
 * the Library, History and the JSON export all report these numbers, and a benchmark whose headline
 * figure depends on which view computed it is not one. Being here also means it is covered by tests,
 * which app code in this repository is not.
 */

import { median } from './stats.js';
import { methodSchema } from './schemas/attempt.js';
import type { Attempt, Method, Timing } from './schemas/attempt.js';
import { imageVariantSchema } from './schemas/image.js';
import type { ImageVariant } from './schemas/image.js';
import type { Millis } from './timing.js';
import type { ParserVersion } from './parserVersion.js';
import type { TimingVersion } from './timingVersion.js';

/**
 * The shared cost of getting one capture onto the server, outside every method total - ADR-22.
 *
 * It is paid once per photograph and belongs to none of the four methods, so it is reported beside
 * a method total and never summed into one. `null` rather than `0` when no capture-side segment
 * applies at all - a Library re-run has neither a capture nor an upload, and a zero there would
 * read as a free capture and drag every average built on it.
 */
export function captureCostMs(timing: Timing): Millis | null {
  const segments = [timing.captureMs, timing.downscaleMs, timing.uploadMs].filter(
    (value): value is Millis => value !== null,
  );

  return segments.length === 0 ? null : segments.reduce((total, value) => total + value, 0);
}

/**
 * What a set of runs is estimated to have cost, and how many of them nobody can price.
 *
 * The two travel together because a total on its own would lie by omission: a `null`
 * `costEstimateUsd` means the price table has no figure for that engine, or the run failed before
 * producing one, and treating either as `0` makes an unpriced method indistinguishable from a free
 * one - ADR-11. So the sum covers only the runs that reported a cost, and the count says how many
 * it does not cover.
 */
function priceRuns(attempts: readonly Attempt[]): {
  costUsd: number | null;
  unpricedCount: number;
} {
  const priced = attempts
    .map((attempt) => attempt.ocr?.costEstimateUsd ?? null)
    .filter((value): value is number => value !== null);

  return {
    costUsd: priced.length === 0 ? null : priced.reduce((total, value) => total + value, 0),
    unpricedCount: attempts.length - priced.length,
  };
}

export interface AttemptSummaryCohort {
  parserVersion: ParserVersion;
  timingVersion: TimingVersion;
  /**
   * The engine string these runs came from - `"mlkit"`, `"gcv:builtin/stable"`,
   * `"vlm:openai/gpt-5.4-mini"` - or `null` for runs that produced no result at all.
   *
   * **It is part of the cohort key because one `method` can be several engines.** The VLM path is
   * where this stops being theoretical: `VLM_MODEL` selects the model, every model records
   * `method: "vlm"`, and without this a median would average a 2.2 s run of one model together with
   * an 8.6 s run of another and report a number true of neither. That is the same failure ADR-2
   * describes for the two image variants, one level down.
   *
   * `null` is a cohort of its own, and deliberately: a failed run has `ocr: null`, so the record
   * genuinely does not know which engine it would have been. Filing it under one of the others
   * would attribute a failure to a model that may not have produced it.
   */
  engine: string | null;
  /** The prompt that produced them. VLM only; `null` on every other method - ADR-24. */
  promptVersion: string | null;
  /** The runs behind these figures, in the order supplied by the API. */
  attempts: Attempt[];
  /**
   * The median of `totalMs`, which is meaningful only inside one timing protocol - ADR-22.
   */
  medianTotalMs: Millis | null;
  /**
   * The median of `engineMs` over the runs that reported one. A failed run reports none, and
   * counting it as zero would make an engine that cannot read a package look fast.
   */
  medianEngineMs: Millis | null;
  /**
   * How many runs the medians are over. A median of two is noisy by definition, so the count travels
   * with it rather than being left for the reader to guess.
   */
  runCount: number;
  /** Runs that failed. A failure is data and is counted, never dropped - ADR-15. */
  failureCount: number;
  /** Runs that extracted a date, counting `expired` as a successful extraction - ADR-7. */
  extractedCount: number;
  /** Estimated cost of these runs, over the ones that reported one. `null` when none did - ADR-11. */
  costUsd: number | null;
  /** Runs with no cost figure. Never folded into `costUsd` as `0` - ADR-11. */
  unpricedCount: number;
}

export interface AttemptGroup {
  method: Method;
  inputVariant: ImageVariant;
  /** Every individual run, in the order it was given - the API serves attempts newest first. */
  attempts: Attempt[];
  /**
   * Extraction and latency summaries cannot cross parser semantics, timing semantics, the engine
   * that produced them, or the prompt that produced them. Keeping these cohorts inside the visual
   * `(method, inputVariant)` group preserves ADR-2 without fabricating a median across the phase
   * 06b boundary - ADR-21, ADR-22 - or across two models of one method - ADR-24.
   */
  cohorts: AttemptSummaryCohort[];
  /**
   * What every run in the group is estimated to have cost.
   *
   * **Cost may be totalled across cohorts where a median may not**, and the difference is not an
   * inconsistency. A median is a statement about a population, so mixing two timing protocols
   * produces a figure true of neither. A cost is an amount actually incurred per call, priced by
   * the table version stored on that call; adding two of them answers "what did this cost", which
   * is a question the parser and timing semantics do not enter into.
   */
  costUsd: number | null;
  unpricedCount: number;
}

/**
 * Every attempt recorded against one source image, with the per-method groups underneath it.
 *
 * This is History's row - phase 10 scope item 1 - and it is grouped by `imageId` rather than by
 * `captureGroupId` because the attempt row itself names the image it was recorded against. Under
 * ADR-20 that is the group's uploaded row whichever variant's pixels were read, so the two
 * groupings coincide in the data while only this one is derivable from an attempt alone: an export
 * consumer holding `attempts` and no `images` can still reproduce these rows.
 */
export interface ImageAttempts {
  imageId: string;
  captureGroupId: string;
  /** Every run against this image, in the order supplied by the API - newest first. */
  attempts: Attempt[];
  /** The same runs, split by `(method, inputVariant)` - the four methods read side by side. */
  groups: AttemptGroup[];
  /** The most recent run against this image. Wall clock, ordered only - never subtracted - ADR-10. */
  latestAt: number;
}

/** Index of each enum member, so group order is the declared order rather than insertion order. */
const METHOD_ORDER = new Map(methodSchema.options.map((method, index) => [method, index]));
const VARIANT_ORDER = new Map(imageVariantSchema.options.map((variant, index) => [variant, index]));

function orderOf(group: AttemptGroup): number {
  // Method first, variant second: the reader compares methods, and the two variants of one method
  // belong next to each other underneath it.
  return (METHOD_ORDER.get(group.method) ?? 0) * 10 + (VARIANT_ORDER.get(group.inputVariant) ?? 0);
}

function summariseCohorts(attempts: Attempt[]): AttemptSummaryCohort[] {
  const buckets = new Map<string, Attempt[]>();

  for (const attempt of attempts) {
    // `JSON.stringify` rather than a separator, unlike the group key below: `engine` is a free
    // string a provider chose rather than an enum member, so nothing here can promise it does not
    // contain whichever separator was picked - and `null` has to stay distinct from `""`, which a
    // joined string cannot manage.
    const key = JSON.stringify([
      attempt.parserVersion,
      attempt.timingVersion,
      attempt.ocr?.engine ?? null,
      attempt.promptVersion,
    ]);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [attempt]);
    } else {
      bucket.push(attempt);
    }
  }

  return [...buckets.values()].flatMap((bucket) => {
    const first = bucket[0];
    if (first === undefined) {
      return [];
    }

    return [
      {
        parserVersion: first.parserVersion,
        timingVersion: first.timingVersion,
        // Every attempt in a bucket shares these four by construction.
        engine: first.ocr?.engine ?? null,
        promptVersion: first.promptVersion,
        attempts: bucket,
        medianTotalMs: median(bucket.map((attempt) => attempt.timing.totalMs)),
        medianEngineMs: median(
          bucket
            .map((attempt) => attempt.timing.engineMs)
            .filter((value): value is Millis => value !== null),
        ),
        runCount: bucket.length,
        failureCount: bucket.filter((attempt) => attempt.error !== null).length,
        extractedCount: bucket.filter(
          (attempt) => attempt.parse !== null && attempt.parse.expiry !== null,
        ).length,
        ...priceRuns(bucket),
      },
    ];
  });
}

export function groupAttempts(attempts: readonly Attempt[]): AttemptGroup[] {
  const buckets = new Map<string, Attempt[]>();

  for (const attempt of attempts) {
    // A separator no enum member can contain, so two keys cannot collide into one group.
    const key = `${attempt.method}\u0000${attempt.inputVariant}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [attempt]);
    } else {
      bucket.push(attempt);
    }
  }

  const groups: AttemptGroup[] = [];

  for (const bucket of buckets.values()) {
    // Every attempt in a bucket shares these two by construction.
    const first = bucket[0];
    if (first === undefined) {
      continue;
    }

    groups.push({
      method: first.method,
      inputVariant: first.inputVariant,
      attempts: bucket,
      cohorts: summariseCohorts(bucket),
      ...priceRuns(bucket),
    });
  }

  return groups.sort((left, right) => orderOf(left) - orderOf(right));
}

/**
 * The same attempts, one row per source image, newest activity first.
 *
 * The ordering is by the most recent run rather than by the image's own `createdAt`: History is
 * read while a dataset is being collected, and the capture someone just re-ran is the one they want
 * at the top. `latestAt` is a wall-clock instant used only to order rows - ADR-10.
 */
export function groupAttemptsByImage(attempts: readonly Attempt[]): ImageAttempts[] {
  const buckets = new Map<string, Attempt[]>();

  for (const attempt of attempts) {
    const bucket = buckets.get(attempt.imageId);
    if (bucket === undefined) {
      buckets.set(attempt.imageId, [attempt]);
    } else {
      bucket.push(attempt);
    }
  }

  const rows: ImageAttempts[] = [];

  for (const bucket of buckets.values()) {
    const first = bucket[0];
    if (first === undefined) {
      continue;
    }

    rows.push({
      imageId: first.imageId,
      // Every attempt in a bucket shares this: they name the same image.
      captureGroupId: first.captureGroupId,
      attempts: bucket,
      groups: groupAttempts(bucket),
      latestAt: bucket.reduce((latest, attempt) => Math.max(latest, attempt.createdAt), 0),
    });
  }

  return rows.sort((left, right) => right.latestAt - left.latestAt);
}
