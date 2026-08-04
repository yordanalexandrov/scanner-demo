import fs from 'node:fs';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Env } from './env.js';
import type { Db } from './db/client.js';
import { vlmOcrResponseSchema } from '@scanner-demo/shared';
import { createGcvEngine } from './engines/gcv.js';
import { createLocalOcrEngine } from './engines/localOcr.js';
import { createVlmEngine } from './engines/vlm.js';
import type { OcrEngine } from './engines/types.js';
import { selectVlmProvider } from './vlm/index.js';
import { InvalidImagePathError } from './lib/imagePaths.js';
import authPlugin from './plugins/auth.js';
import multipartPlugin from './plugins/multipart.js';
import { createAttemptRoutes } from './routes/attempts.js';
import { createBarcodeScanRoutes } from './routes/barcodeScans.js';
import { healthRoutes } from './routes/health.js';
import { createImageRoutes } from './routes/images.js';
import { createOcrRoutes } from './routes/ocr.js';

export interface BuildServerOptions {
  env: Env;
  db: Db;
  /**
   * The self-hosted engine, injectable so a test can stand a stub in front of the route without a
   * container. The process builds the real one from the environment - all three server-side engines
   * are behind the same interface.
   */
  localOcrEngine?: OcrEngine;
  /** Google Cloud Vision, injectable for the same reason: a test must not call a billed API. */
  gcvEngine?: OcrEngine;
  /** The VLM, injectable for the same reason again - a test must not spend tokens - phase 09. */
  vlmEngine?: OcrEngine;
}

/**
 * Builds the server without listening, so tests drive the same instance the process does through
 * `inject()`. A test that exercises a differently-assembled app proves less than it appears to.
 */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { env, db } = options;

  const localOcrEngine =
    options.localOcrEngine ??
    createLocalOcrEngine({
      baseUrl: env.OCR_SIDECAR_URL,
      timeoutMs: env.OCR_SIDECAR_TIMEOUT_MS,
    });

  // Constructing this costs nothing and calls nothing: the Vision client is built on first use, so
  // a server with no Google credentials starts and serves exactly as it did before phase 08.
  const gcvEngine =
    options.gcvEngine ??
    createGcvEngine({
      timeoutMs: env.GCV_TIMEOUT_MS,
      credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS ?? null,
    });

  // Constructing this costs nothing and calls nothing either: no HTTP client is built, no key is
  // checked. A server with no `OPENAI_API_KEY`, or with a `VLM_PROVIDER` nobody registered, starts
  // and serves exactly as it did before phase 09 - the failure surfaces on the VLM endpoint alone.
  const vlmEngine =
    options.vlmEngine ??
    createVlmEngine({
      provider: selectVlmProvider({
        provider: env.VLM_PROVIDER,
        model: env.VLM_MODEL,
        timeoutMs: env.VLM_TIMEOUT_MS,
        // The provider reads its own credential from here - see `vlm/types.ts` for why it is not
        // declared in `env.ts`.
        env: env.raw,
      }),
    });

  fs.mkdirSync(env.imageDir, { recursive: true });
  fs.mkdirSync(env.thumbDir, { recursive: true });

  const fastify = Fastify({
    logger: { level: env.LOG_LEVEL },
    // nginx terminates TLS and proxies here, so the client address and scheme arrive in headers.
    // Without this the logs record 127.0.0.1 for every request - ADR-17.
    trustProxy: true,
    bodyLimit: env.MAX_UPLOAD_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  // Requests and responses are both validated against the shared zod schemas. Fastify only invokes
  // the serializer for routes that declare a response schema, so the binary routes are untouched.
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: 'bad_request',
        message: error.validation.map((issue) => issue.message).join('; '),
      });
    }

    // A path that failed the containment check is a client error, not a server fault, and it must
    // not leak the resolved path back to whoever tried it.
    if (error instanceof InvalidImagePathError) {
      request.log.warn({ err: error }, 'rejected an image path');
      return reply.code(400).send({ error: 'bad_request', message: 'Not an image ID' });
    }

    if (isResponseSerializationError(error)) {
      // The server built a response its own contract rejects. That is a defect here, not there.
      request.log.error({ err: error }, 'response failed its schema');
      return reply
        .code(500)
        .send({ error: 'internal_error', message: 'The response failed validation' });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(statusCode).send({ error: 'internal_error', message: 'Request failed' });
    }

    return reply.code(statusCode).send({ error: 'bad_request', message: error.message });
  });

  fastify.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'No such route' }),
  );

  await fastify.register(authPlugin, { token: env.API_BEARER_TOKEN });
  await fastify.register(multipartPlugin, { maxUploadBytes: env.MAX_UPLOAD_BYTES });

  await fastify.register(healthRoutes);
  await fastify.register(createImageRoutes({ db, imageDir: env.imageDir, thumbDir: env.thumbDir }));
  await fastify.register(createBarcodeScanRoutes({ db }));
  await fastify.register(createAttemptRoutes({ db }));
  await fastify.register(
    createOcrRoutes({
      db,
      imageDir: env.imageDir,
      endpoints: [
        { url: '/api/v1/ocr/local', engine: localOcrEngine, label: 'the OCR sidecar' },
        { url: '/api/v1/ocr/gcv', engine: gcvEngine, label: 'Google Cloud Vision' },
        {
          url: '/api/v1/ocr/vlm',
          engine: vlmEngine,
          label: 'the VLM',
          // The one endpoint whose body is wider than an `OcrResponse`. Without this the serialiser
          // would strip the model's own answer and the prompt version on the way out - ADR-24.
          responseSchema: vlmOcrResponseSchema,
        },
      ],
    }),
  );

  return fastify;
}
