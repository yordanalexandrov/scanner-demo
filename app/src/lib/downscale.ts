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
  /** How long the resize took, for `timing.downscaleMs`. */
  ms: Millis;
  /**
   * `false` when the photo was already inside the target and was passed through untouched. The
   * upload's `downscaled` flag is recorded from this, so an image that never needed resizing is not
   * filed as though it had been - ADR-3.
   */
  resized: boolean;
}

export interface DownscaleSource {
  uri: string;
  width: number;
  height: number;
}

/**
 * Resizes so that the **long** edge meets the target, whichever way the photo is oriented, and
 * never enlarges: upscaling a small import would invent pixels and then measure OCR against them.
 */
export async function downscaleForUpload(source: DownscaleSource): Promise<DownscaleResult> {
  const { downscaleLongEdge, downscaleQuality } = config;
  const longEdge = Math.max(source.width, source.height);

  const done = startTimer();

  if (longEdge <= downscaleLongEdge) {
    return {
      uri: source.uri,
      width: source.width,
      height: source.height,
      ms: done(),
      resized: false,
    };
  }

  const landscape = source.width >= source.height;

  const image = await ImageManipulator.manipulate(source.uri)
    // Only the long edge is given; the other is computed from it, so the aspect ratio survives.
    .resize(landscape ? { width: downscaleLongEdge } : { height: downscaleLongEdge })
    .renderAsync();

  const saved = await image.saveAsync({
    // The manipulator takes 0-1; the configuration is in the 1-100 everyone quotes JPEG quality in.
    compress: downscaleQuality / 100,
    format: SaveFormat.JPEG,
  });

  return { uri: saved.uri, width: saved.width, height: saved.height, ms: done(), resized: true };
}
