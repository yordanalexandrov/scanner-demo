import { z } from 'zod';
import { imageRecordSchema, imageSourceSchema, imageVariantSchema } from './image.js';

/**
 * Request and response contracts for the HTTP API.
 *
 * They live here for the same reason the data contracts do: the app builds these requests and the
 * server validates them, and two copies of a shape drift. The server validates every request and
 * every JSON response against exactly these schemas.
 */

/**
 * The upload metadata the client alone knows - the capture conditions.
 *
 * `width`, `height`, `bytes` and `mimeType` are deliberately absent: the server derives them from
 * the uploaded bytes with `sharp`, so the recorded metadata stays verifiable - ADR-3. The schema is
 * strict, so sending one of them is an error rather than a silently ignored field. That also means
 * a stray `path`-like key cannot ride along into a filesystem call.
 */
export const imageUploadMetaSchema = z.strictObject(
  imageRecordSchema.pick({
    captureGroupId: true,
    variant: true,
    source: true,
    torch: true,
    captureWidth: true,
    captureHeight: true,
    downscaled: true,
    capturedAt: true,
    capturedAtSource: true,
  }).shape,
);

export type ImageUploadMeta = z.infer<typeof imageUploadMetaSchema>;

export const imageUploadResponseSchema = z.object({
  imageId: z.string(),
});

export type ImageUploadResponse = z.infer<typeof imageUploadResponseSchema>;

export const IMAGE_LIST_DEFAULT_LIMIT = 50;
export const IMAGE_LIST_MAX_LIMIT = 100;

/**
 * Query parameters arrive as strings, hence the coercion.
 *
 * `from`/`to` are unix ms and filter on `capturedAt` - when the photo was taken, which is what a
 * date filter means to someone looking at the library. Pagination, by contrast, orders on
 * `createdAt`: that one is server-assigned and cannot be backdated by a gallery import, so it is
 * the only field a stable cursor can be built on.
 */
export const imageListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(IMAGE_LIST_MAX_LIMIT).default(IMAGE_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
  source: imageSourceSchema.optional(),
  variant: imageVariantSchema.optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

export type ImageListQuery = z.infer<typeof imageListQuerySchema>;

export const imageListResponseSchema = z.object({
  items: z.array(imageRecordSchema),
  /** `null` on the last page. Opaque to the client - decode it nowhere but the server. */
  nextCursor: z.string().nullable(),
});

export type ImageListResponse = z.infer<typeof imageListResponseSchema>;

/** The only unauthenticated response in the API. `uptimeMs` is monotonic, not a clock difference. */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  uptimeMs: z.number(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Every non-2xx response body in the API. One shape, so the app has one thing to render. */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
