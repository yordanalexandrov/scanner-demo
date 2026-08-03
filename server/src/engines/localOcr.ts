import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { PRICING_VERSION, getPriceEntry, startTimer } from '@scanner-demo/shared';
import type { Block, OcrResponse } from '@scanner-demo/shared';
import { OcrEngineError } from './types.js';
import type { OcrEngine } from './types.js';

/**
 * The self-hosted engine: RapidOCR - PaddleOCR's PP-OCRv4 mobile models converted to ONNX - running
 * in a sidecar container reachable only on an internal Docker network.
 *
 * Everything this adapter has to compensate for was measured in
 * [the stage A spike](../../../docs/spikes/07-ocr-sidecar.md), and each compensation is a fact about
 * the container rather than a preference:
 *
 * - **It has no path parameter.** The shared image volume is mounted into the sidecar and the file
 *   is readable there, but no route accepts a path, so the bytes are read here and posted. The mount
 *   stays because it costs nothing and a future image may accept one - spike §§ 2, 3.
 * - **It reports no duration.** The library measures detection, classification and recognition
 *   separately and the API wrapper discards all three; no alternative image reports one either.
 *   `engineMs` is therefore this handler's own measurement of the HTTP call, and `engineMsScope` is
 *   `"inference+network"` rather than `"inference"` - phase 07 item 19, ADR-10.
 * - **Its geometry is a rotated quadrilateral**, not the axis-aligned box ADR-5 fixes.
 * - **It has no `rawText`** and no JSON error shape.
 */

/** The engine string, which is also the price-table key and the `method` the app records - ADR-11. */
const ENGINE_NAME = 'onnx-paddleocr';

/**
 * How far outside `[0, 1]` a confidence may stray before it stops being float arithmetic and starts
 * being a broken engine. A softmax mean cannot exceed 1 mathematically; IEEE-754 can, by ulps.
 */
const SCORE_EPSILON = 1e-6;

/**
 * One recognised region as the container reports it.
 *
 * `dt_boxes` is four `[x, y]` points in the uploaded image's own pixel space - RapidOCR multiplies
 * the boxes back by its preprocessing ratio before returning them, so no rescaling is needed here.
 */
const sidecarBlockSchema = z.object({
  rec_txt: z.string(),
  // Exactly four points, because that is what the container was measured to return - spike § 6.
  // Accepting three or one would turn a container regression into `bbox: [500, 500, 0, 0]`, which
  // looks like geometry and is not; an engine that changes its contract must fail loudly here.
  dt_boxes: z.tuple([
    z.tuple([z.number(), z.number()]),
    z.tuple([z.number(), z.number()]),
    z.tuple([z.number(), z.number()]),
    z.tuple([z.number(), z.number()]),
  ]),
  // A mean softmax probability, observed in 0.58-0.999. The window is `[0, 1]` widened by a
  // rounding epsilon and no further: a score of 7 is a broken engine, not a confident one, and
  // clamping it to 1 would record fabricated certainty - ADR-5.
  score: z
    .number()
    .min(-SCORE_EPSILON)
    .max(1 + SCORE_EPSILON),
});

/**
 * An object keyed by stringified index - `{"0": {…}, "1": {…}}` - and `{}` when nothing was found.
 *
 * Parsed rather than cast. The container is one person's build of a package whose last release was
 * 2025-05-22; a shape change arriving through a digest bump should fail here, naming the field,
 * rather than surface as `undefined` inside a benchmark result.
 */
const sidecarResponseSchema = z.record(z.string(), sidecarBlockSchema);

export interface LocalOcrOptions {
  /** Base URL of the sidecar on the internal network. No trailing slash required. */
  baseUrl: string;
  /**
   * Hard limit on the whole call. The control channel is a normal request/response with an explicit
   * timeout, never a file drop and a poll: polling adds latency, hides errors and races on partial
   * writes - spec, § Stack - Server.
   */
  timeoutMs: number;
}

/**
 * The axis-aligned bounding box of a rotated quadrilateral, as `[x, y, width, height]`.
 *
 * **The rotation is discarded, and that is a loss worth naming.** ADR-5 fixes one bbox format across
 * four engines because a comparison needs one; keeping the quad here would mean every consumer
 * handling two geometries, and ML Kit does not report one anyway. A steeply rotated line therefore
 * gets a box larger than the text it contains - visible in the result view, immaterial to the
 * parser, which uses boxes for anchor proximity rather than for rendering.
 */
