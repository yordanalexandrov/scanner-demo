import { StyleSheet, Text, View } from 'react-native';
import { captureCostMs, groupAttempts, median } from '@scanner-demo/shared';
import type { Attempt, AttemptGroup, AttemptSummaryCohort, Millis } from '@scanner-demo/shared';
import { formatMs } from '../format';
import { colors, radius, spacing } from '../theme';

/**
 * The comparison the whole harness exists to make - phase 10 scope item 5.
 *
 * Four rules here are requirements, not presentation:
 *
 * - **Medians, never means, and always beside the run count.** A thermally throttled decode or a
 *   single retry is a long tail on one side only, and a mean reports that tail as the typical case.
 *   A median of two is noisy by definition, so the count travels with it rather than being left for
 *   the reader to infer - ADR-10.
 * - **`(method, inputVariant)` is the row key.** The on-device path's downscaled and
 *   full-resolution runs are two rows and never one - ADR-2, phase 10 criterion 4.
 * - **A latency median never spans a `timingVersion`, an engine or a prompt.** With the version
 *   filters unset the rows split into labelled cohorts rather than combining semantics that are not
 *   comparable - ADR-21, ADR-22, ADR-24, phase 10 criterion 2.
 * - **The capture figure is withheld until `source` is filtered.** A camera capture and a gallery
 *   import have no comparable capture cost - one was shot under conditions we set and the other was
 *   picked out of a photo roll - so this says why the figure is missing rather than averaging the
 *   two - phase 10 criterion 3.
 *
 * There is deliberately **no leaderboard and no winner**. The caveats these figures carry -
 * network-inclusive `engineMs` on three of the four engines, unequal Cyrillic support, a
 * non-deterministic VLM - are not comparable enough for a single ranking to be honest.
 */

export interface MethodSummaryProps {
  /** The filtered set, exactly as the server returned it. */
  attempts: Attempt[];
  /** Whether the operator has narrowed to one photograph origin - criterion 3. */
  sourceFiltered: boolean;
}

