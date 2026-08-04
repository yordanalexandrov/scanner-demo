#!/usr/bin/env tsx
import fs from 'node:fs';
import { benchmarkExportSchema, groupAttempts, median } from '@scanner-demo/shared';
import type { Attempt, BenchmarkExport } from '@scanner-demo/shared';

/**
 * Re-validates a JSON export and recomputes its headline figures from the file.
 *
 * ```bash
 * pnpm --filter @scanner-demo/server verify:export ~/Downloads/scanner-demo-….json
 * ```
 *
 * This is phase 10's acceptance criteria 6 to 9 as a command. It exists because "the export is
 * valid" and "the medians on screen came from these rows" are claims, and a benchmark whose
 * headline figures cannot be reproduced from its own output is not one.
 *
 * **The medians are computed twice, on purpose.** Once by `groupAttempts` from
 * `@scanner-demo/shared` - the same code the screen calls - and once by the naive implementation in
 * {@link independentMedian} below, which sorts an array and picks the middle. Running only the
 * first would prove that the shared function agrees with itself. The two are compared, and a
 * disagreement fails the run.
 */

interface Failure {
  criterion: string;
  detail: string;
}

const failures: Failure[] = [];

function check(ok: boolean, criterion: string, detail: string): void {
  if (!ok) {
    failures.push({ criterion, detail });
  }
}

/**
 * The middle value, written out longhand and owing nothing to the shared implementation.
 *
 * It is the check on `median`, so it deliberately does not call it. The two must agree on
 * even-length sets and on the empty one, which is where two reasonable implementations differ.
 */
function independentMedian(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }

  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function key(attempt: Attempt): string {
  // The grouping the figures on screen use: method and variant, then the semantics a median may
  // not cross - ADR-2, ADR-21, ADR-22, ADR-24.
  return [
    attempt.method,
    attempt.inputVariant,
    attempt.parserVersion,
    attempt.timingVersion,
    attempt.ocr?.engine ?? 'no engine',
    attempt.promptVersion ?? '-',
  ].join(' · ');
}

/** Criterion 6: the file parses as JSON and validates against the shared schemas. */
function load(path: string): BenchmarkExport {
  const raw = fs.readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const result = benchmarkExportSchema.safeParse(parsed);

  if (!result.success) {
    console.error('The export does not validate against the shared schemas:');
    for (const issue of result.error.issues.slice(0, 20)) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    console.error(`  (${result.error.issues.length} issue(s) in total)`);
    process.exit(1);
  }

  console.log(
    `Validated against benchmarkExportSchema · ${(raw.length / 1_000_000).toFixed(2)} MB`,
  );
  return result.data;
}

/** Criterion 8: every row carries the fields that make it interpretable later. */
function checkRowCompleteness(file: BenchmarkExport): void {
  for (const attempt of file.attempts) {
    const where = `${attempt.id} (${attempt.method}/${attempt.inputVariant})`;

    check(
      attempt.pricingVersion.length > 0,
      '8',
      `${where}: no pricingVersion - the cost column stops meaning one thing without it, ADR-11`,
    );
    check(attempt.parserVersion.length > 0, '8', `${where}: no parserVersion - ADR-21`);
    check(attempt.timingVersion.length > 0, '8', `${where}: no timingVersion - ADR-22`);
    check(
      attempt.referenceDate.length > 0,
      '8',
      `${where}: no referenceDate - a re-run could not reach the same verdict without it, ADR-6`,
    );

    if (attempt.error === null) {
      // A failed run has `ocr: null` legitimately: there was no text and no engine. A successful
      // one carrying no raw text would mean the export summarised what it should have kept.
      check(
        attempt.ocr !== null,
        '8',
        `${where}: succeeded but carries no ocr block - the raw text is the point of the export`,
      );
      check(
        attempt.ocr?.engineMsScope !== undefined,
        '8',
        `${where}: no engineMsScope - engineMs is not comparable across engines without it, ADR-10`,
      );
      check(typeof attempt.ocr?.rawText === 'string', '8', `${where}: rawText is not a string`);
    }
  }

  const withText = file.attempts.filter((a) => typeof a.ocr?.rawText === 'string').length;
  console.log(
    `Row completeness: ${file.attempts.length} attempts, ${withText} carrying raw OCR text verbatim`,
  );
}

/** Criterion 9: barcode scans live in their own array and nowhere else - ADR-1. */
function checkBarcodeSeparation(file: BenchmarkExport): void {
  const scanIds = new Set(file.barcodeScans.map((scan) => scan.id));

  for (const attempt of file.attempts) {
    check(!scanIds.has(attempt.id), '9', `${attempt.id} appears in both attempts and barcodeScans`);
  }

  // A barcode scan has no image, no engine, no parsed date and no cost. If one had been folded into
  // `attempts` it would have had to arrive as a row of nulls, so this checks the shape too.
  check(
    file.attempts.every((attempt) => attempt.imageId.length > 0),
    '9',
    'an attempt has no imageId, which is what a barcode scan folded into attempts would look like',
  );

  console.log(
    `Barcode separation: ${file.barcodeScans.length} scan(s) in their own array, 0 in attempts`,
  );
}

