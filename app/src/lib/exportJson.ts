import { Directory, File, Paths } from 'expo-file-system';
import { StorageAccessFramework } from 'expo-file-system/legacy';
import {
  ATTEMPT_LIST_MAX_LIMIT,
  IMAGE_LIST_MAX_LIMIT,
  BARCODE_SCAN_LIST_MAX_LIMIT,
  buildBenchmarkExport,
} from '@scanner-demo/shared';
import type {
  Attempt,
  BarcodeScan,
  BenchmarkExport,
  ExportFilters,
  ImageRecord,
} from '@scanner-demo/shared';
import { fetchAttemptPage } from '../api/attempts';
import type { AttemptFilters } from '../api/attempts';
import { fetchBarcodeScans } from '../api/barcodeScans';
import { fetchImages } from '../api/images';

/**
 * The JSON export - phase 10 scope item 6, and the analysis surface of the whole harness.
 *
 * The screen is for reading; **this file is what the numbers are computed from.** Accuracy scoring
 * against a hand-made key, a chart, a comparison against a later run - none of that happens in the
 * app, and all of it needs the rows rather than a summary. So the export carries full rows: the raw
 * OCR text verbatim, every candidate the parser considered and why it rejected it, `engineMsScope`,
 * `referenceDate`, and the three versioned fields. A summary can be recomputed from these; they
 * cannot be recovered from a summary.
 *
 * **Everything is fetched to exhaustion rather than taken from what is on screen.** History pages
 * as the operator scrolls, and an export of "whatever had loaded" would silently depend on how far
 * they had got - which is exactly the class of number this project exists not to produce.
 */

/** The whole set in as few round trips as the API allows. */
const PAGE_SIZE = ATTEMPT_LIST_MAX_LIMIT;

/**
 * A ceiling on the paging loops.
 *
 * Not expected to be reached - the dataset is hundreds of rows - and present because a server that
 * returned a cursor pointing at itself would otherwise spin forever on a phone with the screen on.
 * Hitting it throws rather than truncating: a silently short export is worse than no export.
 */
const MAX_PAGES = 500;

export interface ExportProgress {
  stage: 'attempts' | 'images' | 'barcode scans' | 'writing';
  /** Rows fetched so far in this stage. */
  count: number;
}

export interface CollectExportOptions {
  filters: ExportFilters;
  /** The same filters in query form. Kept separate so the file records what the server was asked. */
  query: AttemptFilters;
  onProgress?: (progress: ExportProgress) => void;
}

async function collectAttempts(options: CollectExportOptions): Promise<Attempt[]> {
  const rows: Attempt[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchAttemptPage({ ...options.query, limit: PAGE_SIZE, cursor });
    rows.push(...response.items);
    options.onProgress?.({ stage: 'attempts', count: rows.length });

    if (response.nextCursor === null) {
      return rows;
    }
    cursor = response.nextCursor;
  }

  throw new Error(`The attempts listing did not end after ${MAX_PAGES} pages`);
}

/**
 * Every image the exported attempts reference, **and the sibling variant of each capture group**.
 *
 * The sibling is not padding. An attempt with `inputVariant: "original"` is recorded against the
 * group's uploaded row - ADR-20 - so the dimensions and byte size of the pixels it actually read
 * live only on the other row, and an export without it cannot answer what the on-device path was
 * reading when it beat the downscaled run.
 *
 * The whole listing is walked and narrowed here rather than asked for group by group: the store
 * holds hundreds of rows against potentially dozens of groups, so one sweep is fewer round trips
 * than one request per group, and the filtering is exact either way.
 */
async function collectImages(
  attempts: readonly Attempt[],
  onProgress?: CollectExportOptions['onProgress'],
): Promise<ImageRecord[]> {
  const wanted = new Set(attempts.map((attempt) => attempt.captureGroupId));

  if (wanted.size === 0) {
    return [];
  }

  const rows: ImageRecord[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // No `variant` filter: both variants of a group are wanted, which is the point of the sweep.
    const response = await fetchImages({ limit: IMAGE_LIST_MAX_LIMIT, cursor });
    rows.push(...response.items.filter((image) => wanted.has(image.captureGroupId)));
    onProgress?.({ stage: 'images', count: rows.length });

    if (response.nextCursor === null) {
      return rows;
    }
    cursor = response.nextCursor;
  }

  throw new Error(`The image listing did not end after ${MAX_PAGES} pages`);
}

