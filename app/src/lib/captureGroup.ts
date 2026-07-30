import type { ImageRecord } from '@scanner-demo/shared';

/**
 * The variants of one physical capture, and which of them attempts are recorded against.
 *
 * A capture group holds up to two rows - the downscaled `upload` and the archived full-resolution
 * `original` - ADR-3. Only the first is guaranteed to exist: the archive runs in the background,
 * after the measured path, and not at all when `ARCHIVE_ORIGINAL` is off.
 *
 * Every attempt for the group hangs off the **uploaded** row, whichever variant's pixels were read,
 * with `inputVariant` naming the pixels - ADR-2, ADR-20. That is the convention phase 05 wrote into
 * the data, and the Library has to keep it: recording a re-run against whichever row it happened to
 * read would scatter one `(method, inputVariant)` group across two rows, and the median of each half
 * would be reported as though it were the median of the whole.
 */

/** Uploaded first, because that is the variant every server engine will be compared on. */
const VARIANT_ORDER: readonly ImageRecord['variant'][] = ['upload', 'original'];

export function sortVariants(group: readonly ImageRecord[]): ImageRecord[] {
  return [...group].sort(
    (left, right) => VARIANT_ORDER.indexOf(left.variant) - VARIANT_ORDER.indexOf(right.variant),
  );
}

/**
 * The row every attempt in the group is recorded against.
 *
 * The uploaded variant when the group has one. The fallback is not defensive padding: a group whose
 * upload row is missing should be impossible, but returning `null` would leave the caller with no
 * row to record against and a re-run that silently cannot be stored - so the row that is there wins.
 */
export function anchorImage(group: readonly ImageRecord[]): ImageRecord | null {
  return group.find((image) => image.variant === 'upload') ?? group[0] ?? null;
}
