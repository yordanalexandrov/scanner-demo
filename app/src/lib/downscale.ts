import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { startTimer } from '@scanner-demo/shared';
import type { Millis } from '@scanner-demo/shared';
import { config } from '../config';

/**
 * The downscale before the measured upload.
 *
 * The specification calls this the single largest end-to-end latency win and asks for it to stay
 * configurable so the trade-off against accuracy can be measured rather than assumed - hence
 * `EXPO_PUBLIC_DOWNSCALE_LONG_EDGE` and `EXPO_PUBLIC_DOWNSCALE_QUALITY` rather than two constants.
 *
 * The on-device path reads both this output and the untouched original, and records the two as
 * separate attempts - which makes the difference between them a direct measurement of what the
 * downscale costs - ADR-2.
 */

export interface DownscaleResult {
  uri: string;
  width: number;
  height: number;
  /** The source's true dimensions, which are not always the ones its producer reported. */
  sourceWidth: number;
  sourceHeight: number;
  /** How long the resize took, for `timing.downscaleMs`. */
  ms: Millis;
  /**
   * `false` when the photo was already inside the target and was passed through untouched. The
   * upload's `downscaled` flag is recorded from this, so an image that never needed resizing is not
   * filed as though it had been - ADR-3.
   */
  resized: boolean;
}

/**
 * Resizes so that the **long** edge meets the target, and never enlarges: upscaling a small import
 * would invent pixels and then measure OCR against them.
 *
 * The orientation is read from the decoded image rather than taken from the caller. vision-camera
 * reports `photo.width`/`photo.height` in sensor orientation, so a portrait capture arrives claiming
 * to be 4000×3000 while the file on disk is 3000×4000. Trusting that produced an upload whose long
 * edge was 2133px against a configured 1600 - which quietly makes the configured value a fiction
 * and hands the server engines a different input from the one they were supposed to get.
 */
export async function downscaleForUpload(sourceUri: string): Promise<DownscaleResult> {
  const { downscaleLongEdge, downscaleQuality } = config;

  const done = startTimer();

  // One context, decoded once: the probe below and the resize that follows share it, so measuring
  // the true orientation does not cost a second decode of a full-resolution photograph.
  const context = ImageManipulator.manipulate(sourceUri);
  const probe = await context.renderAsync();

  const sourceWidth = probe.width;
  const sourceHeight = probe.height;
  const longEdge = Math.max(sourceWidth, sourceHeight);

  if (longEdge <= downscaleLongEdge) {
    return {
      uri: sourceUri,
      width: sourceWidth,
      height: sourceHeight,
      sourceWidth,
      sourceHeight,
      ms: done(),
      resized: false,
    };
  }

  const saved = await context
    // Only the long edge is constrained; the other is computed from it, so the ratio survives.
    .resize(
      sourceWidth >= sourceHeight ? { width: downscaleLongEdge } : { height: downscaleLongEdge },
    )
    .renderAsync()
    .then((image) =>
      image.saveAsync({
        // The manipulator takes 0-1; the configuration is in the 1-100 everyone quotes JPEG
        // quality in.
        compress: downscaleQuality / 100,
        format: SaveFormat.JPEG,
      }),
    );

  return {
    uri: saved.uri,
    width: saved.width,
    height: saved.height,
    sourceWidth,
    sourceHeight,
    ms: done(),
    resized: true,
  };
}
