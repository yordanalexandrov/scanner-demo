import { Directory, File, Paths } from 'expo-file-system';
import { measureAsync, now } from '@scanner-demo/shared';
import type { ImageRecord, Method } from '@scanner-demo/shared';
import { downloadImage } from '../api/images';
import { discard } from './capture';
import { runMlKit } from './runMethod';
import type { RunMethodResult } from './runMethod';

/**
 * Running a method again, over an image the server already holds.
 *
 * **No second orchestration path exists.** The image source is the only thing that differs from a
 * fresh capture, so this downloads the bytes and then hands them to the same `runMethod.ts` phase 05
 * uses. Two orchestrators would mean two places that decide what a `parseMs` is, and the numbers
 * from the Library and from the capture screen would stop being comparable.
 *
 * What the segments look like on this path, all of it required by ADR-10:
 *
 * - `captureMs`, `downscaleMs` and `uploadMs` are **`null`** - none of those happened here. `0`
 *   would enter every average as a real measurement of a thing that did not occur.
 * - `downloadMs` is populated, and it is its own segment. Folding it into `uploadMs` would describe
 *   bytes leaving the phone when they were arriving.
 * - `totalMs` runs from the first method work to the parsed result, on the phone's clock, so the
 *   segments still account for it: `downloadMs` + `engineMs` + `parseMs`, plus the directory
 *   preparation below. No operator interval from the original capture is present - ADR-22.
 */

export interface RerunInput {
  /** The row the attempt is recorded against - the group's uploaded row, ADR-20. */
  anchor: ImageRecord;
  /** The row whose bytes are read. The two are the same unless an `original` is being re-run. */
  target: ImageRecord;
}

/** Its own directory, so the sweep below can empty it without reasoning about anything else. */
const RERUN_TEMP_DIR = 'rerun';

/** A hint for the local decoder, not a contract: the canonical filename lives on the server. */
function localFileName(image: ImageRecord): string {
  const subtype = image.mimeType.split('/')[1] ?? 'jpg';
  return `${image.id}.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}

/**
 * Empties the download directory before a re-run.
 *
 * The `finally` below covers the normal path, but a process killed mid-run - by the system, or by
 * `adb shell am force-stop` during development - runs no `finally`, and what it leaves behind is a
 * full-resolution photograph. Doing it here rather than from the capture screen's sweep is what
 * makes it safe: a re-run is the only writer of this directory and the UI runs one at a time, so
 * every file present belongs to a run that has already ended.
 */
function sweepStaleDownloads(directory: Directory): void {
  try {
    for (const entry of directory.list()) {
      if (entry instanceof File) {
        discard(entry.uri);
      }
    }
  } catch {
    // A cache the app cannot enumerate is not a reason to refuse to re-run a measurement.
  }
}

/**
 * Downloads the selected variant and runs the on-device engine over it.
 *
 * The downloaded file is deleted whether the run succeeded or not. A Library that kept every
 * original it had ever re-run would fill the phone one press at a time, and phase 05's criterion 4 -
 * no full-size photo survives a flow - is not weaker here just because the bytes arrived over the
 * network instead of from the sensor.
 */
export async function rerunMlKit(input: RerunInput): Promise<RunMethodResult> {
  const { anchor, target } = input;

  // Directory preparation and download are both attributable to this re-run, so the method starts
  // immediately before either. The original capture's clock is deliberately unrelated - ADR-22.
  const startedAt = now();

  const directory = new Directory(Paths.cache, RERUN_TEMP_DIR);
  if (directory.exists) {
    sweepStaleDownloads(directory);
  } else {
    directory.create({ intermediates: true });
  }

  const downloaded = await measureAsync(() =>
    downloadImage(target, new File(directory, localFileName(target))),
  );

  try {
    return await runMlKit({
      imageId: anchor.id,
      captureGroupId: anchor.captureGroupId,
      // Which pixels were read. `target` and `anchor` differ exactly when this is `original`.
      inputVariant: target.variant,
      uri: downloaded.value.uri,
      // The server's own figures, derived from the stored bytes with sharp rather than claimed by a
      // client - ADR-3. Reading them off the file again here could only introduce a disagreement.
      imageWidth: target.width,
      imageHeight: target.height,
      // The capture's own date, not today's. A re-run a year later must reach the same verdict on
      // unchanged pixels - ADR-6.
      referenceDate: new Date(target.capturedAt),
      prior: {
        captureMs: null,
        downscaleMs: null,
        uploadMs: null,
        downloadMs: downloaded.ms,
      },
      startedAt,
    });
  } finally {
    discard(downloaded.value.uri);
  }
}

/**
 * "Re-run all methods on this image" - the one place a batch action belongs, because it operates on
 * a fixed stored image rather than on a live capture.
 *
 * It is still one independent run per method, recorded as one attempt each, merely triggered
 * together. A method that fails does not stop the ones after it: its failure is a row like any
 * other, and losing the remaining three measurements to it would be the opposite of what this
 * screen is for.
 */
export async function rerunMethods(
  input: RerunInput & { methods: readonly Method[] },
  onResult: (method: Method, result: RunMethodResult | Error) => void,
): Promise<void> {
  for (const method of input.methods) {
    try {
      if (method !== 'mlkit') {
        // Phases 07 to 09 add their own branches here. Until then the buttons are disabled and this
        // is unreachable from the UI; throwing beats silently recording nothing.
        throw new Error(`${method} is not available yet`);
      }
      onResult(method, await rerunMlKit(input));
    } catch (failure: unknown) {
      onResult(method, failure instanceof Error ? failure : new Error('The re-run failed'));
    }
  }
}
