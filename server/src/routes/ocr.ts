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

/** One endpoint, one engine. Phase 09 adds a third entry and no third handler. */
export interface OcrEndpoint {
  url: string;
  engine: OcrEngine;
  /** What the logs call it when it fails. The engine string is a price key, not a sentence. */
  label: string;
  /**
   * What this endpoint's 200 body is validated and serialised against. Defaults to the shared
   * `OcrResponse`, which is what three of the four methods return.
   *
   * **It is per endpoint because the serialiser strips what the schema does not name.** The VLM
   * returns three fields more than an `OcrResponse` - the model's own answer and the prompt version
   * - and a single shared schema here would drop them silently on the way out, leaving an endpoint
   * that looks like it works and an attempt row that cannot be attributed to a prompt. Declaring it
   * per endpoint is also what keeps those fields *off* the other three: an optional field on the
   * shared schema would let any engine ship a `parsedDate` that nothing checks - ADR-24.
   */
  responseSchema?: z.ZodType;
}

export interface OcrRoutesOptions {
  db: Db;
  imageDir: string;
  endpoints: readonly OcrEndpoint[];
}

/**
 * `POST /api/v1/ocr/:engine` - a server-side engine, over an image the server already holds.
 *
 * **Every engine is served by this one handler**, registered once per endpoint. That is not
 * tidiness: `serverTotalMs` has to be measured from the same point for all of them, a timeout has to
 * become the same 504 on all of them, and the path has to be constructed by the same guarded code on
 * all of them. Two handlers would be two definitions of what a server-side measurement is, and the
 * numbers from them would stop being comparable - which is the one thing this repository exists for.
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
const ocrBodySchema = ocrRequestSchema.extend({
  imageId: z.string().refine(isImageId, 'Not an image ID'),
});

const ERROR_RESPONSES = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  /** The engine answered badly, or not at all. Its failure is not this server's fault. */
  502: apiErrorSchema,
  /** The engine did not answer inside the configured limit - a hung engine, never a hung request. */
  504: apiErrorSchema,
  500: apiErrorSchema,
} as const;

export function createOcrRoutes(options: OcrRoutesOptions): FastifyPluginAsyncZod {
  const { db, imageDir, endpoints } = options;

  return async (fastify) => {
    for (const { url, engine, label, responseSchema } of endpoints) {
      fastify.post(
        url,
        {
          schema: {
            body: ocrBodySchema,
            response: { 200: responseSchema ?? ocrResponseSchema, ...ERROR_RESPONSES },
          },
        },
        async (request, reply) => {
          // Started before the row is read, because `serverTotalMs` is wall time inside the
          // handler - the database read and the file read are part of what this server costs.
          const stopHandlerTimer = startTimer();

          const row = db.select().from(images).where(eq(images.id, request.body.imageId)).get();

          if (row === undefined) {
            return reply.code(404).send({ error: 'not_found', message: 'No such image' });
          }

          /**
           * Cancels the recognition when the phone hangs up.
           *
           * Two cores are shared with production - ADR-18 - and the sidecar runs one call at a
           * time, so an inference nobody is waiting for is not merely wasted: it holds the queue
           * and inflates the `engineMs` of whichever request is behind it, including the retry the
           * same phone is about to send. An engine that cannot cancel ignores the signal, which is
           * what the cloud ones do - the interface makes that explicit rather than pretending.
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
                request.log.warn({ imageId: row.id, engine: label }, 'the caller went away');
                return reply;
              }

              request.log.error(
                { err: error, imageId: row.id, engine: label },
                'the engine failed',
              );

              return reply.code(error.timedOut ? 504 : 502).send({
                error: error.timedOut ? 'engine_timeout' : 'engine_failed',
                message: error.message,
              });
            }

            throw error;
          }

          // Filled in here rather than in the engine: only the handler can measure its own wall
          // time.
          //
          // **`serverTotalMs - engineMs` is not the process boundary**, on any of these engines.
          // Neither the container nor the cloud SDKs report a duration of their own, so `engineMs`
          // is the whole call out and the boundary is inside it, inseparable. What is left over is
          // this handler's own work outside the call: the row read, the file read, the response -
          // and any wait for the sidecar's queue, which is real time this request spent and is
          // deliberately not counted as inference - phase 07 item 19, ADR-10.
          return reply.send({ ...ocr, serverTotalMs: stopHandlerTimer() });
        },
      );
    }
  };
}
