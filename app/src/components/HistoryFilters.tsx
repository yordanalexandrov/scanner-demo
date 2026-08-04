import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  LEGACY_PARSER_VERSION,
  LEGACY_TIMING_VERSION,
  PARSER_VERSION,
  TIMING_VERSION,
} from '@scanner-demo/shared';
import type { ExportFilters, Method } from '@scanner-demo/shared';
import type { AttemptFilters } from '../api/attempts';
import { METHODS } from './MethodButtons';
import { colors, radius, spacing } from '../theme';

/**
 * History's filters - spec, § Screens — History, and phase 10 scope items 2 to 4.
 *
 * Every one of them is a server query. Narrowing a fetched page on the phone would make the medians
 * below them depend on how far the operator had scrolled, and those medians are the deliverable of
 * the whole harness.
 *
 * **Three of these five exist to stop two populations being averaged into one number**, and each
 * one prevents a different mistake:
 *
 * - `source` separates controlled captures from gallery imports. An import has no capture
 *   conditions that were ours to set, so its runs are valid for comparing OCR accuracy and
 *   meaningless for comparing capture latency - which is why the summary refuses to show a capture
 *   figure until this is set to one or the other.
 * - `inputVariant` separates the on-device path's full-resolution read from its downscaled one -
 *   ADR-2. It is deliberately **not** called `variant`: the Library's chip of that name filters
 *   which image rows are listed, this one filters which runs are counted, and one used where the
 *   other was meant would quietly corrupt the headline numbers.
 * - `parserVersion` and `timingVersion` separate incompatible extraction and latency semantics -
 *   ADR-21, ADR-22. Left unset they are not ignored: the summary splits into labelled cohorts
 *   instead of combining them, which is the honest answer to "show me everything".
 */

export type MethodState = 'all' | Method;
export type SourceState = 'all' | 'camera' | 'gallery';
export type InputVariantState = 'all' | 'upload' | 'original';
export type ParserState =
  'all' | typeof LEGACY_PARSER_VERSION | 'parser-v2' | typeof PARSER_VERSION;
export type TimingState = 'all' | typeof LEGACY_TIMING_VERSION | typeof TIMING_VERSION;

export interface HistoryFilterState {
  method: MethodState;
  source: SourceState;
  inputVariant: InputVariantState;
  parserVersion: ParserState;
  timingVersion: TimingState;
}

/**
 * Everything, and stated as such.
 *
 * Unlike the Library, which defaults to the uploaded variant so a capture is not listed twice, this
 * screen defaults to no filter at all: History's job is to show what has been measured, and a
 * default that hid part of it would be a lie about the completeness of the numbers below.
 */
export const DEFAULT_HISTORY_FILTERS: HistoryFilterState = {
  method: 'all',
  source: 'all',
  inputVariant: 'all',
  parserVersion: 'all',
  timingVersion: 'all',
};

/** Translates the chips into the query the server understands. `all` means the key is absent. */
export function toAttemptFilters(state: HistoryFilterState): AttemptFilters {
  const filters: AttemptFilters = {};

  if (state.method !== 'all') {
    filters.method = state.method;
  }
  if (state.source !== 'all') {
    filters.source = state.source;
  }
  if (state.inputVariant !== 'all') {
    filters.inputVariant = state.inputVariant;
  }
  if (state.parserVersion !== 'all') {
    filters.parserVersion = state.parserVersion;
  }
  if (state.timingVersion !== 'all') {
    filters.timingVersion = state.timingVersion;
  }

  return filters;
}

/**
 * The same state as the export records it - `null` for everything left unset.
 *
 * It exists because a file of attempts does not imply the filters that produced it: a set narrowed
 * to camera runs and one that happens to contain only camera runs are indistinguishable afterwards,
 * and only the first supports a capture-latency figure.
 */
export function toExportFilters(state: HistoryFilterState): ExportFilters {
  return {
    method: state.method === 'all' ? null : state.method,
    source: state.source === 'all' ? null : state.source,
    inputVariant: state.inputVariant === 'all' ? null : state.inputVariant,
    parserVersion: state.parserVersion === 'all' ? null : state.parserVersion,
    timingVersion: state.timingVersion === 'all' ? null : state.timingVersion,
  };
}

interface ChipRowProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  note?: string;
}

function ChipRow<T extends string>({ label, value, options, onChange, note }: ChipRowProps<T>) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {note !== undefined && <Text style={styles.rowNote}>{note}</Text>}
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

export interface HistoryFiltersProps {
  state: HistoryFilterState;
  onChange: (state: HistoryFilterState) => void;
  /** Rendered beside the heading - how much the current filters returned. */
  summary: string;
}

export function HistoryFilters({ state, onChange, summary }: HistoryFiltersProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Filters</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>

      {/* Derived from the one list of methods rather than restated, so a fifth method cannot be
          runnable in the Library and un-filterable here. `onnx-paddleocr-cyrillic` is in the
          schema and not in that list - it is deferred, not built, ADR-12 - so nothing can be
          filtered to it and nothing has been recorded under it. */}
      <ChipRow
        label="Method"
        value={state.method}
        options={[
          { value: 'all' as MethodState, label: 'All' },
          ...METHODS.map((descriptor) => ({
            value: descriptor.method as MethodState,
            label: descriptor.label,
          })),
        ]}
        onChange={(method) => onChange({ ...state, method })}
      />

      <ChipRow
        label="Source"
        note="A gallery import has no capture latency. Set this before reading a capture figure."
        value={state.source}
        options={[
          { value: 'all', label: 'Both' },
          { value: 'camera', label: 'Camera' },
          { value: 'gallery', label: 'Gallery' },
        ]}
        onChange={(source) => onChange({ ...state, source })}
      />

      <ChipRow
        label="Input variant"
        note="Which pixels the run read - not the Library's image variant."
        value={state.inputVariant}
        options={[
          { value: 'all', label: 'Both' },
          { value: 'upload', label: 'Uploaded' },
          { value: 'original', label: 'Original' },
        ]}
        onChange={(inputVariant) => onChange({ ...state, inputVariant })}
      />

      <ChipRow
        label="Parser"
        value={state.parserVersion}
        options={[
          { value: 'all', label: 'All' },
          { value: LEGACY_PARSER_VERSION, label: LEGACY_PARSER_VERSION },
          { value: 'parser-v2', label: 'parser-v2' },
          { value: PARSER_VERSION, label: PARSER_VERSION },
        ]}
        onChange={(parserVersion) => onChange({ ...state, parserVersion })}
      />

      <ChipRow
        label="Timing"
        value={state.timingVersion}
        options={[
          { value: 'all', label: 'All' },
          { value: LEGACY_TIMING_VERSION, label: LEGACY_TIMING_VERSION },
          { value: TIMING_VERSION, label: TIMING_VERSION },
        ]}
        onChange={(timingVersion) => onChange({ ...state, timingVersion })}
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
  rowNote: { color: colors.textMuted, fontSize: 10, lineHeight: 14 },
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