function boundingBox(
  quad: readonly (readonly [number, number])[],
): [number, number, number, number] {
  const xs = quad.map(([x]) => x);
  const ys = quad.map(([, y]) => y);

  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

/**
 * Trims a score that is outside `[0, 1]` by less than an ulp or two back onto the boundary.
 *
 * The shared schema's `[0, 1]` is a hard bound and float arithmetic is not, so a value of
 * `1 + 1e-16` would fail serialisation and lose a whole recognition to a rounding artefact. Anything
 * further out never reaches this function: `sidecarBlockSchema` rejects it, because a score of 7 is
 * a broken engine rather than a confident one, and clamping *that* would record fabricated
 * certainty. ADR-5's `null` case does not arise here - this engine reports a confidence per block.
 */
function confidenceOf(score: number): number {
  return Math.min(1, Math.max(0, score));
}

export function createLocalOcrEngine(options: LocalOcrOptions): OcrEngine {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/ocr`;

  /**
   * The tail of the queue. **Calls to this engine are serialised, one at a time.**
   *
   * The spike measured two simultaneous requests at 4.529 s and 4.106 s against 1.906 s solo -
   * worse than serialising, because FastAPI runs the synchronous handler in a threadpool and both
   * inferences then fight over the same 1.5 CPUs. It says in as many words that if a second request
   * can ever overlap, the server should queue it (spike § 4, "Concurrency"). The app triggers one
   * method at a time, but two phones, a retry after a dropped connection, or a real request landing
   * on the startup warm-up all make overlap reachable - and an `engineMs` inflated by contention is
   * indistinguishable in the data from a slow engine, which is the failure this harness exists to
   * avoid.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function serialised<T>(work: () => Promise<T>): Promise<T> {
    // Runs whether or not the previous call succeeded - one failed recognition must not wedge the
    // engine for the rest of the process's life.
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }

  async function recogniseNow(input: { path: string; signal?: AbortSignal }): Promise<OcrResponse> {
    const bytes = await fs.readFile(input.path);

    // The header only - `sharp` does not decode the pixels for this. These are the dimensions of
    // the image the engine actually processed, which is what makes the boxes normalisable later.
    const metadata = await sharp(bytes).metadata();

    const form = new FormData();
    // The field name the container's OpenAPI document declares. `image_data` (base64) works too
    // and costs the same, but inflates 223 KB to 297 KB on the wire for nothing - spike § 2.
    form.append('image_file', new Blob([bytes]), path.basename(input.path));

    /**
     * Started here, **after** the queue has been acquired, so waiting for the engine is never
     * counted as time spent inside it. The wait is real and it is measured - it lands in
     * `serverTotalMs`, which is the handler's wall time - but calling it `engineMs` would report
     * queueing as inference.
     */
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal =
      input.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, input.signal]);

    const stopEngineTimer = startTimer();

    /** Which of the two signals fired decides what the failure *means* - a slow engine or a gone client. */
    const failure = (fallback: string, cause: unknown): OcrEngineError => {
      if (timeoutSignal.aborted) {
        return new OcrEngineError(`The OCR sidecar did not answer within ${options.timeoutMs} ms`, {
          timedOut: true,
          cause,
        });
      }
      if (input.signal?.aborted === true) {
        return new OcrEngineError('The caller went away before the OCR sidecar answered', {
          cancelled: true,
          cause,
        });
      }
      return new OcrEngineError(fallback, { cause });
    };

    let response: Response;
    try {
      response = await fetch(endpoint, { method: 'POST', body: form, signal });
    } catch (error: unknown) {
      // A paused, dead or unreachable container all land here, as does a client that hung up.
      throw failure('The OCR sidecar could not be reached', error);
    }

    if (!response.ok) {
      // The body is cancelled rather than read. A corrupt image, a truncated JPEG and an empty POST
      // all produce HTTP 500 with the plain string "Internal Server Error" - there is no JSON error
      // shape to read, and pretending otherwise would turn a clear failure into a parse error
      // (spike § 6). It still has to be released, or the connection is held until the collector
      // notices.
      await response.body?.cancel().catch(() => undefined);
      throw new OcrEngineError(`The OCR sidecar answered HTTP ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      // **The timeout covers the body, not just the headers.** A sidecar paused after sending its
      // status line fails here rather than above, and it is still a timeout: reporting it as a
      // malformed response would put "the engine was too slow" and "the engine was wrong" in the
      // same bucket - criterion 10.
      throw failure('The OCR sidecar answered 200 with a body that is not JSON', error);
    }

    // Stopped after the body is read rather than at the headers: the measurement is the cost of
    // the call, and a response half-read is not an answer.
    const engineMs = stopEngineTimer();

    const parsed = sidecarResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new OcrEngineError(
        `The OCR sidecar answered 200 with an unexpected shape: ${z.prettifyError(parsed.error)}`,
      );
    }

    // `{}` with HTTP 200 is the legitimate "no text found" answer and produces an empty result
    // rather than an error. An engine that reads nothing is a measurement about that engine.
    const blocks: Block[] = Object.values(parsed.data).map((block) => ({
      text: block.rec_txt,
      bbox: boundingBox(block.dt_boxes),
      confidence: confidenceOf(block.score),
    }));

    return {
      engine: ENGINE_NAME,
      // Assembled here, because the container returns no joined string. The order is the
      // container's detection order rather than reading order, and is deliberately not re-sorted:
      // re-ordering would make these results incomparable with the ones the spike scored.
      rawText: blocks.map((block) => block.text).join('\n'),
      blocks,
      engineMs,
      engineMsScope: 'inference+network',
      // Only the handler can measure its own wall time, so the route fills this in - ADR-10.
      serverTotalMs: null,
      imageWidth: metadata.width,
      imageHeight: metadata.height,
      // No tokens are involved. `null` is "not applicable here", not "not measured".
      usage: null,
      // Read from the shared table rather than written as a literal, so the one place a price can
      // be wrong stays the one place it is defined - ADR-11.
      costEstimateUsd: getPriceEntry(ENGINE_NAME)?.usd ?? null,
      pricingVersion: PRICING_VERSION,
    };
  }

  return {
    name: ENGINE_NAME,
    recognise: (input) => serialised(() => recogniseNow(input)),
  };
}
