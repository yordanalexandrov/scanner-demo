import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AttemptGroup, ImageAttempts, ImageRecord } from '@scanner-demo/shared';
import { thumbnailSourceFor } from '../api/images';
import { formatMs, formatTimestamp } from '../format';
import { colors, radius, spacing } from '../theme';

/**
 * One source image with every method that has read it, side by side - phase 10 scope item 1.
 *
 * This is the row the whole project builds towards: the same photograph, processed four ways, read
 * across in one line. What makes it a fair reading rather than a pretty one:
 *
 * - **A column is a `(method, inputVariant)` pair, not a method.** The on-device path reads the
 *   full-resolution capture and the downscaled upload, and those are two columns - ADR-2.
 * - **A cell shows the date the parser reached and how it reached it.** An `expired` date is a
 *   successful extraction, labelled so a real expired product is never mistaken for a valid one -
 *   ADR-7. A run that failed shows the failure rather than a blank, or the engine that cannot read
 *   a package would look like the one that was never asked.
 * - **A cell that has been run more than once says so.** The date shown is the newest run's; the
 *   count next to it is what stops that being read as the only result.
 *
 * The image's own metadata comes from the Library listing when it is available and is simply absent
 * when it is not - the row is built from attempts, which name their image, so it renders whether or
 * not the image record has arrived.
 */

export interface ImageAttemptRowProps {
  row: ImageAttempts;
  /** The image record, when the listing has supplied it. `null` renders without capture metadata. */
  image: ImageRecord | null;
  onPress: (row: ImageAttempts) => void;
}

function Cell({ group }: { group: AttemptGroup }) {
  // The API serves attempts newest first, and `groupAttempts` preserves that order, so the first
  // run in the group is the most recent one.
  const newest = group.attempts[0];
  const expiry = newest?.parse?.expiry ?? null;

  return (
    <View style={styles.cell}>
      <Text style={styles.cellMethod} numberOfLines={1}>
        {group.method}
      </Text>
      <Text style={styles.cellVariant} numberOfLines={1}>
        {group.inputVariant}
      </Text>

      {newest?.error != null ? (
        <Text style={styles.failure} numberOfLines={2}>
          {newest.error}
        </Text>
      ) : expiry === null ? (
        <Text style={styles.failure}>no date</Text>
      ) : (
        <>
          <Text style={expiry.status === 'expired' ? styles.expired : styles.valid}>
            {expiry.date}
          </Text>
          <Text style={styles.cellNote} numberOfLines={1}>
            {expiry.status} · {expiry.precision}
          </Text>
          <Text style={styles.cellNote} numberOfLines={1}>
            {newest?.parse?.rule}
          </Text>
        </>
      )}

      <Text style={styles.cellLatency}>{formatMs(newest?.timing.totalMs ?? null)}</Text>
      <Text style={styles.cellNote}>
        {group.attempts.length} run{group.attempts.length === 1 ? '' : 's'}
      </Text>
    </View>
  );
}

export function ImageAttemptRow({ row, image, onPress }: ImageAttemptRowProps) {
  return (
    <View style={styles.container}>
      {/**
       * Only the header opens the capture, and that is a fix rather than a preference.
       *
       * With the whole card pressable, the press won the touch responder from the horizontal
       * ScrollView below and a sideways drag navigated away instead of scrolling. Verified on an
       * SM-S928B on 2026-08-04 against a row with seven `(method, inputVariant)` columns: the four
       * past the third could not be reached at all, which is acceptance criterion 1 failing while
       * looking like it passed. The cells are data to be read across, not a link.
       */}
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        onPress={() => onPress(row)}
      >
        {/* The thumbnail, never the full image: a list of full-resolution photographs would move
            tens of megabytes to draw squares 64px wide. */}
        <Image source={thumbnailSourceFor(row.imageId)} style={styles.thumbnail} />

        <View style={styles.headerText}>
          <Text style={styles.when}>{formatTimestamp(row.latestAt)}</Text>
          <Text style={styles.meta}>
            {image === null
              ? 'image metadata not loaded'
              : `${image.source} · ${image.width}×${image.height}`}
          </Text>
          <Text style={styles.meta}>
            {row.groups.length} method run{row.groups.length === 1 ? '' : 's'} ·{' '}
            {row.attempts.length} attempt{row.attempts.length === 1 ? '' : 's'}
          </Text>
          <Text style={styles.mono} numberOfLines={1}>
            {row.imageId}
          </Text>
        </View>
      </Pressable>

      {/* Horizontal, because four methods across a phone is what "side by side" means here and
          wrapping them into a grid would put two of the four below the fold. The scrollbar stays
          visible: with more columns than fit, nothing else says there are more to read. */}
      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.cells}>
        {row.groups.map((group) => (
          <Cell key={`${group.method}-${group.inputVariant}`} group={group} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    marginBottom: spacing.sm,
    padding: spacing.sm,
  },
  header: { flexDirection: 'row', gap: spacing.sm },
  thumbnail: { backgroundColor: colors.background, borderRadius: radius.md, height: 64, width: 64 },
  headerText: { flex: 1, gap: 1 },
  when: { color: colors.text, fontSize: 13, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 11 },
  mono: { color: colors.textMuted, fontFamily: 'monospace', fontSize: 10 },
  cells: { flexGrow: 0 },
  cell: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    gap: 1,
    marginRight: spacing.xs,
    minWidth: 116,
    padding: spacing.sm,
  },
  cellMethod: { color: colors.text, fontSize: 12, fontWeight: '700' },
  cellVariant: { color: colors.textMuted, fontSize: 10 },
  cellNote: { color: colors.textMuted, fontSize: 10 },
  cellLatency: {
    color: colors.text,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  valid: { color: colors.online, fontSize: 13, fontWeight: '700' },
  expired: { color: colors.offline, fontSize: 13, fontWeight: '700' },
  failure: { color: colors.offline, fontSize: 11 },
  pressed: { opacity: 0.7 },
});
