import {
  BARCODE_SCAN_LIST_DEFAULT_LIMIT,
  barcodeScanCreateResponseSchema,
  barcodeScanListResponseSchema,
} from '@scanner-demo/shared';
import type {
  BarcodeScanCreate,
  BarcodeScanCreateResponse,
  BarcodeScanListResponse,
} from '@scanner-demo/shared';
import { apiGet, apiPost, type RequestOptions } from './client';

/**
 * The two calls behind goal 1 of the project - ADR-1.
 *
 * A decode that is only ever shown on screen is lost the moment the screen unmounts, so every scan
 * is posted as it happens. The measurement itself is made on the phone and merely carried here; the
 * server times nothing on this path - ADR-10.
 */

/**
 * Deliberately short. A scan is recorded while the user is already lining up the next package, so a
 * request that has not answered in three seconds has missed its moment - the row is marked unsaved
 * on screen and can be retried, which is better than a screen that waits.
 */
const CREATE_TIMEOUT_MS = 3_000;

export function createBarcodeScan(
  scan: BarcodeScanCreate,
  options: RequestOptions = {},
): Promise<BarcodeScanCreateResponse> {
  return apiPost('/api/v1/barcode-scans', scan, barcodeScanCreateResponseSchema, {
    timeoutMs: CREATE_TIMEOUT_MS,
    ...options,
  });
}

export interface BarcodeScanListParams {
  limit?: number;
  cursor?: string;
}

export function fetchBarcodeScans(
  params: BarcodeScanListParams = {},
  options: RequestOptions = {},
): Promise<BarcodeScanListResponse> {
  const query = new URLSearchParams({
    limit: String(params.limit ?? BARCODE_SCAN_LIST_DEFAULT_LIMIT),
  });

  if (params.cursor !== undefined) {
    query.set('cursor', params.cursor);
  }

  return apiGet(
    `/api/v1/barcode-scans?${query.toString()}`,
    barcodeScanListResponseSchema,
    options,
  );
}
