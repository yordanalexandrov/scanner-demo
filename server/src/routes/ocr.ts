import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  apiErrorSchema,
  ocrRequestSchema,
  ocrResponseSchema,
  startTimer,
} from '@scanner-demo/shared';
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

/**
 * The shared request shape, narrowed by the guard only the server can apply.
 *
 * The *shape* lives in `packages/shared` because the app builds it and the server validates it, and
 * two copies drift. The *UUID check* is added here rather than there because it is a security
 * boundary, not a contract: it is the guard that stops `../../etc/passwd` before a path is ever
 * constructed, and a guard belongs on the side that owns the filesystem. `imageParamsSchema` in the
 * image routes is layered the same way.
 */
const localOcrBodySchema = ocrRequestSchema.extend({
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

        /**
         * Cancels the recognition when the phone hangs up.
         *
         * Two cores are shared with production - ADR-18 - and the engine runs one call at a time,
         * so an inference nobody is waiting for is not merely wasted: it holds the queue and
         * inflates the `engineMs` of whichever request is behind it, including the retry the same
         * phone is about to send.
         *
         * **The signal is the response socket, not the request stream.** `request.raw` emits
         * `close` as soon as its body has been consumed - for a small JSON body, milliseconds in,
         * with the client still perfectly present. Listening there cancelled every request
         * immediately; caught against the real container, because `inject()` does not model the
         * distinction. `reply.raw` closes when the connection does, and `writableEnded` separates
         * "the client left" from "we finished answering".
         */
        const abandoned = new AbortController();

        reply.raw.on('close', () => {
          if (!reply.raw.writableEnded) {
            abandoned.abort();
          }
        });

        let ocr;
        try {
          ocr = await engine.recognise({
            imageId: row.id,
            path: imageFilePath(imageDir, row.id, row.mimeType),
            signal: abandoned.signal,
          });
        } catch (error: unknown) {
          if (error instanceof OcrEngineError) {
            if (error.cancelled) {
              // Not a fact about the engine. Logged as what it is - and there is no longer a
              // connection to answer on, so nothing is sent.
              request.log.warn({ imageId: row.id }, 'the caller went away mid-recognition');
              return reply;
            }

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
        // is inside it, inseparable. What is left over is this handler's own work outside the call:
        // the row read, the file read, the response - and any wait for the engine queue, which is
        // real time this request spent and is deliberately not counted as inference - item 19,
        // ADR-10.
        return reply.send({ ...ocr, serverTotalMs: stopHandlerTimer() });
      },
    );
  };
}
