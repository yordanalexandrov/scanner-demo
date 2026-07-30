import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  apiErrorSchema,
  imageListQuerySchema,
  imageListResponseSchema,
  imageRecordSchema,
  imageUploadMetaSchema,
  imageUploadResponseSchema,
} from '@scanner-demo/shared';
import type { ApiError, ImageRecord } from '@scanner-demo/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../db/client.js';
import { images } from '../db/schema.js';
import type { ImageRow } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import type { ListCursor } from '../lib/cursor.js';
import { imageFilePath, isImageId } from '../lib/imagePaths.js';
import { imageListQuery } from '../lib/imageQuery.js';
import { deriveImageMetadata, UnsupportedImageError, writeFileAtomically } from '../lib/images.js';
import { ensureThumbnail } from '../lib/thumbnails.js';

export interface ImageRoutesOptions {
  db: Db;
  imageDir: string;
  thumbDir: string;
}

/**
 * Path parameters are validated before anything is looked up, so a value that is not an ID never
 * reaches the database and never reaches a filesystem call - spec, § Stack - Server. `..%2F..%2F`
 * decodes to something that is not a UUID and stops here with a 400.
 */
const imageParamsSchema = z.object({
  id: z.string().refine(isImageId, 'Not an image ID'),
});

/** Images are immutable and IDs are never reused, so a client may hold onto both indefinitely. */
const IMMUTABLE_CACHE_CONTROL = 'private, max-age=86400, immutable';

/**
 * Every status a route can answer with is declared, not only the happy one. The type provider then
 * refuses a `reply.code(404)` that no schema covers, which is how an undocumented error shape stops
 * being possible rather than merely discouraged.
 */
const ERROR_RESPONSES = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  413: apiErrorSchema,
  415: apiErrorSchema,
  500: apiErrorSchema,
} as const;

/** Annotated so the routes that serve bytes still get their error bodies shape-checked. */
const notFound: ApiError = { error: 'not_found', message: 'No such image' };

function toImageRecord(row: ImageRow): ImageRecord {
  // Parsed rather than cast: this is the one place a row crosses into the shared contract, and a
  // schema drift between the table and `imageRecordSchema` should fail loudly here.
  return imageRecordSchema.parse(row);
}

