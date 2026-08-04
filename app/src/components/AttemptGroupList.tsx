import { StyleSheet, Text, View } from 'react-native';
import { groupAttempts } from '@scanner-demo/shared';
import type { Attempt, AttemptGroup, AttemptSummaryCohort } from '@scanner-demo/shared';
import { formatMs, formatTimestamp } from '../format';
import { colors, radius, spacing } from '../theme';

/**
 * Every attempt ever run against one image, grouped - spec, § Screens — Image library.
 *
 * Two things here are requirements rather than layout choices:
 *
 * - **The grouping key is `(method, inputVariant)`.** The on-device path runs over both variants of a
 *   capture, and one figure covering both would be the average of a full-resolution read and a
 *   downscaled one - true of neither - ADR-2. The grouping itself lives in `@scanner-demo/shared`, so
 *   the Library, History and the export cannot disagree about it.
 * - **Nothing is collapsed into a "current result".** Every individual run is listed under its group,
 *   because a re-run is additive and the point of running a method twice is to see both numbers.
 *
 * The run count sits next to every median. A median of two is noisy by definition, and a figure that
 * does not say how many runs it came from invites being read as a stable one.
 */

export interface AttemptGroupListProps {
  attempts: Attempt[];
}

function Run({ attempt }: { attempt: Attempt }) {
  const expiry = attempt.parse?.expiry ?? null;

  return (
    <View style={styles.run}>
      <View style={styles.runHeader}>
        <Text style={styles.runWhen}>{formatTimestamp(attempt.createdAt)}</Text>
        <Text style={styles.runTotal}>{formatMs(attempt.timing.totalMs)}</Text>
      </View>

      {attempt.error !== null ? (
        // A failed run is a row like any other. It is shown, not hidden, or the engine that cannot
        // read a package would look like the one that was never asked - ADR-15.
        <Text style={styles.failure}>{attempt.error}</Text>
      ) : (
        <Text style={styles.runDetail}>
          {expiry === null ? (
            <Text style={styles.failure}>no date extracted</Text>
          ) : (
            <>
              {expiry.date}
              <Text style={expiry.status === 'expired' ? styles.expired : styles.valid}>
                {' '}
                {expiry.status}
              </Text>
              <Text style={styles.caption}>
                {' '}
                · {expiry.precision} · rule {attempt.parse?.rule}
              </Text>
            </>
          )}
        </Text>
      )}

      {attempt.vlm !== null && (
        // The model's own answer, per run, beside the parser's above. Five runs of one image are
        // five rows here, and the spread this exposes is a spread in *both* columns: a VLM can
        // return a different date on the same pixels, and a summary that showed only the parser's
        // reading would hide the half of the non-determinism that comes from the model - phase 09
        // criterion 6.
        <Text style={styles.caption}>
          model said {attempt.vlm.parsedDate ?? 'no date'} · prompt {attempt.promptVersion ?? 'n/a'}
        </Text>
      )}

      <Text style={styles.caption}>
        engine {formatMs(attempt.timing.engineMs)} · parse {formatMs(attempt.timing.parseMs)} ·
        download {formatMs(attempt.timing.downloadMs)}
      </Text>
      <Text style={styles.caption}>
        {attempt.parserVersion} · {attempt.timingVersion}
      </Text>
    </View>
  );
}

function Cohort({ cohort }: { cohort: AttemptSummaryCohort }) {
  return (
    <View style={styles.cohort}>
      <View style={styles.cohortHeader}>
        <Text style={styles.cohortVersion}>
          {/* The engine leads, because it is the half of the key a reader is most likely to be
              comparing: one `method` can be several models - ADR-24. `no engine` is the cohort of
              runs that failed before producing one, never a missing label. */}
          {cohort.engine ?? 'no engine'}
        </Text>
        <Text style={styles.runCount}>
          {cohort.runCount} run{cohort.runCount === 1 ? '' : 's'}
        </Text>
      </View>

      <Text style={styles.cohortVersion}>
        {cohort.parserVersion} · {cohort.timingVersion}
        {cohort.promptVersion === null ? '' : ` · ${cohort.promptVersion}`}
      </Text>

      <View style={styles.medians}>
        <Text style={styles.medianLabel}>median method total</Text>
        <Text style={styles.medianValue}>{formatMs(cohort.medianTotalMs)}</Text>
      </View>
      <View style={styles.medians}>
        <Text style={styles.medianLabel}>median engine</Text>
        <Text style={styles.medianValue}>{formatMs(cohort.medianEngineMs)}</Text>
      </View>

      <Text style={styles.caption}>
        {cohort.extractedCount} of {cohort.runCount} extracted a date
        {cohort.failureCount > 0 ? ` · ${cohort.failureCount} failed` : ''}
      </Text>
    </View>
  );
}

function Group({ group }: { group: AttemptGroup }) {
  return (
    <View style={styles.group}>
      <View style={styles.groupHeader}>
        <Text style={styles.method}>
          {group.method} · {group.inputVariant}
        </Text>
        <Text style={styles.runCount}>
          {group.attempts.length} total run{group.attempts.length === 1 ? '' : 's'}
        </Text>
      </View>

      {group.cohorts.map((cohort) => (
        <Cohort
          key={`${cohort.parserVersion}-${cohort.timingVersion}-${cohort.engine ?? ''}-${cohort.promptVersion ?? ''}`}
          cohort={cohort}
        />
      ))}

      {group.attempts.map((attempt) => (
        <Run key={attempt.id} attempt={attempt} />
      ))}
    </View>
  );
}

export function AttemptGroupList({ attempts }: AttemptGroupListProps) {
  const groups = groupAttempts(attempts);

  if (groups.length === 0) {
    return (
      <Text style={styles.caption}>
        Nothing has been run against this capture yet. The buttons above record one attempt per run,
        and a re-run adds a row rather than replacing one.
      </Text>
    );
  }

  return (
    <View style={styles.container}>
      {groups.map((group) => (
        <Group key={`${group.method}-${group.inputVariant}`} group={group} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
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
  cohortVersion: { color: colors.text, fontFamily: 'monospace', fontSize: 12, fontWeight: '600' },
  medians: { flexDirection: 'row', justifyContent: 'space-between' },
  medianLabel: { color: colors.text, fontSize: 13 },
  medianValue: {
    color: colors.accent,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  run: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 2,
    paddingTop: spacing.xs,
  },
  runHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  runWhen: { color: colors.textMuted, fontSize: 11 },
  runTotal: { color: colors.text, fontSize: 12, fontVariant: ['tabular-nums'], fontWeight: '600' },
  runDetail: { color: colors.text, fontSize: 13 },
  valid: { color: colors.online, fontWeight: '600' },
  expired: { color: colors.offline, fontWeight: '600' },
  failure: { color: colors.offline, fontSize: 13 },
  caption: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
});
