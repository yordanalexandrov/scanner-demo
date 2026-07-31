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
 * One recognised region as the container reports it.
 *
 * `dt_boxes` is four `[x, y]` points in the uploaded image's own pixel space - RapidOCR multiplies
 * the boxes back by its preprocessing ratio before returning them, so no rescaling is needed here.
 */
const sidecarBlockSchema = z.object({
  rec_txt: z.string(),
  dt_boxes: z.array(z.tuple([z.number(), z.number()])).min(1),
  score: z.number(),
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
 * The recogniser's score is a mean softmax probability and is observed in 0.58-0.999, but the shared
 * schema's `[0, 1]` is a hard bound and float arithmetic is not. Saturating is the smallest possible
 * intervention; the alternative is a whole benchmark run failing serialisation over a rounding
 * artefact. Nothing else about the value is touched - ADR-5's `null` case does not arise on this
 * engine, which reports a confidence for every block.
 */
function confidenceOf(score: number): number {
  return Math.min(1, Math.max(0, score));
}

export function createLocalOcrEngine(options: LocalOcrOptions): OcrEngine {
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/ocr`;

  return {
    name: ENGINE_NAME,

    async recognise(input): Promise<OcrResponse> {
      const bytes = await fs.readFile(input.path);

      // The header only - `sharp` does not decode the pixels for this. These are the dimensions of
      // the image the engine actually processed, which is what makes the boxes normalisable later.
      const metadata = await sharp(bytes).metadata();

      const form = new FormData();
      // The field name the container's OpenAPI document declares. `image_data` (base64) works too
      // and costs the same, but inflates 223 KB to 297 KB on the wire for nothing - spike § 2.
      form.append('image_file', new Blob([bytes]), path.basename(input.path));

      const stopEngineTimer = startTimer();

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (error: unknown) {
        // A paused, dead or unreachable container all land here. `TimeoutError` is the one the
        // acceptance criteria exercise with `docker pause`, and it is reported as its own kind.
        const timedOut = error instanceof Error && error.name === 'TimeoutError';

        throw new OcrEngineError(
          timedOut
            ? `The OCR sidecar did not answer within ${options.timeoutMs} ms`
            : 'The OCR sidecar could not be reached',
          { timedOut, cause: error },
        );
      }

      if (!response.ok) {
        // Deliberately not parsed. A corrupt image, a truncated JPEG and an empty POST all produce
        // HTTP 500 with the plain string "Internal Server Error" - there is no JSON error shape to
        // read, and pretending otherwise would turn a clear failure into a parse error - spike § 6.
        throw new OcrEngineError(`The OCR sidecar answered HTTP ${response.status}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error: unknown) {
        throw new OcrEngineError('The OCR sidecar answered 200 with a body that is not JSON', {
          cause: error,
        });
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
    },
  };
}