/**
 * Every recorded decode, unfiltered.
 *
 * They are the whole set regardless of the filters above, because none of those filters applies to
 * them: a barcode scan has no image, no method, no parser and no timing protocol - ADR-1. Filtering
 * them by a method chip would produce an empty array that looked like a measurement of nothing.
 */
async function collectBarcodeScans(
  onProgress?: CollectExportOptions['onProgress'],
): Promise<BarcodeScan[]> {
  const rows: BarcodeScan[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetchBarcodeScans({ limit: BARCODE_SCAN_LIST_MAX_LIMIT, cursor });
    rows.push(...response.items);
    onProgress?.({ stage: 'barcode scans', count: rows.length });

    if (response.nextCursor === null) {
      return rows;
    }
    cursor = response.nextCursor;
  }

  throw new Error(`The barcode listing did not end after ${MAX_PAGES} pages`);
}

/** Fetches everything the export contains and assembles it into the shared shape. */
export async function collectExport(options: CollectExportOptions): Promise<BenchmarkExport> {
  const attempts = await collectAttempts(options);
  const images = await collectImages(attempts, options.onProgress);
  const barcodeScans = await collectBarcodeScans(options.onProgress);

  return buildBenchmarkExport({
    // A wall-clock instant recording when the file was written. Ordered and read, never subtracted
    // from anything - ADR-10.
    // eslint-disable-next-line no-restricted-syntax -- a recorded timestamp, not a duration
    exportedAt: new Date(Date.now()).toISOString(),
    filters: options.filters,
    images,
    attempts,
    barcodeScans,
  });
}

/** `scanner-demo-2026-08-04T09-12-33.json` - sortable, and legal on every filesystem involved. */
export function exportFileName(exportedAt: string): string {
  return `scanner-demo-${exportedAt.replace(/[:.]/g, '-').replace(/Z$/, '')}`;
}

const EXPORT_DIR = 'exports';

export interface WrittenExport {
  /** Inside the app's own storage. Reachable with `adb exec-out run-as … cat`. */
  file: File;
  /** Where the operator chose to save a copy, or `null` if they did not. */
  savedUri: string | null;
  bytes: number;
}

/**
 * Writes the export, then offers to copy it somewhere the phone's owner can actually reach.
 *
 * Two destinations, because they answer different questions. The app-private copy always happens
 * and is what makes the export reproducible from a dev build over `adb`. The Storage Access
 * Framework copy is what gets the file onto a machine that can run a script over it, and it is
 * optional: a cancelled folder picker leaves the first copy intact rather than failing the export.
 *
 * **SAF rather than a share sheet on purpose.** It is part of `expo-file-system`, which this app
 * already depends on, so the export ships as a JavaScript change - no new native module and no
 * rebuilt development client between collecting a dataset and reading it.
 */
export async function writeExport(file: BenchmarkExport): Promise<WrittenExport> {
  const name = `${exportFileName(file.exportedAt)}.json`;
  // Not pretty-printed: this is machine input, and the indentation of a few hundred full rows is
  // megabytes of spaces over a phone's storage for no reader's benefit.
  const json = JSON.stringify(file);

  const directory = new Directory(Paths.document, EXPORT_DIR);
  if (!directory.exists) {
    directory.create({ intermediates: true });
  }

  const local = new File(directory, name);
  if (local.exists) {
    local.delete();
  }
  local.create();
  local.write(json);

  let savedUri: string | null = null;

  const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();

  if (permission.granted) {
    // `createFileAsync` takes the name without its extension and derives it from the MIME type.
    const target = await StorageAccessFramework.createFileAsync(
      permission.directoryUri,
      exportFileName(file.exportedAt),
      'application/json',
    );
    await StorageAccessFramework.writeAsStringAsync(target, json);
    savedUri = target;
  }

  return { file: local, savedUri, bytes: json.length };
}
