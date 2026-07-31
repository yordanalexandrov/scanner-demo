import { ocrResponseSchema } from '@scanner-demo/shared';
import type { OcrResponse } from '@scanner-demo/shared';
import { apiPost } from './client';

/**
 * The self-hosted engine, over an image the server already holds.
 *
 * **Only an image ID crosses the wire.** The server constructs the path from it, and the sidecar
 * itself is on an internal Docker network the phone cannot reach at all - phase 07. Nothing here
 * uploads pixels a second time: they were uploaded once, when the capture was stored.
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

export function recogniseWithSelfHostedOcr(imageId: string): Promise<OcrResponse> {
  return apiPost('/api/v1/ocr/local', { imageId }, ocrResponseSchema, {
    timeoutMs: OCR_TIMEOUT_MS,
  });
}
