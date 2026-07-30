import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ImageFilters } from '../api/images';
import { colors, radius, spacing } from '../theme';

/**
 * The Library's filters - spec, § Screens — Image library.
 *
 * They are a UI over the server's query parameters and nothing more: every one of them narrows the
 * set in SQL. Filtering a fetched page here instead would make the grid's contents depend on how far
 * the operator had scrolled, which is the kind of number nobody can trust.
 *
 * The date filter offers periods rather than a calendar. A date picker is a native dependency, and
 * what this screen is actually for is "the ones I shot today" while collecting a dataset; the server
 * takes an arbitrary `from`/`to` range either way, so a picker can be added later without touching
 * the API.
 */

export type RunState = 'all' | 'run' | 'not-run';
export type DateState = 'all' | 'extracted' | 'none';
export type Period = 'all' | 'day' | 'week' | 'month';

export interface LibraryFilterState {
  source: 'all' | 'camera' | 'gallery';
  variant: 'all' | 'upload' | 'original';
  runState: RunState;
  dateState: DateState;
  period: Period;
}

/**
 * The uploaded variant only, by default.
 *
 * With `ARCHIVE_ORIGINAL` on, every capture is two rows - ADR-3 - and a grid showing both would
 * present each photograph twice. The chip stays visible and selected rather than the filter being
 * applied silently: a hidden default would be a lie about what is on screen.
 */
export const DEFAULT_FILTERS: LibraryFilterState = {
  source: 'all',
  variant: 'upload',
  runState: 'all',
  dateState: 'all',
  period: 'all',
};

const PERIOD_MS: Readonly<Record<Exclude<Period, 'all'>, number>> = {
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000,
};

/** Translates the chips into the query the server understands. */
export function toImageFilters(state: LibraryFilterState): ImageFilters {
  const filters: ImageFilters = {};

  if (state.source !== 'all') {
    filters.source = state.source;
  }
  if (state.variant !== 'all') {
    filters.variant = state.variant;
  }
  if (state.runState !== 'all') {
    filters.hasAttempts = state.runState === 'run';
  }
  if (state.dateState !== 'all') {
    filters.hasDate = state.dateState === 'extracted';
  }
  if (state.period !== 'all') {
    // A wall-clock instant used as the lower bound of a filter, not as one end of a duration. The
    // window is "the last N days from now", which is only meaningful against the wall clock - ADR-10.
    // eslint-disable-next-line no-restricted-syntax -- filter bound, not a duration
    filters.from = Date.now() - PERIOD_MS[state.period];
  }

  return filters;
}

interface ChipRowProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

function ChipRow<T extends string>({ label, value, options, onChange }: ChipRowProps<T>) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.chips}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={({ pressed }) => [
                styles.chip,
                selected && styles.chipSelected,
                pressed && styles.pressed,
              ]}
              onPress={() => onChange(option.value)}
            >
              <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export interface LibraryFiltersProps {
  state: LibraryFilterState;
  onChange: (state: LibraryFilterState) => void;
  /** Rendered beside the heading - the number of rows the current filters returned. */
  summary: string;
}

export function LibraryFilters({ state, onChange, summary }: LibraryFiltersProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Filters</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>

      <ChipRow
        label="Source"
        value={state.source}
        options={[
          { value: 'all', label: 'All' },
          { value: 'camera', label: 'Camera' },
          { value: 'gallery', label: 'Gallery' },
        ]}
        onChange={(source) => onChange({ ...state, source })}
      />

      <ChipRow
        label="Variant"
        value={state.variant}
        options={[
          { value: 'upload', label: 'Uploaded' },
          { value: 'original', label: 'Original' },
          { value: 'all', label: 'Both' },
        ]}
        onChange={(variant) => onChange({ ...state, variant })}
      />

      <ChipRow
        label="Runs"
        value={state.runState}
        options={[
          { value: 'all', label: 'Any' },
          { value: 'run', label: 'Benchmarked' },
          { value: 'not-run', label: 'Not yet' },
        ]}
        onChange={(runState) => onChange({ ...state, runState })}
      />

      <ChipRow
        label="Date"
        value={state.dateState}
        options={[
          { value: 'all', label: 'Any' },
          { value: 'extracted', label: 'Extracted' },
          { value: 'none', label: 'None' },
        ]}
        onChange={(dateState) => onChange({ ...state, dateState })}
      />

      <ChipRow
        label="Captured"
        value={state.period}
        options={[
          { value: 'all', label: 'Any time' },
          { value: 'day', label: '24 h' },
          { value: 'week', label: '7 d' },
          { value: 'month', label: '30 d' },
        ]}
        onChange={(period) => onChange({ ...state, period })}
      />
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
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  header: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  summary: { color: colors.textMuted, fontSize: 12, fontVariant: ['tabular-nums'] },
  row: { gap: spacing.xs },
  rowLabel: { color: colors.textMuted, fontSize: 11 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipLabel: { color: colors.text, fontSize: 13 },
  chipLabelSelected: { color: '#ffffff', fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
