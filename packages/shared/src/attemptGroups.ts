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
import type { Attempt, Method } from './schemas/attempt.js';
import { imageVariantSchema } from './schemas/image.js';
import type { ImageVariant } from './schemas/image.js';
import type { Millis } from './timing.js';
import type { ParserVersion } from './parserVersion.js';
import type { TimingVersion } from './timingVersion.js';

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
    });
  }

  return groups.sort((left, right) => orderOf(left) - orderOf(right));
}
