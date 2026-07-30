import { imageListResponseSchema, imageUploadResponseSchema } from '@scanner-demo/shared';
import type { ImageListResponse, ImageUploadMeta, ImageUploadResponse } from '@scanner-demo/shared';
import { apiGet, apiUpload, type RequestOptions } from './client';

/**
 * The image store.
 *
 * `width`, `height`, `bytes` and `mimeType` are deliberately absent from the metadata the app
 * sends: the server derives them from the bytes it received, which is what keeps the recorded
 * metadata verifiable rather than merely claimed - ADR-3.
 */

export interface UploadFile {
  uri: string;
  name: string;
  type: string;
}

export function uploadImage(
  file: UploadFile,
  meta: ImageUploadMeta,
  options: RequestOptions = {},
): Promise<ImageUploadResponse> {
  const form = new FormData();

  // React Native's FormData takes this shape for a file part and streams it from disk rather than
  // reading it into JS memory - which matters when the part is a full-resolution photograph.
  form.append('file', file as unknown as Blob);
  form.append('meta', JSON.stringify(meta));

  return apiUpload('/api/v1/images', form, imageUploadResponseSchema, options);
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
