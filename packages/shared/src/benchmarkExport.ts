import { z } from 'zod';
import { attemptSchema, methodSchema } from './schemas/attempt.js';
import type { Attempt } from './schemas/attempt.js';
import { barcodeScanSchema } from './schemas/barcode.js';
import type { BarcodeScan } from './schemas/barcode.js';
import { imageRecordSchema, imageSourceSchema, imageVariantSchema } from './schemas/image.js';
import type { ImageRecord } from './schemas/image.js';
import { parserVersionSchema } from './parserVersion.js';
import type { ParserVersion } from './parserVersion.js';
import { timingVersionSchema } from './timingVersion.js';
import type { TimingVersion } from './timingVersion.js';

/**
 * The JSON export - the analysis surface of the whole harness, phase 10 scope item 6.
 *
 * It carries **full rows, not a summary**: the engine's raw text verbatim, every candidate the
 * parser considered and why it rejected it, `engineMsScope`, `referenceDate`, and the three
 * versioned fields. A summary can be recomputed from the rows; the rows cannot be recovered from a
 * summary, and a file found in six months has to still be readable without this repository beside
 * it.
 *
 * The shape and the builder live here rather than in the app for the reason everything else in this
 * package does: the app writes the file and the verification script reads it back, and two
 * definitions of the same contract drift. The script re-validates against **this** schema, so an
 * export that parses is an export the harness itself would accept.
 */

/**
 * Bumped when a field is removed or changes meaning, not when one is added.
 *
 * A consumer that reads `"1"` may assume every field documented here is present and means what it
 * says. Adding a field cannot break that; taking one away can.
 */
export const EXPORT_SCHEMA_VERSION = '1' as const;

/**
 * The filters the export was taken under, `null` for each one left unset.
 *
 * They are recorded because the file is otherwise not self-describing: a set of attempts filtered
 * to `source: "camera"` and one that happens to contain only camera runs are indistinguishable
 * afterwards, and only the first supports a capture-latency figure. `null` here means "everything",
 * never "unknown".
 */
export const exportFiltersSchema = z.object({
  method: methodSchema.nullable(),
  source: imageSourceSchema.nullable(),
  inputVariant: imageVariantSchema.nullable(),
  parserVersion: parserVersionSchema.nullable(),
  timingVersion: timingVersionSchema.nullable(),
});

export type ExportFilters = z.infer<typeof exportFiltersSchema>;

export const benchmarkExportSchema = z.object({
  /** ISO. A wall-clock instant recording when the file was written - never subtracted, ADR-10. */
  exportedAt: z.string(),
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  /**
   * Every version present in the rows below, so the reader sees at a glance whether the file mixes
   * semantics before computing anything over it. They are derived from the data rather than from
   * the constants this build happens to carry: an export of old rows must describe those rows.
   */
  pricingVersions: z.array(z.string()),
  parserVersions: z.array(parserVersionSchema),
  timingVersions: z.array(timingVersionSchema),
  filters: exportFiltersSchema,
  /**
   * Every image the exported attempts reference, and both variants of each capture group.
   *
   * The sibling row is included on purpose: an attempt with `inputVariant: "original"` is recorded
   * against the group's uploaded row - ADR-20 - so the dimensions and byte size of the pixels it
   * actually read exist only on the other row.
   */
  images: z.array(imageRecordSchema),
  attempts: z.array(attemptSchema),
  /**
   * Barcode scans, in their own array and absent from `attempts` - ADR-1. They have no image, no
   * engine and no parsed date, and the attempt filters above do not apply to them, so the array is
   * always the whole recorded set.
   */
  barcodeScans: z.array(barcodeScanSchema),
});

export type BenchmarkExport = z.infer<typeof benchmarkExportSchema>;

export interface BenchmarkExportInput {
  exportedAt: string;
  filters: ExportFilters;
  images: readonly ImageRecord[];
  attempts: readonly Attempt[];
  barcodeScans: readonly BarcodeScan[];
}

/** Sorted and de-duplicated, so two exports of the same rows are byte-identical and diffable. */
function distinct<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/**
 * Assembles the export from rows already fetched.
 *
 * Deliberately pure and deliberately not a fetcher: what to fetch is the app's business, while what
 * the file *is* has to be one definition that the app writes and the verifier reads.
 */
export function buildBenchmarkExport(input: BenchmarkExportInput): BenchmarkExport {
  const attempts = [...input.attempts];

  return {
    exportedAt: input.exportedAt,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    pricingVersions: distinct(attempts.map((attempt) => attempt.pricingVersion)),
    parserVersions: distinct<ParserVersion>(attempts.map((attempt) => attempt.parserVersion)),
    timingVersions: distinct<TimingVersion>(attempts.map((attempt) => attempt.timingVersion)),
    filters: input.filters,
    images: [...input.images],
    attempts,
    barcodeScans: [...input.barcodeScans],
  };
}
