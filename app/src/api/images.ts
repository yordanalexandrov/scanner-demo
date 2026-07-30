import { File } from 'expo-file-system';
import { imageListResponseSchema, imageUploadResponseSchema } from '@scanner-demo/shared';
import type { ImageListResponse, ImageUploadMeta, ImageUploadResponse } from '@scanner-demo/shared';
import { apiGet, apiUploadFile, type RequestOptions } from './client';

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

export function fetchImages(
  params: { limit?: number; cursor?: string } = {},
  options: RequestOptions = {},
): Promise<ImageListResponse> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit));
  }
  if (params.cursor !== undefined) {
    query.set('cursor', params.cursor);
  }

  const suffix = query.toString();
  return apiGet(
    `/api/v1/images${suffix === '' ? '' : `?${suffix}`}`,
    imageListResponseSchema,
    options,
  );
}
