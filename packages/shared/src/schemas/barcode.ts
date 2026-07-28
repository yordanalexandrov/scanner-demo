import { z } from 'zod';

/**
 * One EAN-13 decode. Persisted server-side like every other measurement, so the barcode numbers
 * survive an app reinstall and land in the same export as everything else - ADR-1.
 *
 * `decodeMs` is measured from screen-ready to the scanner callback, on the phone's clock.
 */
export const barcodeScanSchema = z.object({
  id: z.string(),
  value: z.string().length(13),
  decodeMs: z.number(),
  /** Handset model plus Android version - decode latency depends on it. */
  device: z.string(),
  /** Unix ms wall clock. Ordered, never subtracted - ADR-10. */
  scannedAt: z.number().int(),
});

export type BarcodeScan = z.infer<typeof barcodeScanSchema>;
