import { Directory, File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { measureAsync } from '@scanner-demo/shared';
import type { CapturedAtSource, ImageSource, Millis } from '@scanner-demo/shared';
import { uploadImage } from '../api/images';
import { config } from '../config';
import { downscaleForUpload } from './downscale';

/**
 * Everything between the shutter and an image row on the server.
 *
 * Kept out of the screen so that the ordering constraints are stated once, in one place, rather
 * than being implied by the sequence of `await`s in a component:
 *
 * - The **downscaled** variant is what gets uploaded on the measured path, and the measured path
 *   ends when that upload's response arrives.
 * - The full-resolution original is archived **after** that, never alongside it. Acceptance
 *   criterion 7 requires the archive request to start after the measured upload's response was
 *   sent, and requires `uploadMs` to be indistinguishable with archiving on and off - ADR-3.
 * - The photo does not survive the flow. `takePhoto()` writes a temporary file and nothing deletes
 *   it for us; criterion 4 checks that neither the gallery nor the app's own directories hold a
 *   full-size image once everything has settled.
 */

export interface CaptureSource {
  uri: string;
  width: number;
  height: number;
  source: ImageSource;
  /** Unix ms. The parser's `referenceDate` comes from this - ADR-6. */
  capturedAt: number;
  capturedAtSource: CapturedAtSource;
  /** `null` for a gallery import: no capture condition here was ours to set - ADR-3. */
  torch: boolean | null;
  /** `null` for a gallery import, which had no capture to time - ADR-10. */
  captureMs: Millis | null;
}

export interface StoredCapture {
  imageId: string;
  captureGroupId: string;
  /** The uploaded, downscaled variant - the bytes every engine will be compared on. */
  upload: { uri: string; width: number; height: number };
  /** The untouched capture, or `null` when the source was already inside the target size. */
  original: { uri: string; width: number; height: number } | null;
  downscaleMs: Millis;
  uploadMs: Millis;
  capturedAt: number;
}

/** Best-effort. A temporary file that outlives its flow is a defect; a failed delete is not fatal. */
export function discard(uri: string | null | undefined): void {
  if (uri === null || uri === undefined) {
    return;
  }
  try {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Nothing actionable: the file is in the cache directory either way, and reporting a failed
    // cleanup as a capture failure would lose a measurement over a temporary file.
  }
}

/**
 * Directories the capture flow leaves scratch files in. `takePhoto` writes into the cache root with
 * a library-specific prefix; the manipulator and the picker each own a subdirectory of it.
 *
 * A Library re-run's downloads are deliberately **not** here: they live in their own directory and
 * are swept by `lib/rerun.ts` instead. Sweeping them from this screen would be the one unsafe case -
 * a re-run started seconds ago on another screen is still downloading into it.
 */
const CAPTURE_TEMP_PREFIX = 'mrousavy';
const CAPTURE_TEMP_DIRS = ['ImageManipulator', 'ImagePicker'];

/**
 * Deletes scratch files left behind by earlier flows.
 *
 * `discard` covers the normal path, but it runs from JavaScript, and a process that is killed - by
 * the system, by a crash, or by `adb shell am force-stop` during development - runs no unmount
 * effect at all. Verifying acceptance criterion 4 found 32 MB of full-resolution photographs in the
 * cache from exactly those sessions, so a cleanup that only ever runs on the way out is not enough.
 *
 * Called when the capture screen mounts, which is the one moment that is provably safe: nothing is
 * in flight yet, so every file matching these patterns belongs to a flow that has already ended.
 */
export function sweepStaleCaptures(): void {
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && entry.name.startsWith(CAPTURE_TEMP_PREFIX)) {
        discard(entry.uri);
      }
    }

    for (const name of CAPTURE_TEMP_DIRS) {
      const directory = new Directory(Paths.cache, name);
      if (!directory.exists) {
        continue;
      }
      for (const entry of directory.list()) {
        if (entry instanceof File) {
          discard(entry.uri);
        }
      }
    }
  } catch {
    // A cache the app cannot enumerate is not a reason to refuse to take photographs.
  }
}

/**
 * Downscales, uploads, and returns the stored image. Ends the measured window.
 *
 * The original is deliberately **not** touched here - see {@link archiveOriginal}.
 */
export async function storeCapture(source: CaptureSource): Promise<StoredCapture> {
  const captureGroupId = randomUUID();

  const downscaled = await downscaleForUpload(source.uri);

  const uploaded = await measureAsync(async () =>
    uploadImage(downscaled.uri, {
      captureGroupId,
      variant: 'upload',
      source: source.source,
      torch: source.torch,
      // The dimensions the image actually has, not the ones its producer claimed - see the note in
      // downscale.ts about sensor orientation.
      captureWidth: downscaled.sourceWidth,
      captureHeight: downscaled.sourceHeight,
      downscaled: downscaled.resized,
      capturedAt: source.capturedAt,
      capturedAtSource: source.capturedAtSource,
    }),
  );

  return {
    imageId: uploaded.value.imageId,
    captureGroupId,
    upload: { uri: downscaled.uri, width: downscaled.width, height: downscaled.height },
    original: downscaled.resized
      ? { uri: source.uri, width: downscaled.sourceWidth, height: downscaled.sourceHeight }
      : null,
    downscaleMs: downscaled.ms,
    uploadMs: uploaded.ms,
    capturedAt: source.capturedAt,
  };
}

/**
 * Uploads the full-resolution original under the same `captureGroupId` - ADR-3.
 *
 * Called only after {@link storeCapture} has resolved, which is what keeps it outside the measured
 * window. It is fire-and-forget by design: the archive is for the dataset, and a failed archive
 * must not cost the measurement that already succeeded.
 */
export async function archiveOriginal(
  stored: StoredCapture,
  source: CaptureSource,
): Promise<boolean> {
  if (!config.archiveOriginal || stored.original === null) {
    return false;
  }

  await uploadImage(stored.original.uri, {
    captureGroupId: stored.captureGroupId,
    variant: 'original',
    source: source.source,
    torch: source.torch,
    captureWidth: stored.original.width,
    captureHeight: stored.original.height,
    downscaled: false,
    capturedAt: source.capturedAt,
    capturedAtSource: source.capturedAtSource,
  });

  return true;
}

/**
 * EXIF `DateTimeOriginal` is `YYYY:MM:DD HH:MM:SS` in local time, which `Date` does not parse.
 *
 * A gallery import that carries one is meaningfully better evidence than one that does not, because
 * this value becomes the parser's `referenceDate` and therefore decides `valid` against `expired`.
 * `capturedAtSource` records which of the two happened, so the weaker case stays visible - ADR-6.
 */
export function parseExifCapturedAt(exifDateTime: unknown): number | null {
  if (typeof exifDateTime !== 'string') {
    return null;
  }

  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(exifDateTime);
  if (match === null) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}