/**
 * Criterion 7: the medians on screen are reproducible from the file, and by two implementations.
 */
function checkMedians(file: BenchmarkExport): void {
  const buckets = new Map<string, Attempt[]>();

  for (const attempt of file.attempts) {
    const bucket = buckets.get(key(attempt));
    if (bucket === undefined) {
      buckets.set(key(attempt), [attempt]);
    } else {
      bucket.push(attempt);
    }
  }

  // What the screen shows, from the shared grouping, indexed the same way.
  const fromShared = new Map<
    string,
    { total: number | null; engine: number | null; runs: number }
  >();

  for (const group of groupAttempts(file.attempts)) {
    for (const cohort of group.cohorts) {
      const cohortKey = [
        group.method,
        group.inputVariant,
        cohort.parserVersion,
        cohort.timingVersion,
        cohort.engine ?? 'no engine',
        cohort.promptVersion ?? '-',
      ].join(' · ');

      fromShared.set(cohortKey, {
        total: cohort.medianTotalMs,
        engine: cohort.medianEngineMs,
        runs: cohort.runCount,
      });
    }
  }

  console.log('\nMedian latency per method, variant and semantics — recomputed from the file:');
  console.log('  runs  median totalMs  median engineMs  extracted  cost         cohort');

  for (const [cohortKey, bucket] of [...buckets.entries()].sort()) {
    const totalMs = independentMedian(bucket.map((attempt) => attempt.timing.totalMs));
    const engineMs = independentMedian(
      bucket
        .map((attempt) => attempt.timing.engineMs)
        .filter((value): value is number => value !== null),
    );
    // Expired counts as extracted: the engine read the date and the product is old - ADR-7.
    const extracted = bucket.filter((a) => a.parse?.expiry != null).length;
    const priced = bucket
      .map((a) => a.ocr?.costEstimateUsd ?? null)
      .filter((value): value is number => value !== null);
    // `null`, never `0`: an unknown cost must not be indistinguishable from a free one - ADR-11.
    const cost = priced.length === 0 ? null : priced.reduce((sum, value) => sum + value, 0);

    const shown = fromShared.get(cohortKey);

    check(shown !== undefined, '7', `${cohortKey}: the shared grouping produced no such cohort`);
    check(
      shown?.runs === bucket.length,
      '7',
      `${cohortKey}: run count ${String(shown?.runs)} on screen against ${bucket.length} in the file`,
    );
    check(
      shown?.total === totalMs,
      '7',
      `${cohortKey}: median totalMs ${String(shown?.total)} on screen against ${String(totalMs)} recomputed`,
    );
    check(
      shown?.engine === engineMs,
      '7',
      `${cohortKey}: median engineMs ${String(shown?.engine)} on screen against ${String(engineMs)} recomputed`,
    );
    // The independent median and the shared one must also agree on the same input.
    check(
      median(bucket.map((attempt) => attempt.timing.totalMs)) === totalMs,
      '7',
      `${cohortKey}: shared median() disagrees with the longhand one`,
    );

    console.log(
      [
        String(bucket.length).padStart(6),
        (totalMs === null ? 'n/a' : totalMs.toFixed(1)).padStart(16),
        (engineMs === null ? 'n/a' : engineMs.toFixed(1)).padStart(17),
        `${extracted}/${bucket.length}`.padStart(11),
        (cost === null ? 'unpriced' : `$${cost.toFixed(4)}`).padStart(11),
        `  ${cohortKey}`,
      ].join(''),
    );
  }
}

function main(): void {
  const path = process.argv[2];

  if (path === undefined) {
    console.error('Usage: verify-export.ts <export.json>');
    process.exit(2);
  }

  const file = load(path);

  console.log(`Exported at ${file.exportedAt} · schema ${file.schemaVersion}`);
  console.log(`Filters:    ${JSON.stringify(file.filters)}`);
  console.log(`Versions:   parser ${file.parserVersions.join(', ') || 'none'}`);
  console.log(`            timing ${file.timingVersions.join(', ') || 'none'}`);
  console.log(`            pricing ${file.pricingVersions.join(', ') || 'none'}`);
  console.log(`Contents:   ${file.images.length} images, ${file.attempts.length} attempts`);

  if (file.timingVersions.length > 1) {
    // Not a failure - an export of the whole dataset legitimately spans the phase 06b boundary -
    // but the one thing a reader must not do with this file is take a median across it.
    console.log(
      '\nNOTE: this file spans more than one timingVersion. No latency median below crosses one,\n' +
        '      and any figure computed elsewhere must group by it too - ADR-22.',
    );
  }

  checkRowCompleteness(file);
  checkBarcodeSeparation(file);
  checkMedians(file);

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`);
    for (const failure of failures.slice(0, 40)) {
      console.error(`  [criterion ${failure.criterion}] ${failure.detail}`);
    }
    process.exit(1);
  }

  console.log('\nEvery check passed: criteria 6, 7, 8 and 9.');
}

main();
