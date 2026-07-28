import { apiErrorSchema, elapsed, healthResponseSchema, now } from '@scanner-demo/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SERVER_VERSION } from '../version.js';

/**
 * The only unauthenticated route - spec, § Server API. It is what the nginx vhost and any uptime
 * check hit, and neither of those carries the app's bearer token.
 */

// Monotonic, captured at module load. `uptimeMs` is a duration, so it may not come near the wall
// clock: an NTP correction would otherwise make the server appear to have started in the future -
// ADR-10.
const BOOTED_AT = now();

export const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/api/v1/health',
    { schema: { response: { 200: healthResponseSchema, 500: apiErrorSchema } } },
    async () => ({
      ok: true as const,
      version: SERVER_VERSION,
      uptimeMs: elapsed(BOOTED_AT),
    }),
  );
};
