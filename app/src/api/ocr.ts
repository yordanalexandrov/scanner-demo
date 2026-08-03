import { ocrRequestSchema, ocrResponseSchema } from '@scanner-demo/shared';
import type { OcrResponse } from '@scanner-demo/shared';
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

/** One request shape, one response schema, one timeout - the endpoint is all that differs. */
function recogniseOnServer(url: string, imageId: string): Promise<OcrResponse> {
  // Built through the shared schema rather than as an object literal. The server validates the very
  // same schema, so a field that is renamed there stops compiling here instead of turning into a
  // 400 that only a deployed APK ever sees.
  return apiPost(url, ocrRequestSchema.parse({ imageId }), ocrResponseSchema, {
    timeoutMs: OCR_TIMEOUT_MS,
  });
}

export function recogniseWithSelfHostedOcr(imageId: string): Promise<OcrResponse> {
  return recogniseOnServer('/api/v1/ocr/local', imageId);
}

/**
 * Google Cloud Vision - **called through this server, never from here.**
 *
 * There is no Google SDK in this app, no API key in this app, and no code path that could add one
 * without the secret scanning noticing. The bearer token in the APK is the only credential the
 * handset carries, and it opens this API rather than a billed one - spec, § Hard constraint.
 */
export function recogniseWithGcv(imageId: string): Promise<OcrResponse> {
  return recogniseOnServer('/api/v1/ocr/gcv', imageId);
}
