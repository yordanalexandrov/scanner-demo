import {
  attemptCreateResponseSchema,
  attemptListResponseSchema,
  attemptPageResponseSchema,
} from '@scanner-demo/shared';
import type {
  AttemptCreate,
  AttemptCreateResponse,
  AttemptListResponse,
  AttemptPageResponse,
  ImageSource,
  ImageVariant,
  Method,
  ParserVersion,
  TimingVersion,
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

/**
 * Everything History can narrow the benchmark set by.
 *
 * Every one of these is answered in SQL. Narrowing a fetched page here instead would make the
 * per-method medians on screen depend on how far the operator had scrolled - the same reason the
 * Library's filters are server-side, with more at stake, because these numbers are the deliverable.
 *
 * `source` and `inputVariant` are two different questions and are named apart on purpose: `source`
 * is where the photograph came from and gates every capture-latency figure, while `inputVariant` is
 * which pixels the run read and keeps the on-device path's two runs separate - ADR-2.
 */
export interface AttemptFilters {
  method?: Method;
  source?: ImageSource;
  inputVariant?: ImageVariant;
  parserVersion?: ParserVersion;
  timingVersion?: TimingVersion;
  /** Unix ms over `createdAt` - when the run happened, not when the photograph was taken. */
  from?: number;
  to?: number;
}

export interface AttemptPageRequest extends AttemptFilters {
  limit?: number;
  cursor?: string;
}

export function fetchAttemptPage(
  params: AttemptPageRequest = {},
  options: RequestOptions = {},
): Promise<AttemptPageResponse> {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    query.set(key, String(value));
  }

  const suffix = query.toString();
  return apiGet(
    `/api/v1/attempts${suffix === '' ? '' : `?${suffix}`}`,
    attemptPageResponseSchema,
    options,
  );
}
