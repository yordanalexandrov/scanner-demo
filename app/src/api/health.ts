import { healthResponseSchema, type HealthResponse } from '@scanner-demo/shared';
import { apiGet, type RequestOptions } from './client';

/**
 * The health check the Home screen polls.
 *
 * `/api/v1/health` is the only unauthenticated route on the server, but the request still carries
 * the bearer token - see the note in client.ts. It answers with a version and a monotonic
 * `uptimeMs`, which is why a server restart is visible in the app as the uptime dropping back to
 * near zero rather than as a silent gap.
 */

/** How often Home re-checks. Short enough that the review checkpoint is not a waiting game. */
export const HEALTH_POLL_INTERVAL_MS = 5_000;

/**
 * Deliberately shorter than the poll interval: a check that has not answered by the time the next
 * one is due is already the answer. Without this, a server that accepts connections but never
 * replies would stack pending requests instead of turning the indicator red.
 */
const HEALTH_TIMEOUT_MS = 4_000;

export function fetchHealth(options: RequestOptions = {}): Promise<HealthResponse> {
  return apiGet('/api/v1/health', healthResponseSchema, {
    timeoutMs: HEALTH_TIMEOUT_MS,
    ...options,
  });
}
