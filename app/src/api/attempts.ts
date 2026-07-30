import { attemptCreateResponseSchema, attemptListResponseSchema } from '@scanner-demo/shared';
import type {
  AttemptCreate,
  AttemptCreateResponse,
  AttemptListResponse,
} from '@scanner-demo/shared';
import { apiGet, apiPost, type RequestOptions } from './client';

/**
 * The benchmark records.
 *
 * The app writes every one of them - the OCR endpoints are stateless and store nothing - ADR-15.
 * That is what makes `parseMs` comparable across the four methods: one CPU, one implementation.
 *
 * The consequence is that a measurement is lost if this post fails after a successful OCR call.
 * That failure is surfaced on screen rather than swallowed, so a lost record is visible and the run
 * can be repeated.
 */

export function createAttempt(
  attempt: AttemptCreate,
  options: RequestOptions = {},
): Promise<AttemptCreateResponse> {
  return apiPost('/api/v1/attempts', attempt, attemptCreateResponseSchema, options);
}

export function fetchAttempts(
  imageId: string,
  options: RequestOptions = {},
): Promise<AttemptListResponse> {
  return apiGet(
    `/api/v1/images/${encodeURIComponent(imageId)}/attempts`,
    attemptListResponseSchema,
    options,
  );
}
