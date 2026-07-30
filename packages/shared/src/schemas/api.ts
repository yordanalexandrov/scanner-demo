import { z } from 'zod';
import { attemptSchema } from './attempt.js';
import { barcodeScanSchema } from './barcode.js';
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
 * A boolean query parameter, spelled out.
 *
 * Deliberately not `z.coerce.boolean()`, which reads the string `"false"` as `true` - every
 * non-empty string is truthy. A filter that silently inverts itself would make the Library's counts
 * disagree with the database's and nothing on screen would say so.
 */
const queryBooleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

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
  /**
   * Every variant of one physical capture. The Library detail view needs the whole group, because
   * both variants are run targets and only one of them is guaranteed to exist - ADR-3.
   */
  captureGroupId: z.string().min(1).optional(),
  /**
   * Whether any method has been run against the image's **capture group**, not against the row
   * itself. Attempts hang off the group's uploaded row whichever variant was read - ADR-20 - so a
   * per-row reading would report every archived original as never benchmarked.
   */
  hasAttempts: queryBooleanSchema.optional(),
  /**
   * Whether any attempt in the group extracted a date. An `expired` result counts as extracted:
   * the engine read the date correctly and the product is old - ADR-7.
   */
  hasDate: queryBooleanSchema.optional(),
});

export type ImageListQuery = z.infer<typeof imageListQuerySchema>;

export const imageListResponseSchema = z.object({
  items: z.array(imageRecordSchema),
  /** `null` on the last page. Opaque to the client - decode it nowhere but the server. */
  nextCursor: z.string().nullable(),
});

export type ImageListResponse = z.infer<typeof imageListResponseSchema>;

/**
 * What the phone knows about a decode, and nothing else.
 *
 * `id` and `scannedAt` are absent by design: the server assigns both, exactly as it does for an
 * upload. `scannedAt` in particular is the field the listing is ordered and paginated on, and a
 * cursor built on a value the client chose would not survive two phones with skewed clocks.
 *
 * Strict, so a field the server would silently drop is a 400 instead. Sending `decodeMs` under a
 * misspelled key must not look like a successful measurement.
 */
export const barcodeScanCreateSchema = z.strictObject(
  barcodeScanSchema.pick({ value: true, decodeMs: true, device: true }).shape,
);

export type BarcodeScanCreate = z.infer<typeof barcodeScanCreateSchema>;

export const barcodeScanCreateResponseSchema = z.object({
  id: z.string(),
});

export type BarcodeScanCreateResponse = z.infer<typeof barcodeScanCreateResponseSchema>;

export const BARCODE_SCAN_LIST_DEFAULT_LIMIT = 50;
export const BARCODE_SCAN_LIST_MAX_LIMIT = 100;

/** Newest first, keyset-paginated on `scannedAt` - the same scheme the image listing uses. */
export const barcodeScanListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(BARCODE_SCAN_LIST_MAX_LIMIT)
    .default(BARCODE_SCAN_LIST_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export type BarcodeScanListQuery = z.infer<typeof barcodeScanListQuerySchema>;

export const barcodeScanListResponseSchema = z.object({
  items: z.array(barcodeScanSchema),
  /** `null` on the last page. Opaque to the client - decode it nowhere but the server. */
  nextCursor: z.string().nullable(),
});

export type BarcodeScanListResponse = z.infer<typeof barcodeScanListResponseSchema>;

/**
 * One benchmark record, as the app posts it.
 *
 * The app is the sole author of these rows and the server never fabricates one - ADR-15. `id` and
 * `createdAt` are the server's to assign, exactly as for an upload; everything else was measured on
 * the phone and is carried here unchanged.
 *
 * Not strict, deliberately, unlike the image upload metadata: this payload is nested several levels
 * deep and a strict object at every level would reject a response from an engine that added a field
 * to its own `usage` block. The schema still validates every field it knows about.
 */
export const attemptCreateSchema = attemptSchema.omit({ id: true, createdAt: true });

export type AttemptCreate = z.infer<typeof attemptCreateSchema>;

export const attemptCreateResponseSchema = z.object({
  id: z.string(),
});

export type AttemptCreateResponse = z.infer<typeof attemptCreateResponseSchema>;

/**
 * Every attempt against one image, newest first.
 *
 * Unpaginated on purpose: this is the attempts for a single image, which is a handful of rows even
 * after a dozen re-runs. The listing that needs paging is History, in phase 10.
 */
export const attemptListResponseSchema = z.object({
  items: z.array(attemptSchema),
});

export type AttemptListResponse = z.infer<typeof attemptListResponseSchema>;

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