/** A cost, or an honest absence of one. `null` never renders as `$0.00` - ADR-11. */
function formatUsd(value: number | null): string {
  return value === null ? 'unpriced' : `$${value.toFixed(4)}`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(0)}%`;
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.figure}>
      <Text style={styles.figureLabel}>
        {label}
        {note !== undefined && <Text style={styles.note}> · {note}</Text>}
      </Text>
      <Text style={styles.figureValue}>{value}</Text>
    </View>
  );
}

function Cohort({ cohort }: { cohort: AttemptSummaryCohort }) {
  return (
    <View style={styles.cohort}>
      <View style={styles.cohortHeader}>
        {/* The engine leads: one `method` can be several models, and a median across two of them
            is true of neither - ADR-24. `no engine` is the cohort of runs that failed before
            producing one, never a missing label. */}
        <Text style={styles.cohortEngine}>{cohort.engine ?? 'no engine'}</Text>
        <Text style={styles.runCount}>
          {cohort.runCount} run{cohort.runCount === 1 ? '' : 's'}
        </Text>
      </View>

      <Text style={styles.cohortVersion}>
        {cohort.parserVersion} · {cohort.timingVersion}
        {cohort.promptVersion === null ? '' : ` · ${cohort.promptVersion}`}
      </Text>

      <Figure label="Median method total" value={formatMs(cohort.medianTotalMs)} />
      <Figure
        label="Median engine"
        value={formatMs(cohort.medianEngineMs)}
        note="scopes differ across engines"
      />
      <Figure
        label="Extraction rate"
        value={`${percent(cohort.extractedCount, cohort.runCount)} · ${cohort.extractedCount}/${cohort.runCount}`}
        // An engine that read the date correctly on an item that has already expired succeeded.
        // Scoring that as a failure would penalise whichever engine reads best - ADR-7.
        note="expired counts as extracted"
      />

      {cohort.runCount < 5 && (
        // Said on the figure rather than only in the README: below about five runs the median is
        // the middle of a handful of numbers, not a distribution, and it is quoted as one anyway
        // unless something on screen says otherwise - ADR-18.
        <Text style={styles.caveat}>
          Under five runs. This is the middle of a handful of numbers, not a distribution.
        </Text>
      )}

      {cohort.failureCount > 0 && (
        <Text style={styles.caveat}>
          {cohort.failureCount} of these failed, and are counted rather than dropped - ADR-15.
        </Text>
      )}
    </View>
  );
}

function Group({ group, sourceFiltered }: { group: AttemptGroup; sourceFiltered: boolean }) {
  /**
   * The capture cost of the photographs behind these runs, deduplicated by image.
   *
   * A capture is paid once and read by every method - ADR-22 - so charging it to each of them, or
   * taking a median over one figure repeated four times, would report the same number as though it
   * were four measurements.
   */
  const captureCosts = new Map<string, Millis>();

  for (const attempt of group.attempts) {
    const cost = captureCostMs(attempt.timing);
    if (cost !== null && !captureCosts.has(attempt.imageId)) {
      captureCosts.set(attempt.imageId, cost);
    }
  }

  const medianCaptureMs = median([...captureCosts.values()]);

  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <Text style={styles.method}>
          {group.method} · {group.inputVariant}
        </Text>
        <Text style={styles.runCount}>
          {group.attempts.length} run{group.attempts.length === 1 ? '' : 's'}
        </Text>
      </View>

      {group.cohorts.length > 1 && (
        <Text style={styles.caveat}>
          {group.cohorts.length} cohorts below. They are reported apart because a median may not
          span two parser or timing protocols, two engines, or two prompts - ADR-21, ADR-22, ADR-24.
        </Text>
      )}

      {group.cohorts.map((cohort) => (
        <Cohort
          key={`${cohort.parserVersion}-${cohort.timingVersion}-${cohort.engine ?? ''}-${cohort.promptVersion ?? ''}`}
          cohort={cohort}
        />
      ))}

      <Figure
        label="Estimated cost, all runs"
        value={formatUsd(group.costUsd)}
        // Unlike a median, a cost may be totalled across cohorts: it is an amount incurred per call
        // and priced by the table version stored on that call - ADR-11.
        note={
          group.unpricedCount === 0
            ? 'every run priced'
            : `${group.unpricedCount} run(s) unpriced, not counted as free`
        }
      />

      {sourceFiltered ? (
        <Figure
          label="Median capture cost"
          value={formatMs(medianCaptureMs)}
          note={`outside every method total · ${captureCosts.size} capture(s)`}
        />
      ) : (
        <Text style={styles.caveat}>
          No capture figure: filter Source to Camera or Gallery first. A gallery import has no
          capture conditions that were ours to set, and averaging the two would produce a number
          that describes neither.
        </Text>
      )}
    </View>
  );
}

export function MethodSummary({ attempts, sourceFiltered }: MethodSummaryProps) {
  const groups = groupAttempts(attempts);

  if (groups.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.label}>Per-method summary</Text>
        <Text style={styles.caveat}>Nothing matches these filters.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Per-method summary</Text>
        <Text style={styles.summary}>{attempts.length} run(s) in scope</Text>
      </View>

      <Text style={styles.caveat}>
        No ranking is offered on purpose. Three of the four engines report `engineMs` including the
        network, Cyrillic support is unequal, and the VLM is non-deterministic - the figures are
        comparable enough to read side by side and not enough to order.
      </Text>

      {groups.map((group) => (
        <Group
          key={`${group.method}-${group.inputVariant}`}
          group={group}
          sourceFiltered={sourceFiltered}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  header: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  summary: { color: colors.textMuted, fontSize: 12, fontVariant: ['tabular-nums'] },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  groupHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  method: { color: colors.text, fontSize: 15, fontWeight: '700' },
  runCount: { color: colors.textMuted, fontSize: 12 },
  cohort: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    gap: 2,
    padding: spacing.sm,
  },
  cohortHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  cohortEngine: {
    color: colors.text,
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    fontWeight: '600',
  },
  cohortVersion: { color: colors.textMuted, fontFamily: 'monospace', fontSize: 11 },
  figure: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'space-between' },
  figureLabel: { color: colors.text, flex: 1, fontSize: 13 },
  figureValue: {
    color: colors.accent,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  note: { color: colors.textMuted, fontSize: 11 },
  caveat: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
});
