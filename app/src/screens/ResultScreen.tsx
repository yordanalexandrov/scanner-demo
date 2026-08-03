import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { RouteProp } from '@react-navigation/native';
import { useRoute } from '@react-navigation/native';
import type { Attempt } from '@scanner-demo/shared';
import { ApiError } from '../api/client';
import { fetchAttempts } from '../api/attempts';
import { LatencyBreakdown } from '../components/LatencyBreakdown';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, radius, spacing } from '../theme';

/**
 * The result view - spec, screen 5: method, the latency breakdown, the raw OCR text verbatim, the
 * parsed date or an explicit failure, confidence where reported, and the estimated cost.
 *
 * It reads back from the server rather than rendering what the capture screen happens to hold in
 * memory. That is deliberate: what this screen shows is then exactly what was recorded, so a row
 * that failed to store cannot look like a successful measurement.
 *
 * Attempts are grouped by `(method, inputVariant)` in every view that aggregates them - never by
 * method alone, or the two on-device runs average together and both numbers are wrong - ADR-2.
 */

type ResultRoute = RouteProp<RootStackParamList, 'Result'>;

/**
 * A cost of zero is a real, known zero here - the price table says on-device runs have no per-call
 * cost. `null` means the price is not yet known and must never render as free - ADR-11.
 *
 * **Two decimals are not enough**, and phase 08 is where that stopped being theoretical: one Cloud
 * Vision image is $0.0015, which `toFixed(2)` renders as `$0.00` - indistinguishable from the
 * on-device engine that really is free. A cost column whose only cloud entry reads zero is worse
 * than no cost column, so a sub-cent figure gets the precision it needs to stay a figure.
 */
function formatCost(usd: number | null): string {
  if (usd === null) {
    return 'unknown';
  }

  return `$${usd.toFixed(usd !== 0 && Math.abs(usd) < 0.01 ? 5 : 2)}`;
}

/**
 * The two answers, side by side, labelled so neither can be mistaken for the other - criterion 3.
 *
 * **They are answers to different questions and the layout has to say so.** The left column is what
 * the model concluded from the picture; the right is what the shared parser made of the text that
 * same model says it read. Every other method has only the right column. Where the two disagree the
 * disagreement is the finding - a model that returns a confident date it did not actually read is
 * exactly what this view exists to make visible, and it is only visible because both are kept.
 *
 * Rendered for the VLM path alone: `attempt.vlm` is `null` everywhere else, which is "not
 * applicable on this path" rather than "no date found", and showing an empty column for it would
 * read as the latter.
 */
function ModelAnswer({ attempt }: { attempt: Attempt }) {
  if (attempt.vlm === null) {
    return null;
  }

  const model = attempt.vlm;
  const parser = attempt.parse?.expiry?.date ?? null;
  // Compared only to label the row. Neither answer is corrected towards the other, and the stored
  // attempt keeps both regardless of what this says.
  const agree = model.parsedDate === parser;

  return (
    <View style={styles.section}>
      <Text style={styles.label}>Model answer vs parser answer</Text>

      <View style={styles.compareRow}>
        <View style={styles.compareCell}>
          <Text style={styles.compareHeading}>The model&apos;s own answer</Text>
          <Text style={styles.compareValue}>{model.parsedDate ?? 'no date'}</Text>
          <Text style={styles.caption}>prompt {attempt.promptVersion ?? 'n/a'}</Text>
        </View>

        <View style={styles.compareCell}>
          <Text style={styles.compareHeading}>Shared parser, same raw text</Text>
          <Text style={styles.compareValue}>{parser ?? 'no date'}</Text>
          <Text style={styles.caption}>parser {attempt.parserVersion}</Text>
        </View>
      </View>

      <Text style={[styles.caption, !agree && styles.disagree]}>
        {agree
          ? 'reading and interpretation agree'
          : 'they disagree — which half differs is the measurement'}
      </Text>

      <Text style={styles.caption} selectable>
        {model.modelReasoning === '' ? 'the model gave no reasoning' : model.modelReasoning}
      </Text>
    </View>
  );
}

