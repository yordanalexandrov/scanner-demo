import { ocrRequestSchema, ocrResponseSchema, vlmOcrResponseSchema } from '@scanner-demo/shared';
import type { OcrResponse, VlmOcrResponse } from '@scanner-demo/shared';
import type { z } from 'zod';
import { apiPost } from './client';

/**
 * The server-side engines, over an image the server already holds.
 *
 * **Only an image ID crosses the wire.** The server constructs the path from it; the sidecar is on
 * an internal Docker network the phone cannot reach at all, and Google is reached with a credential
 * this app does not have and must never have - phases 07 and 08. Nothing here uploads pixels a
 * second time: they were uploaded once, when the capture was stored.
 *
 * The response is parsed with the same `ocrResponseSchema` the server validated it against, so an
 * on-device result and a server result are the same shape checked by the same code - which is the
 * property that makes the accuracy comparison a comparison of engines.
 */

/**
 * Longer than the client default of 10 s, and deliberately longer than the server's own limit on
 * the sidecar call.
 *
 * The server times the sidecar out at `OCR_SIDECAR_TIMEOUT_MS` and answers 504. If the phone gave
 * up first it would record "the request failed" where the truth is "the engine was too slow" -
 * a measurement about the network standing in for a measurement about the engine. A cold start on
 * the deployment box is 3.4-3.9 s and a request under production load has been seen at 6.4 s, so
 * the honest failure here is rare and the server names it when it happens.
 */
const OCR_TIMEOUT_MS = 45_000;

/**
 * One request shape, one timeout - the endpoint and its response schema are all that differs.
 *
 * The schema is a parameter rather than a constant because the VLM endpoint returns three fields
 * more than the other two, and it is the *same* schema the server declared for that route - so a
 * field renamed in `packages/shared` stops compiling on both sides at once instead of turning into
 * a stripped field that only a deployed APK ever sees.
 */
function recogniseOnServer<TResponse extends OcrResponse>(
  url: string,
  imageId: string,
  schema: z.ZodType<TResponse>,
): Promise<TResponse> {
  // Built through the shared schema rather than as an object literal, for the same reason.
  return apiPost(url, ocrRequestSchema.parse({ imageId }), schema, {
    timeoutMs: OCR_TIMEOUT_MS,
  });
}

export function recogniseWithSelfHostedOcr(imageId: string): Promise<OcrResponse> {
  return recogniseOnServer('/api/v1/ocr/local', imageId, ocrResponseSchema);
}

/**
 * Google Cloud Vision - **called through this server, never from here.**
 *
 * There is no Google SDK in this app, no API key in this app, and no code path that could add one
 * without the secret scanning noticing. The bearer token in the APK is the only credential the
 * handset carries, and it opens this API rather than a billed one - spec, § Hard constraint.
 */
export function recogniseWithGcv(imageId: string): Promise<OcrResponse> {
  return recogniseOnServer('/api/v1/ocr/gcv', imageId, ocrResponseSchema);
}

/**
 * The VLM - **called through this server, never from here** - phase 09.
 *
 * There is no OpenAI SDK in this app, no API key in this app, and no code path that could add one
 * without the secret scanning noticing. The bearer token in the APK is the only credential the
 * handset carries, and it opens this API rather than a billed one - spec, § Hard constraint.
 *
 * The response is wider than the other two: it carries the model's own `parsedDate` and reasoning,
 * and the version of the prompt that produced them. The app records all three on the attempt beside
 * the shared parser's reading of the same raw text - ADR-15, ADR-24.
 */
export function recogniseWithVlm(imageId: string): Promise<VlmOcrResponse> {
  return recogniseOnServer('/api/v1/ocr/vlm', imageId, vlmOcrResponseSchema);
}
