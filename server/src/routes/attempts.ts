import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import {
  apiErrorSchema,
  attemptCreateResponseSchema,
  attemptCreateSchema,
  attemptListResponseSchema,
  attemptSchema,
} from '@scanner-demo/shared';
import type { Attempt, AttemptCreate } from '@scanner-demo/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/client.js';
import { attempts, images } from '../db/schema.js';
import type { AttemptRow, NewAttemptRow } from '../db/schema.js';
import { isImageId } from '../lib/imagePaths.js';

/**
 * The benchmark records.
 *
 * The app is the sole author of every row here and the server writes none of its own - ADR-15. That
 * is what keeps the four methods independent: an engine cannot influence what gets recorded about
 * it, and `parseMs` compares four numbers measured on the same CPU by the same code.
 *
 * Re-running a method **appends**. Nothing on this path updates or overwrites an existing row.
 */

export interface AttemptRoutesOptions {
  db: Db;
}

const ERROR_RESPONSES = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
} as const;

const imageParamsSchema = z.object({
  id: z.string().refine(isImageId, 'Not an image ID'),
});

/**
 * Flattens the parts of the payload that get filtered, sorted or grouped into their own columns.
 *
 * Every one of them is derived here, on write, and never afterwards: the JSON is the record and
 * these are its index. A column edited on its own would disagree with the payload it came from, and
 * nothing would say which of the two was right.
 */
function toRow(attempt: AttemptCreate, id: string, createdAt: number): NewAttemptRow {
  return {
    id,
    imageId: attempt.imageId,
    captureGroupId: attempt.captureGroupId,
    method: attempt.method,
    inputVariant: attempt.inputVariant,
    engine: attempt.ocr?.engine ?? null,
    device: attempt.device,

    expiryDate: attempt.parse?.expiry?.date ?? null,
    expiryStatus: attempt.parse?.expiry?.status ?? null,
    expiryPrecision: attempt.parse?.expiry?.precision ?? null,
    parseRule: attempt.parse?.rule ?? null,

    totalMs: attempt.timing.totalMs,
    engineMs: attempt.timing.engineMs,
    costEstimateUsd: attempt.ocr?.costEstimateUsd ?? null,

    referenceDate: attempt.referenceDate,
    pricingVersion: attempt.pricingVersion,
    promptVersion: attempt.promptVersion,
    error: attempt.error,

    ocrJson: attempt.ocr === null ? null : JSON.stringify(attempt.ocr),
    parseJson: attempt.parse === null ? null : JSON.stringify(attempt.parse),
    vlmJson: attempt.vlm === null ? null : JSON.stringify(attempt.vlm),
    timingJson: JSON.stringify(attempt.timing),

    createdAt,
  };
}

/**
 * Rebuilds the record from the JSON, not from the flattened columns.
 *
 * The direction matters: reading `expiryDate` back out of its column would return whatever the
 * column happens to hold, while reading it out of `parseJson` returns what the parser actually said.
 * The result is parsed against the shared schema, so a drift between the two sides fails loudly here
 * rather than surfacing as a missing field on a screen.
 */
function toAttempt(row: AttemptRow): Attempt {
  return attemptSchema.parse({
    id: row.id,
    imageId: row.imageId,
    captureGroupId: row.captureGroupId,
    method: row.method,
    inputVariant: row.inputVariant,
    device: row.device,
    ocr: row.ocrJson === null ? null : JSON.parse(row.ocrJson),
    parse: row.parseJson === null ? null : JSON.parse(row.parseJson),
    vlm: row.vlmJson === null ? null : JSON.parse(row.vlmJson),
    timing: JSON.parse(row.timingJson),
    referenceDate: row.referenceDate,
    pricingVersion: row.pricingVersion,
    promptVersion: row.promptVersion,
    error: row.error,
    createdAt: row.createdAt,
  });
}

export function createAttemptRoutes(options: AttemptRoutesOptions): FastifyPluginAsyncZod {
  const { db } = options;

  return async (fastify) => {
    fastify.post(
      '/api/v1/attempts',
      {
        schema: {
          body: attemptCreateSchema,
          response: { 201: attemptCreateResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        // The foreign key would catch this, but a 404 naming the image is a better answer to the
        // app than a constraint violation turned into a 500.
        const image = db
          .select({ id: images.id })
          .from(images)
          .where(eq(images.id, request.body.imageId))
          .get();

        if (image === undefined) {
          return reply.code(404).send({ error: 'not_found', message: 'No such image' });
        }

        const id = randomUUID();

        // eslint-disable-next-line no-restricted-syntax -- ordered timestamp, not a duration
        const createdAt = Date.now();

        db.insert(attempts)
          .values(toRow(request.body, id, createdAt))
          .run();

        return reply.code(201).send({ id });
      },
    );

    fastify.get(
      '/api/v1/images/:id/attempts',
      {
        schema: {
          params: imageParamsSchema,
          response: { 200: attemptListResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const rows = db
          .select()
          .from(attempts)
          .where(eq(attempts.imageId, request.params.id))
          .orderBy(desc(attempts.createdAt), desc(attempts.id))
          .all();

        return reply.send({ items: rows.map(toAttempt) });
      },
    );
  };
}