function ParsedDate({ attempt }: { attempt: Attempt }) {
  const parse = attempt.parse;

  if (parse === null || parse.expiry === null) {
    return (
      <View style={styles.section}>
        <Text style={styles.label}>Parsed date</Text>
        {/* An explicit failure, never a guess - and the rule says which path reached it. */}
        <Text style={styles.failure}>No date extracted</Text>
        <Text style={styles.caption}>
          rule: {parse?.rule ?? 'n/a'}
          {parse !== null && parse.candidates.length > 0
            ? ` · ${parse.candidates.length} candidate(s) rejected`
            : ''}
        </Text>
        {parse?.candidates.map((candidate) => (
          <Text key={`${candidate.raw}-${candidate.date}`} style={styles.caption}>
            {candidate.raw} → {candidate.date} · {candidate.rejectedFor ?? 'accepted'}
          </Text>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.label}>Parsed date</Text>

      <View style={styles.dateRow}>
        <Text style={styles.date}>{parse.expiry.date}</Text>
        <Text style={[styles.status, parse.expiry.status === 'expired' && styles.expired]}>
          {parse.expiry.status}
        </Text>
      </View>

      <Text style={styles.caption}>
        from “{parse.expiry.raw}” · precision {parse.expiry.precision} · rule {parse.rule}
        {parse.ambiguous ? ' · ambiguous' : ''}
      </Text>

      {parse.productionDate !== null && (
        // Reported rather than thrown away: the earlier of a pair is the production date - ADR-6.
        <Text style={styles.caption}>
          production date {parse.productionDate.date} · from “{parse.productionDate.raw}”
        </Text>
      )}

      <Text style={styles.caption}>
        confidence {parse.confidence.score.toFixed(2)} ·{' '}
        {parse.confidence.signals.join(', ') || 'no signals'}
      </Text>

      <Text style={styles.caption}>reference date {parse.referenceDate}</Text>
    </View>
  );
}

function AttemptCard({ attempt, showCaptureCost }: { attempt: Attempt; showCaptureCost: boolean }) {
  const blockConfidences = attempt.ocr?.blocks.map((block) => block.confidence) ?? [];
  const reported = blockConfidences.filter((value): value is number => value !== null);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.method}>
          {attempt.method} · {attempt.inputVariant}
        </Text>
        <Text style={styles.cost}>{formatCost(attempt.ocr?.costEstimateUsd ?? null)}</Text>
      </View>

      <Text style={styles.caption}>
        {attempt.ocr?.engine ?? 'no engine'} · {attempt.device}
        {attempt.ocr !== null && ` · ${attempt.ocr.imageWidth}×${attempt.ocr.imageHeight}`}
      </Text>
      <Text style={styles.caption}>
        parser {attempt.parserVersion} · timing {attempt.timingVersion} · pricing{' '}
        {attempt.pricingVersion}
      </Text>

      {attempt.ocr?.usage != null && (
        // Shown next to the cost because the cost is computed from exactly these two numbers and
        // the price table at `pricingVersion` above. That is what makes the figure auditable rather
        // than something the harness asserts about itself - phase 09 criterion 5, ADR-11.
        <Text style={styles.caption}>
          {attempt.ocr.usage.inputTokens} in / {attempt.ocr.usage.outputTokens} out tokens
        </Text>
      )}

      {attempt.error !== null && <Text style={styles.failure}>{attempt.error}</Text>}

      <LatencyBreakdown
        timing={attempt.timing}
        engineMsScope={attempt.ocr?.engineMsScope ?? null}
        showCaptureCost={showCaptureCost}
      />

      <ParsedDate attempt={attempt} />

      <ModelAnswer attempt={attempt} />

      <View style={styles.section}>
        <Text style={styles.label}>Confidence reported by the engine</Text>
        <Text style={styles.caption}>
          {reported.length === 0
            ? // Not "1.0", and not a blank. The on-device wrapper reports none at all - ADR-5.
              'not reported'
            : `${reported.length} of ${blockConfidences.length} blocks · ${Math.min(...reported).toFixed(2)}–${Math.max(...reported).toFixed(2)}`}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Raw text · {attempt.ocr?.blocks.length ?? 0} blocks</Text>
        <ScrollView style={styles.rawTextBox} nestedScrollEnabled>
          {/* Verbatim, line breaks included - criterion 12. Nothing here trims or re-wraps it. */}
          <Text style={styles.rawText} selectable>
            {attempt.ocr?.rawText === undefined || attempt.ocr.rawText === ''
              ? '(the engine returned no text)'
              : attempt.ocr.rawText}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

export function ResultScreen() {
  const route = useRoute<ResultRoute>();
  const { imageId } = route.params;

  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetchAttempts(imageId);
      setAttempts(response.items);
    } catch (failure: unknown) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : 'The attempts could not be loaded',
      );
    }
  }, [imageId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Capture segments are repeated on fresh upload rows for traceability, but they describe one
  // physical capture. Showing them once prevents the result view from charging the shared cost to
  // every method or re-run - ADR-22.
  const captureCostAttemptId =
    attempts?.find(
      ({ timing }) =>
        timing.captureMs !== null || timing.downscaleMs !== null || timing.uploadMs !== null,
    )?.id ?? null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.label}>Image</Text>
        <Text style={styles.mono} selectable>
          {imageId}
        </Text>
        <Text style={styles.caption}>
          {attempts === null ? 'loading…' : `${attempts.length} attempt(s) recorded`}
        </Text>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}
          onPress={() => void load()}
        >
          <Text style={styles.refreshLabel}>Reload</Text>
        </Pressable>
      </View>

      {error !== null && <Text style={styles.failure}>{error}</Text>}

      {attempts === null && error === null && <ActivityIndicator color={colors.accent} />}

      {attempts?.length === 0 && (
        <Text style={styles.caption}>
          Nothing recorded against this image yet. A run that failed to post is a lost measurement
          and is reported on the capture screen rather than here.
        </Text>
      )}

      {attempts?.map((attempt) => (
        <AttemptCard
          key={attempt.id}
          attempt={attempt}
          showCaptureCost={attempt.id === captureCostAttemptId}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  content: { gap: spacing.md, padding: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  headerRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  method: { color: colors.text, fontSize: 16, fontWeight: '700' },
  cost: { color: colors.text, fontSize: 14, fontVariant: ['tabular-nums'], fontWeight: '600' },
  section: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingTop: spacing.sm,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  dateRow: { alignItems: 'baseline', flexDirection: 'row', gap: spacing.sm },
  compareRow: { flexDirection: 'row', gap: spacing.md },
  // Equal halves rather than one column wrapping under the other: whichever answer is longer must
  // not become the one that looks like the result.
  compareCell: { flex: 1, gap: spacing.xs },
  compareHeading: { color: colors.textMuted, fontSize: 11, lineHeight: 15 },
  compareValue: { color: colors.text, fontSize: 17, fontWeight: '700' },
  disagree: { color: colors.accent },
  date: { color: colors.text, fontSize: 22, fontWeight: '700' },
  status: { color: colors.online, fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  expired: { color: colors.offline },
  failure: { color: colors.offline, fontSize: 14, lineHeight: 19 },
  caption: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  mono: { color: colors.text, fontFamily: 'monospace', fontSize: 13 },
  rawTextBox: {
    backgroundColor: colors.background,
    borderRadius: radius.md,
    maxHeight: 220,
    padding: spacing.sm,
  },
  rawText: { color: colors.text, fontFamily: 'monospace', fontSize: 12, lineHeight: 18 },
  refresh: {
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  refreshLabel: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
