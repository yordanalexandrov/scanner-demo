import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Bearer-token authentication, applied to everything except `/health`.
 *
 * The token is the app's single credential and it is compiled into the APK, so it is deliberately
 * not treated as a secret - spec, § Hard constraint: no secrets in the app. It is a coarse gate on
 * a personal benchmark server. That is exactly why it is checked here, globally, rather than opted
 * into per route: an endpoint added later is authenticated unless someone deliberately exempts it.
 */

/** Route patterns, not raw URLs, so a query string cannot smuggle a request past the check. */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/api/v1/health']);

export interface AuthPluginOptions {
  token: string;
}

/**
 * Constant-time comparison. Length is compared first because `timingSafeEqual` throws on a
 * mismatch, and a length difference is not worth leaking a timing signal over either.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }

  const match = /^Bearer +(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  fastify.addHook('onRequest', async (request, reply) => {
    // Undefined for a request that matched no route. Treating that as authenticated-only means an
    // unauthenticated caller cannot probe which paths exist.
    const routePattern = request.routeOptions.url;

    if (routePattern !== undefined && PUBLIC_ROUTES.has(routePattern)) {
      return;
    }

    const token = presentedToken(request);

    if (token === null || !tokenMatches(token, options.token)) {
      await reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer')
        .send({ error: 'unauthorized', message: 'A valid bearer token is required' });
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
