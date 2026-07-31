import {
  PARSER_VERSION,
  PRICING_VERSION,
  TIMING_VERSION,
  elapsed,
  measureAsync,
  parseExpiryDate,
} from '@scanner-demo/shared';
import type {
  AttemptCreate,
  ImageVariant,
  Millis,
  OcrResponse,
  ParseResult,
  Timing,
} from '@scanner-demo/shared';
import { createAttempt } from '../api/attempts';
import { describeDevice } from '../device';
import { recogniseWithMlKit } from './mlkit';

/**
 * One run of one method: recognise, parse, record.
 *
 * The parser runs here, on the phone, for **every** method - including the three server ones that
 * arrive in phases 07 to 09. One orchestration path instead of two, and `parseMs` becomes four
 * numbers measured on the same CPU by the same code rather than a phone core compared against a
 * VPS core - ADR-15.
 */

const DEVICE = describeDevice();

/** The segments already measured by the time a method starts. All `number | null` - ADR-10. */
export interface PriorTiming {
  captureMs: Millis | null;
  downscaleMs: Millis | null;
  uploadMs: Millis | null;
  downloadMs: Millis | null;
}

export interface RunMethodInput {
  imageId: string;
  captureGroupId: string;
  /**
   * Which pixels were read, not which row they came from. Both on-device runs of one capture hang
   * off the **uploaded** image, because that is the row that always exists - the original is
   * archived in the background and not at all when `ARCHIVE_ORIGINAL` is off. Distinguishing them
   * here is exactly what this field is for; if `imageId` already told you, it would be redundant
   * - ADR-2.
   */
  inputVariant: ImageVariant;
  uri: string;
  imageWidth: number;
  imageHeight: number;
  /** Defaults to the image's `capturedAt` at the call site, never to the clock here - ADR-6. */
  referenceDate: Date;
  prior: PriorTiming;
  /**
   * The first work attributable to this attempt, from `now()`. `totalMs` is measured from here to
   * the parsed result on the same phone clock - ADR-10, ADR-22.
   */
  startedAt: Millis;
}

export interface RunMethodResult {
  attempt: AttemptCreate;
  /** The server's row ID, or `null` when the record could not be stored. */
  attemptId: string | null;
  /** Why the record was not stored. A lost measurement is shown, never swallowed - ADR-15. */
  recordError: string | null;
}

function toMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

/**
 * Runs ML Kit over one variant and records the outcome - success or failure.
 *
 * A method that throws still produces an attempt row, with `error` set and `ocr: null`. A failure
 * is data: an engine that cannot read a package is a result about that engine, and dropping it
 * would quietly improve its scores.
 */
export async function runMlKit(input: RunMethodInput): Promise<RunMethodResult> {
  let ocr: OcrResponse | null = null;
  let parse: ParseResult | null = null;
  // `null` until the parser actually runs. A recognition that threw leaves nothing to parse, and
  // recording `0 ms` there would put a parse that never happened into every parse-time average -
  // ADR-10, and the global rule that a null measurement is null and never zero.
  let parseMs: Millis | null = null;
  let error: string | null = null;

  try {
    ocr = await recogniseWithMlKit(input.uri, {
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
    });

    const parsed = await measureAsync(async () =>
      parseExpiryDate(ocr?.blocks ?? [], { referenceDate: input.referenceDate }),
    );
    parse = parsed.value;
    parseMs = parsed.ms;
  } catch (failure: unknown) {
    error = toMessage(failure, 'ML Kit failed to read the image');
  }

  const timing: Timing = {
    ...input.prior,
    // The on-device path has no server, so nothing measured on another clock appears here - ADR-10.
    requestMs: null,
    engineMs: ocr?.engineMs ?? null,
    serverTotalMs: null,
    parseMs,
    totalMs: elapsed(input.startedAt),
  };

  const attempt: AttemptCreate = {
    imageId: input.imageId,
    captureGroupId: input.captureGroupId,
    method: 'mlkit',
    inputVariant: input.inputVariant,
    device: DEVICE,
    ocr,
    parse,
    vlm: null,
    timing,
    referenceDate: input.referenceDate.toISOString().slice(0, 10),
    parserVersion: PARSER_VERSION,
    timingVersion: TIMING_VERSION,
    pricingVersion: PRICING_VERSION,
    promptVersion: null,
    error,
  };

  try {
    const { id } = await createAttempt(attempt);
    return { attempt, attemptId: id, recordError: null };
  } catch (failure: unknown) {
    return {
      attempt,
      attemptId: null,
      recordError: toMessage(failure, 'The attempt could not be recorded'),
    };
  }
}
