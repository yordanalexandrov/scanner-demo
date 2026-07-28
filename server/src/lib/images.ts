import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { isSupportedMimeType, supportedMimeTypes } from './imagePaths.js';

/**
 * Decoding and normalisation go through `sharp` and nothing else - spec, § Stack - Server. A
 * pure-JS decoder on this path would dominate the very latency numbers the harness exists to
 * measure.
 */

/** Thrown when the uploaded bytes are not an image this store accepts. Routes map it to a 400. */
export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

export interface DerivedImageMetadata {
  mimeType: string;
  /** Display dimensions: EXIF orientation applied, so they match what the thumbnail shows. */
  width: number;
  height: number;
  bytes: number;
}

function mimeTypeForSharpFormat(format: string, compression: string | undefined): string {
  switch (format) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    // sharp reports one format for the whole HEIF family; the codec is what separates a phone's
    // HEIC from an AVIF, and they are different media types to a client.
    case 'heif':
      return compression === 'av1' ? 'image/avif' : 'image/heic';
    default:
      throw new UnsupportedImageError(
        `Unsupported image format: ${format}. Accepted: ${supportedMimeTypes().join(', ')}`,
      );
  }
}

/**
 * Derives the metadata the client is not allowed to supply - ADR-3.
 *
 * The dimensions recorded are the auto-oriented ones. A phone photo carries an EXIF rotation, and
 * the raw stored width/height would then describe an image nobody ever sees. Note that this is
 * descriptive metadata for the library: an engine reports the dimensions it actually processed in
 * its own `OcrResponse`, precisely because engines disagree about EXIF.
 */
export async function deriveImageMetadata(buffer: Buffer): Promise<DerivedImageMetadata> {
  let metadata: Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new UnsupportedImageError('The uploaded bytes could not be decoded as an image');
  }

  const mimeType = mimeTypeForSharpFormat(metadata.format, metadata.compression);
  if (!isSupportedMimeType(mimeType)) {
    throw new UnsupportedImageError(`Unsupported image type: ${mimeType}`);
  }

  return {
    mimeType,
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    bytes: buffer.byteLength,
  };
}

/**
 * Writes to a temporary name and renames into place, so a crash mid-write cannot leave a truncated
 * file under an ID that the database says is complete. `rename` within one directory is atomic.
 *
 * The mode is explicit: phase 07 mounts this directory read-only into the OCR sidecar, which runs
 * as a different user. A file only the writer can read would fail there instead of here.
 */
export async function writeFileAtomically(filePath: string, buffer: Buffer): Promise<void> {
  const temporaryPath = path.join(path.dirname(filePath), `.${randomUUID()}.tmp`);

  await fs.writeFile(temporaryPath, buffer, { mode: 0o644 });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (cause) {
    await fs.rm(temporaryPath, { force: true });
    throw cause;
  }
}
