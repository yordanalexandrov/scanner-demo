import type { Millis } from '@scanner-demo/shared';

/**
 * A duration, for reading.
 *
 * One decimal place: the phone's clock has sub-millisecond resolution and throwing it away in the
 * display would hide the difference between two decodes that really are 0.4 ms apart. Rounding
 * happens here and nowhere else - what gets stored keeps every digit the clock gave - ADR-10.
 *
 * `null` renders as "n/a", never as "0 ms". A measurement that does not exist and a measurement of
 * zero are different facts, and the second one drags every average built on top of it.
 */
export function formatMs(value: Millis | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)} ms`;
}

/**
 * A file size, for reading.
 *
 * It exists because of one specific decision the operator has to make: a full-resolution original
 * can be several megabytes, and re-running the on-device path over it means pulling those bytes down
 * a mobile connection. The size is shown next to the button rather than discovered afterwards.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(0)} kB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** A wall-clock instant, for ordering runs by eye. Never used as one end of a duration - ADR-10. */
export function formatTimestamp(unixMs: number): string {
  const at = new Date(unixMs);
  return `${at.toLocaleDateString()} ${at.toLocaleTimeString()}`;
}
