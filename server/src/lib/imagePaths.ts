import path from 'node:path';

/**
 * Every filesystem path in this server is built here, from an image ID the server itself minted.
 *
 * A path must never arrive from a client and reach a filesystem call - spec, § Stack - Server. Two
 * independent guards enforce that, and both are deliberate rather than redundant:
 *
 * 1. The ID must be a UUID v4. `../../etc/passwd` is not one, so it is rejected before a path is
 *    ever constructed.
 * 2. The resolved path is verified to stay inside the base directory. This is the guard that still
 *    holds if guard 1 is ever loosened - and the one the specification names explicitly.
 */

const IMAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The formats accepted on upload, and the extension each is stored under.
 *
 * SVG and raw are absent on purpose. `sharp` will decode an SVG, but an SVG is a document with a
 * scripting surface rather than a photograph, and nothing in this dataset should be one.
 */
const EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/avif': 'avif',
});

/** Thrown for anything the caller could have got wrong. Routes map it to a 400. */
export class InvalidImagePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidImagePathError';
  }
}

export function isImageId(value: string): boolean {
  return IMAGE_ID_PATTERN.test(value);
}

export function isSupportedMimeType(mimeType: string): boolean {
  return Object.hasOwn(EXTENSION_BY_MIME_TYPE, mimeType);
}

export function supportedMimeTypes(): readonly string[] {
  return Object.keys(EXTENSION_BY_MIME_TYPE);
}

export function extensionForMimeType(mimeType: string): string {
  const extension = EXTENSION_BY_MIME_TYPE[mimeType];
  if (extension === undefined) {
    throw new InvalidImagePathError(`Unsupported image type: ${mimeType}`);
  }
  return extension;
}

/**
 * Resolves `fileName` inside `baseDir` and refuses to return anything outside it.
 *
 * The trailing separator matters: without it, `/data/images-other` would pass a naive prefix test
 * against a base of `/data/images`.
 */
export function resolveInside(baseDir: string, fileName: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, fileName);

  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new InvalidImagePathError('Resolved path escapes the image directory');
  }

  return resolved;
}

/** Where the bytes of `id` live. The extension follows the server-detected type, not the client. */
export function imageFilePath(baseDir: string, id: string, mimeType: string): string {
  if (!isImageId(id)) {
    throw new InvalidImagePathError(`Not an image ID: ${id}`);
  }
  return resolveInside(baseDir, `${id}.${extensionForMimeType(mimeType)}`);
}

/** Thumbnails are always JPEG - they are derived artefacts, not preserved bytes. */
export function thumbnailFilePath(baseDir: string, id: string): string {
  if (!isImageId(id)) {
    throw new InvalidImagePathError(`Not an image ID: ${id}`);
  }
  return resolveInside(baseDir, `${id}.jpg`);
}
