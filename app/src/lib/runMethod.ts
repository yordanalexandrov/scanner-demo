import {
  PARSER_VERSION,
  PRICING_VERSION,
  TIMING_VERSION,
  elapsed,
  measureAsync,
  now,
  parseExpiryDate,
} from '@scanner-demo/shared';
import type {
  AttemptCreate,
  ImageVariant,
  Method,
  Millis,
  OcrResponse,
  ParseResult,
  Timing,
} from '@scanner-demo/shared';
import { createAttempt } from '../api/attempts';
import { recogniseWithSelfHostedOcr } from '../api/ocr';
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
  /**
   * The row whose **bytes the server reads**, for the server-side methods. It differs from
   * `imageId` exactly when an archived `original` is being re-run: the attempt hangs off the
   * group's uploaded row - ADR-20 - while the pixels being recognised are the original's.
   *
   * On-device runs ignore it: they read `uri`, a file already on the handset.
   */
  sourceImageId: string;
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

/** What one recognition produced, before it becomes a row. `requestMs` is `null` on-device. */
interface Recognised {
  ocr: OcrResponse | null;
  requestMs: Millis | null;
  error: string | null;
}

/**
 * Parses, assembles the row and posts it - the half of a run that is identical for every method.
 *
 * It is one function rather than one per method on purpose. `parseMs` has to mean the same thing in
 * all four columns, and it only does if the same code measures the same parser on the same CPU;
 * `totalMs` has to start at the same point; a failure has to become a row rather than a gap in
 * every case. Four copies of this would be four opportunities for one of them to drift - ADR-15.
 */
async function record(
  input: RunMethodInput,
  method: Method,
  recognised: Recognised,
): Promise<RunMethodResult> {
  const { ocr } = recognised;

  let parse: ParseResult | null = null;
  // `null` until the parser actually runs. A recognition that threw leaves nothing to parse, and
  // recording `0 ms` there would put a parse that never happened into every parse-time average -
  // ADR-10, and the global rule that a null measurement is null and never zero.
  let parseMs: Millis | null = null;
  let error = recognised.error;

  if (ocr !== null && error === null) {
    try {
      const parsed = await measureAsync(async () =>
        parseExpiryDate(ocr.blocks, { referenceDate: input.referenceDate }),
      );
      parse = parsed.value;
      parseMs = parsed.ms;
    } catch (failure: unknown) {
      error = toMessage(failure, 'The result could not be parsed');
    }
  }

  const timing: Timing = {
    ...input.prior,
    requestMs: recognised.requestMs,
    // On the server paths these two are the server's own figures, on the server's clock. They are
    // nested inside `requestMs` and are never added to it or subtracted from it - ADR-10.
    engineMs: ocr?.engineMs ?? null,
    serverTotalMs: ocr?.serverTotalMs ?? null,
    parseMs,
    totalMs: elapsed(input.startedAt),
  };

  const attempt: AttemptCreate = {
    imageId: input.imageId,
    captureGroupId: input.captureGroupId,
    method,
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

/**
 * Runs ML Kit over one variant and records the outcome - success or failure.
 *
 * A method that throws still produces an attempt row, with `error` set and `ocr: null`. A failure
 * is data: an engine that cannot read a package is a result about that engine, and dropping it
 * would quietly improve its scores.
 */
export async function runMlKit(input: RunMethodInput): Promise<RunMethodResult> {
  let recognised: Recognised;

  try {
    const ocr = await recogniseWithMlKit(input.uri, {
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
    });
    // The on-device path has no server, so nothing measured on another clock appears here - ADR-10.
    recognised = { ocr, requestMs: null, error: null };
  } catch (failure: unknown) {
    recognised = {
      ocr: null,
      requestMs: null,
      error: toMessage(failure, 'ML Kit failed to read the image'),
    };
  }

  return record(input, 'mlkit', recognised);
}

/**
 * Runs the self-hosted sidecar over an image the server already holds, and records the outcome.
 *
 * **No pixels leave the phone here.** The bytes were uploaded once when the capture was stored, so
 * this posts an image ID and waits. That is why `uploadMs` is not re-measured on this path and why
 * `downloadMs` stays `null` even on a Library re-run: unlike ML Kit, this engine needs nothing on
 * the handset.
 *
 * `requestMs` is the phone's own round trip and `engineMs` / `serverTotalMs` are the server's, on a
 * clock this process shares nothing with. The gap between them is network time, and it is reported
 * as a labelled estimate from the two stored fields rather than computed into one - ADR-10.
 */
export async function runLocalOcr(input: RunMethodInput): Promise<RunMethodResult> {
  let recognised: Recognised;

  // Started outside the try, so the wait is measured on both paths. How long the phone waited
  // before a 504 arrived is the interesting half of a timeout; a row saying only "it broke" throws
  // that away. Consumers separate the two by `error`, which is why a failed run is still a row.
  const requestedAt = now();

  try {
    const ocr = await recogniseWithSelfHostedOcr(input.sourceImageId);
    recognised = { ocr, requestMs: elapsed(requestedAt), error: null };
  } catch (failure: unknown) {
    recognised = {
      ocr: null,
      requestMs: elapsed(requestedAt),
      error: toMessage(failure, 'The self-hosted engine failed to read the image'),
    };
  }

  return record(input, 'onnx-paddleocr', recognised);
}
