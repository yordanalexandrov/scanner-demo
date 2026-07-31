import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { apiErrorSchema, ocrResponseSchema, startTimer } from '@scanner-demo/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/client.js';
import { images } from '../db/schema.js';
import { imageFilePath, isImageId } from '../lib/imagePaths.js';
import { OcrEngineError } from '../engines/types.js';
import type { OcrEngine } from '../engines/types.js';

export interface OcrRoutesOptions {
  db: Db;
  imageDir: string;
  engine: OcrEngine;
}

/**
 * `POST /api/v1/ocr/local` - the self-hosted engine, over an image the server already holds.
 *
 * **The client sends an image ID and nothing that resembles a path.** The path is constructed here
 * from the stored row, through the same `imageFilePath` guard every other route uses: the ID must be
 * a UUID and the resolved path must stay inside the image directory. `{ imageId: "../../etc/passwd" }`
 * fails the first guard before anything is looked up - spec, § Stack - Server.
 *
 * **The app remains the sole author of attempt rows.** This endpoint recognises and returns; it
 * writes nothing. The phone parses the result and posts the attempt, so all four methods are
 * recorded by one code path and `parseMs` is four numbers from the same CPU - ADR-15.
 */

/** Strict, so a client that sends an extra field learns it was ignored rather than assuming it was not. */
const localOcrBodySchema = z.strictObject({
  imageId: z.string().refine(isImageId, 'Not an image ID'),
});

const ERROR_RESPONSES = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  /** The engine answered badly, or not at all. Its failure is not this server's fault. */
  502: apiErrorSchema,
  /** The engine did not answer inside the configured limit - a hung sidecar, never a hung request. */
  504: apiErrorSchema,
  500: apiErrorSchema,
} as const;

export function createOcrRoutes(options: OcrRoutesOptions): FastifyPluginAsyncZod {
  const { db, imageDir, engine } = options;

  return async (fastify) => {
    fastify.post(
      '/api/v1/ocr/local',
      {
        schema: {
          body: localOcrBodySchema,
          response: { 200: ocrResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        // Started before the row is read, because `serverTotalMs` is wall time inside the handler -
        // the database read and the file read are part of what this server costs, not free.
        const stopHandlerTimer = startTimer();

        const row = db.select().from(images).where(eq(images.id, request.body.imageId)).get();

        if (row === undefined) {
          return reply.code(404).send({ error: 'not_found', message: 'No such image' });
        }

        let ocr;
        try {
          ocr = await engine.recognise({
            imageId: row.id,
            path: imageFilePath(imageDir, row.id, row.mimeType),
          });
        } catch (error: unknown) {
          if (error instanceof OcrEngineError) {
            request.log.error({ err: error, imageId: row.id }, 'the OCR sidecar failed');

            return reply.code(error.timedOut ? 504 : 502).send({
              error: error.timedOut ? 'engine_timeout' : 'engine_failed',
              message: error.message,
            });
          }

          throw error;
        }

        // Filled in here rather than in the engine: only the handler can measure its own wall time.
        //
        // **`serverTotalMs - engineMs` is not the process boundary.** The container reports no
        // duration of its own, so `engineMs` is the whole HTTP call to the sidecar and the boundary
        // is inside it, inseparable. What is left over is this handler's own work outside the call -
        // the row read, the file read and the response - phase 07 item 19, ADR-10.
        return reply.send({ ...ocr, serverTotalMs: stopHandlerTimer() });
      },
    );
  };
}
