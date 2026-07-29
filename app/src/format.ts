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
