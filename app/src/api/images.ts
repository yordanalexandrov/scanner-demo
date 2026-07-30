import { File } from 'expo-file-system';
import { imageListResponseSchema, imageUploadResponseSchema } from '@scanner-demo/shared';
import type {
  ImageListResponse,
  ImageRecord,
  ImageSource,
  ImageUploadMeta,
  ImageUploadResponse,
  ImageVariant,
} from '@scanner-demo/shared';
import {
  apiDownloadFile,
  apiGet,
  apiUploadFile,
  apiUrl,
  authHeaders,
  type RequestOptions,
} from './client';

/**
 * The image store.
 *
 * `width`, `height`, `bytes` and `mimeType` are deliberately absent from the metadata the app
 * sends: the server derives them from the bytes it received, which is what keeps the recorded
 * metadata verifiable rather than merely claimed - ADR-3.
 */

export function uploadImage(uri: string, meta: ImageUploadMeta): Promise<ImageUploadResponse> {
  return apiUploadFile(
    '/api/v1/images',
    new File(uri),
    imageUploadResponseSchema,
    // The server parses this part with `imageUploadMetaSchema`, which is strict, so a field that
    // does not belong is a 400 rather than something quietly dropped.
    { meta: JSON.stringify(meta) },
    { mimeType: 'image/jpeg' },
  );
}

/**
 * Everything the Library can narrow the set by.
 *
 * Every one of these is answered in SQL by an index-backed query. Fetching pages and filtering them
 * here would make what is on screen depend on how far the operator had scrolled.
 */
export interface ImageFilters {
  source?: ImageSource;
  variant?: ImageVariant;
  /** Every variant of one physical capture - the detail view needs the whole group, ADR-3. */
  captureGroupId?: string;
  /** Unix ms, inclusive, over `capturedAt` - when the photo was taken. */
  from?: number;
  to?: number;
  /** Whether any method has been run against the image's capture group - ADR-20. */
  hasAttempts?: boolean;
  /** Whether any attempt extracted a date, counting an expired one as extracted - ADR-7. */
  hasDate?: boolean;
}

export interface ImagePageRequest extends ImageFilters {
  limit?: number;
  cursor?: string;
}

export function fetchImages(
  params: ImagePageRequest = {},
  options: RequestOptions = {},
): Promise<ImageListResponse> {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    // Spelled out rather than left to `String(false)` being truthy on the far side: the server
    // accepts exactly "true" and "false" and 400s on anything else.
    query.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
  }

  const suffix = query.toString();
  return apiGet(
    `/api/v1/images${suffix === '' ? '' : `?${suffix}`}`,
    imageListResponseSchema,
    options,
  );
}

/**
 * An authenticated `<Image>` source.
 *
 * The token travels in a header rather than in the URL - ADR-14. Every route but `/health` requires
 * it, so an `<Image>` pointed at a bare URL renders as a silent 401 and an empty box.
 *
 * **The one-element array is load-bearing, not a style.** React Native 0.86's `Image.android.js`
 * lifts `headers` into the native prop only in its array branch:
 *
 * ```js
 * if (Array.isArray(source_)) {
 *   const {headers: sourceHeaders, ...} = source_[0];
 *   if (sourceHeaders != null) nativeProps.headers = sourceHeaders;
 * } else {
 *   const {uri, width, height} = source_;   // headers is never read
 * ```
 *
 * Passed as a plain object the headers are dropped without a warning, Fresco requests the image
 * unauthenticated, and the server answers 401 - which the image pipeline renders as a blank tile
 * rather than as an error. Verified on the device: 12 thumbnail requests, all 401, before this shape.
 */
type AuthenticatedImageSource = [{ uri: string; headers: Record<string, string> }];

export function imageSourceFor(id: string): AuthenticatedImageSource {
  return [{ uri: apiUrl(`/api/v1/images/${encodeURIComponent(id)}`), headers: authHeaders() }];
}

/**
 * The server-rendered thumbnail.
 *
 * The grid uses only this. A grid of full-resolution photographs would move tens of megabytes over
 * a phone's uplink to draw squares 110px wide, and phase 06 criterion 1 checks the access log for
 * exactly that.
 */
export function thumbnailSourceFor(id: string): AuthenticatedImageSource {
  return [
    { uri: apiUrl(`/api/v1/images/${encodeURIComponent(id)}/thumb`), headers: authHeaders() },
  ];
}

/**
 * Downloads a stored image into the cache so an on-device engine can read it.
 *
 * The file is named after the image ID, so the bytes on disk are traceable to the row they came
 * from, and the caller deletes it once the run is over - a Library that quietly accumulated
 * full-resolution originals would fill the phone one re-run at a time.
 */
export function downloadImage(image: ImageRecord, destination: File): Promise<File> {
  return apiDownloadFile(`/api/v1/images/${encodeURIComponent(image.id)}`, destination);
}
