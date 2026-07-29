import { randomUUID } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  apiErrorSchema,
  barcodeScanCreateResponseSchema,
  barcodeScanCreateSchema,
  barcodeScanListQuerySchema,
  barcodeScanListResponseSchema,
  barcodeScanSchema,
} from '@scanner-demo/shared';
import type { BarcodeScan } from '@scanner-demo/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/client.js';
import { barcodeScans } from '../db/schema.js';
import type { BarcodeScanRow } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';

/**
 * The two endpoints behind goal 1 of the project - ADR-1.
 *
 * The measurement itself is made on the phone and only recorded here. The server times nothing on
 * this path and must not: `decodeMs` came off the phone's monotonic clock, and anything this
 * process could contribute would come off a different one - ADR-10.
 */

export interface BarcodeScanRoutesOptions {
  db: Db;
}

const ERROR_RESPONSES = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  500: apiErrorSchema,
} as const;

function toBarcodeScan(row: BarcodeScanRow): BarcodeScan {
  // Parsed rather than cast, for the same reason the image listing parses its rows: this is where a
  // table and the shared contract meet, and a drift between them should fail loudly here.
  return barcodeScanSchema.parse(row);
}

export function createBarcodeScanRoutes(options: BarcodeScanRoutesOptions): FastifyPluginAsyncZod {
  const { db } = options;

  return async (fastify) => {
    fastify.post(
      '/api/v1/barcode-scans',
      {
        schema: {
          body: barcodeScanCreateSchema,
          response: { 201: barcodeScanCreateResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const id = randomUUID();

        // Wall clock, assigned here rather than accepted from the phone so that two handsets with
        // skewed clocks still paginate coherently. It is ordered, never subtracted - ADR-10.
        // eslint-disable-next-line no-restricted-syntax -- ordered timestamp, not a duration
        const scannedAt = Date.now();

        const row: BarcodeScanRow = { id, ...request.body, scannedAt };

        db.insert(barcodeScans).values(row).run();

        return reply.code(201).send({ id });
      },
    );

    fastify.get(
      '/api/v1/barcode-scans',
      {
        schema: {
          querystring: barcodeScanListQuerySchema,
          response: { 200: barcodeScanListResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const { limit, cursor } = request.query;

        const conditions = [];

        if (cursor !== undefined) {
          const decoded = decodeCursor(cursor);
          if (decoded === null) {
            return reply.code(400).send({ error: 'bad_request', message: 'Malformed cursor' });
          }
          // Newest first, so "after the cursor" means strictly older. `id` breaks ties, because ten
          // consecutive scans can easily share a millisecond.
          conditions.push(
            or(
              sql`${barcodeScans.scannedAt} < ${decoded.sortKey}`,
              and(
                eq(barcodeScans.scannedAt, decoded.sortKey),
                sql`${barcodeScans.id} < ${decoded.id}`,
              ),
            ),
          );
        }

        // One row beyond the page, purely to learn whether another page exists without a count(*).
        const rows = db
          .select()
          .from(barcodeScans)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(barcodeScans.scannedAt), desc(barcodeScans.id))
          .limit(limit + 1)
          .all();

        const page = rows.slice(0, limit);
        const last = page.at(-1);

        return reply.send({
          items: page.map(toBarcodeScan),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor({ sortKey: last.scannedAt, id: last.id })
              : null,
        });
      },
    );
  };
}