export function createImageRoutes(options: ImageRoutesOptions): FastifyPluginAsyncZod {
  const { db, imageDir, thumbDir } = options;

  /** Loads the row and the verified on-disk path together - neither is useful without the other. */
  function locate(id: string): { row: ImageRow; filePath: string } | null {
    const row = db.select().from(images).where(eq(images.id, id)).get();
    if (row === undefined) {
      return null;
    }
    return { row, filePath: imageFilePath(imageDir, row.id, row.mimeType) };
  }

  return async (fastify) => {
    fastify.post(
      '/api/v1/images',
      { schema: { response: { 201: imageUploadResponseSchema, ...ERROR_RESPONSES } } },
      async (request, reply) => {
        if (!request.isMultipart()) {
          return reply
            .code(415)
            .send({ error: 'unsupported_media_type', message: 'Expected multipart/form-data' });
        }

        let fileBuffer: Buffer | null = null;
        let truncated = false;
        let metaRaw: string | null = null;
        let unexpectedField: string | null = null;

        // Every part is consumed even after an error is detected: an unread multipart stream leaves
        // the connection in a state Fastify has to tear down, which turns a clean 400 into a reset.
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            const buffer = await part.toBuffer();
            if (part.fieldname === 'file' && fileBuffer === null) {
              fileBuffer = buffer;
              truncated = part.file.truncated;
            } else {
              unexpectedField ??= part.fieldname;
            }
          } else if (part.fieldname === 'meta') {
            metaRaw = String(part.value);
          } else {
            unexpectedField ??= part.fieldname;
          }
        }

        if (truncated) {
          return reply
            .code(413)
            .send({ error: 'payload_too_large', message: 'The uploaded file exceeded the limit' });
        }

        if (unexpectedField !== null) {
          return reply.code(400).send({
            error: 'bad_request',
            message: `Unexpected multipart field: ${unexpectedField}`,
          });
        }

        if (fileBuffer === null || metaRaw === null) {
          return reply.code(400).send({
            error: 'bad_request',
            message: 'Both a "file" part and a "meta" part are required',
          });
        }

        let metaJson: unknown;
        try {
          metaJson = JSON.parse(metaRaw);
        } catch {
          return reply
            .code(400)
            .send({ error: 'bad_request', message: 'The "meta" part is not valid JSON' });
        }

        const meta = imageUploadMetaSchema.safeParse(metaJson);
        if (!meta.success) {
          return reply.code(400).send({
            error: 'bad_request',
            message: z.prettifyError(meta.error),
          });
        }

        // Derived from the bytes, never from the client, so the recorded metadata is verifiable -
        // ADR-3.
        let derived;
        try {
          derived = await deriveImageMetadata(fileBuffer);
        } catch (error) {
          if (error instanceof UnsupportedImageError) {
            return reply.code(400).send({ error: 'bad_request', message: error.message });
          }
          throw error;
        }

        const id = randomUUID();
        const filePath = imageFilePath(imageDir, id, derived.mimeType);

        // `createdAt` is a wall-clock timestamp that is only ever ordered, never subtracted - the
        // one use of the wall clock ADR-10 permits.
        // eslint-disable-next-line no-restricted-syntax -- ordered timestamp, not a duration
        const createdAt = Date.now();

        // The file lands before the row. The reverse order can leave a row pointing at nothing,
        // which every later phase would have to defend against; an orphaned file is inert.
        await writeFileAtomically(filePath, fileBuffer);

        const row: ImageRow = {
          id,
          captureGroupId: meta.data.captureGroupId,
          variant: meta.data.variant,
          source: meta.data.source,
          width: derived.width,
          height: derived.height,
          bytes: derived.bytes,
          mimeType: derived.mimeType,
          torch: meta.data.torch,
          captureWidth: meta.data.captureWidth,
          captureHeight: meta.data.captureHeight,
          downscaled: meta.data.downscaled,
          capturedAt: meta.data.capturedAt,
          capturedAtSource: meta.data.capturedAtSource,
          createdAt,
        };

        db.insert(images).values(row).run();

        return reply.code(201).send({ imageId: id });
      },
    );

    fastify.get(
      '/api/v1/images',
      {
        schema: {
          querystring: imageListQuerySchema,
          response: { 200: imageListResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const { limit, cursor } = request.query;

        let decoded: ListCursor | null = null;
        if (cursor !== undefined) {
          decoded = decodeCursor(cursor);
          if (decoded === null) {
            return reply.code(400).send({ error: 'bad_request', message: 'Malformed cursor' });
          }
        }

        // Built in `lib/imageQuery.ts` so that the plan check in the tests explains this exact
        // query rather than a lookalike - phase 06 criterion 10.
        const rows = imageListQuery(db, request.query, decoded).all();

        const page = rows.slice(0, limit);
        const last = page.at(-1);

        return reply.send({
          items: page.map(toImageRecord),
          nextCursor:
            rows.length > limit && last !== undefined
              ? encodeCursor({ sortKey: last.createdAt, id: last.id })
              : null,
        });
      },
    );

    fastify.get(
      '/api/v1/images/:id',
      // No response schema: these two answer with bytes. Declaring one would type `reply.send` to
      // the union of the declared bodies and reject the stream. The error bodies below are still
      // the `apiErrorSchema` shape - they are just checked by the compiler rather than serialised
      // through it.
      { schema: { params: imageParamsSchema } },
      async (request, reply) => {
        const located = locate(request.params.id);
        if (located === null) {
          return reply.code(404).send(notFound);
        }

        // Served with the recorded type, byte for byte as received. Transcoding would destroy the
        // very bytes the dataset exists to preserve.
        return reply
          .type(located.row.mimeType)
          .header('Content-Length', String(located.row.bytes))
          .header('Cache-Control', IMMUTABLE_CACHE_CONTROL)
          .send(createReadStream(located.filePath));
      },
    );

    fastify.get(
      '/api/v1/images/:id/thumb',
      // No response schema: these two answer with bytes. Declaring one would type `reply.send` to
      // the union of the declared bodies and reject the stream. The error bodies below are still
      // the `apiErrorSchema` shape - they are just checked by the compiler rather than serialised
      // through it.
      { schema: { params: imageParamsSchema } },
      async (request, reply) => {
        const located = locate(request.params.id);
        if (located === null) {
          return reply.code(404).send(notFound);
        }

        const thumbnail = await ensureThumbnail(thumbDir, located.row.id, located.filePath);

        return (
          reply
            .type('image/jpeg')
            .header('Cache-Control', IMMUTABLE_CACHE_CONTROL)
            // Not a promise about correctness - it is how the acceptance criteria observe that the
            // second request came off the disk cache rather than through sharp again.
            .header('X-Thumbnail-Cache', thumbnail.generated ? 'MISS' : 'HIT')
            .send(createReadStream(thumbnail.path))
        );
      },
    );
  };
}
