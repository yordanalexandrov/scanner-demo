import fs from 'node:fs/promises';
import sharp from 'sharp';
import { thumbnailFilePath } from './imagePaths.js';
import { writeFileAtomically } from './images.js';

/**
 * Thumbnails are generated on first request and cached on disk - spec, § Image library. The grid
 * must never download full-resolution images to render, and it must not re-encode on every scroll
 * either.
 */

/** Long edge, in pixels. The grid is the only consumer, and it never shows more than this. */
export const THUMBNAIL_LONG_EDGE_PX = 320;

const THUMBNAIL_QUALITY = 80;

export interface ThumbnailResult {
  path: string;
  /** `false` when the cached file was reused. The acceptance criteria check exactly this. */
  generated: boolean;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the path to the thumbnail for `id`, generating it if the cache is cold.
 *
 * Always JPEG, regardless of the source type: a thumbnail is a derived artefact, so re-encoding it
 * destroys nothing the dataset is preserving. `rotate()` with no argument applies the source's EXIF
 * orientation, which is what makes the cached file agree with the recorded width and height.
 *
 * Two concurrent cold requests both generate. That is cheaper than a lock, and harmless: the write
 * is atomic, so a reader sees one complete file or the other.
 */
export async function ensureThumbnail(
  thumbDir: string,
  id: string,
  sourcePath: string,
): Promise<ThumbnailResult> {
  const path = thumbnailFilePath(thumbDir, id);

  if (await exists(path)) {
    return { path, generated: false };
  }

  const buffer = await sharp(sourcePath)
    .rotate()
    .resize(THUMBNAIL_LONG_EDGE_PX, THUMBNAIL_LONG_EDGE_PX, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_QUALITY })
    .toBuffer();

  await writeFileAtomically(path, buffer);

  return { path, generated: true };
}
