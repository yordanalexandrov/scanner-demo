import { Directory, File, Paths } from 'expo-file-system';
import { measureAsync, now } from '@scanner-demo/shared';
import type { ImageRecord, Method } from '@scanner-demo/shared';
import { downloadImage } from '../api/images';
import { discard } from './capture';
import { runMethod, runMlKit } from './runMethod';
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
      sourceImageId: target.id,
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
 * Runs a server-side engine over a stored image.
 *
 * **Nothing is downloaded.** The server already holds the bytes and the engine reads them there, so
 * these paths have no `downloadMs` at all - `null`, because no download happened, not `0` - and no
 * temporary file to sweep. That asymmetry with {@link rerunMlKit} is the honest one: the on-device
 * engine needs the pixels on the handset and these do not, and hiding it by downloading them anyway
 * would add a segment to the measurement that the real path never pays.
 *
 * `startedAt` is still the first work attributable to this run, which here is the request itself -
 * ADR-22.
 */
function rerunOnServer(input: RerunInput, method: Method): Promise<RunMethodResult> {
  const { anchor, target } = input;

  const startedAt = now();

  return runMethod(method, {
    imageId: anchor.id,
    // The row the server reads. These differ exactly when an archived `original` is being re-run.
    sourceImageId: target.id,
    captureGroupId: anchor.captureGroupId,
    inputVariant: target.variant,
    // Unused by these methods - they recognise server-side - but part of the shared input, and the
    // stored figures are the server's own, derived from the bytes with sharp rather than claimed.
    uri: '',
    imageWidth: target.width,
    imageHeight: target.height,
    // The capture's own date, not today's, so a re-run a year later reaches the same verdict on
    // unchanged pixels - ADR-6.
    referenceDate: new Date(target.capturedAt),
    prior: {
      captureMs: null,
      downscaleMs: null,
      uploadMs: null,
      downloadMs: null,
    },
    startedAt,
  });
}

/** The self-hosted sidecar over a stored image - phase 07. */
export function rerunLocalOcr(input: RerunInput): Promise<RunMethodResult> {
  return rerunOnServer(input, 'onnx-paddleocr');
}

/** Google Cloud Vision over a stored image, called by the server on the app's behalf - phase 08. */
export function rerunGcv(input: RerunInput): Promise<RunMethodResult> {
  return rerunOnServer(input, 'gcv');
}

/**
 * The VLM over a stored image - phase 09.
 *
 * This is the path that makes criterion 6 observable: five presses produce five attempt rows, and
 * the Library's grouped view shows the spread. The non-determinism is the finding, which is why
 * nothing here retries, de-duplicates or averages on the way in.
 */
export function rerunVlm(input: RerunInput): Promise<RunMethodResult> {
  return rerunOnServer(input, 'vlm');
}

/**
 * One re-run of one method, dispatched by name.
 *
 * The single place that decides which function a method maps to on this path. The detail screen's
 * single-method buttons and its "re-run all" both go through it, so a method cannot be wired into
 * one and forgotten in the other - which would leave a gap in the comparison that looks like a
 * method nobody ran.
 */
export function rerunMethod(method: Method, input: RerunInput): Promise<RunMethodResult> {
  // The on-device path is the one that needs the pixels on the handset, so it is the one that
  // downloads them. Everything else recognises where the bytes already are.
  return method === 'mlkit' ? rerunMlKit(input) : rerunOnServer(input, method);
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
      onResult(method, await rerunMethod(method, input));
    } catch (failure: unknown) {
      onResult(method, failure instanceof Error ? failure : new Error('The re-run failed'));
    }
  }
}
