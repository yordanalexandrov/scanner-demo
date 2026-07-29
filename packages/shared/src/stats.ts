/**
 * Summary statistics over a set of measurements.
 *
 * The median lives here rather than in the screen that first needed it, because every later view of
 * the same numbers - the barcode session list, History, the JSON export - has to agree with it. Two
 * implementations of "the middle value" would differ on even-length sets and on how they treat an
 * empty one, and a benchmark whose headline figure depends on which screen computed it is not one.
 */

import type { Millis } from './timing.js';

/**
 * The median of `values`, or `null` when there is nothing to take a median of.
 *
 * The median rather than the mean, because a single mis-read or a thermally throttled decode is a
 * long tail on one side only, and the mean would report that tail as the typical case.
 *
 * The input is not modified - a caller passing the array it renders would otherwise see its rows
 * silently reorder.
 */
export function median(values: readonly Millis[]): Millis | null {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const upper = sorted[middle];

  // Doubles as the empty-input case: `null` rather than `0`, because no measurements taken and a
  // measurement of zero are different facts - global constraint.
  if (upper === undefined) {
    return null;
  }

  if (sorted.length % 2 === 1) {
    return upper;
  }

  // Even-length sets have no single middle element; the two straddling it are averaged. The
  // fallback is unreachable - an even length here is at least 2 - and exists only because
  // `noUncheckedIndexedAccess` cannot know that.
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}
