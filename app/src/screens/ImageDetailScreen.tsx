import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Attempt, ImageRecord, Method } from '@scanner-demo/shared';
import { ApiError } from '../api/client';
import { fetchAttempts } from '../api/attempts';
import { fetchImages, imageSourceFor } from '../api/images';
import { AttemptGroupList } from '../components/AttemptGroupList';
import { METHODS, MethodButtons } from '../components/MethodButtons';
import { RerunAllButton } from '../components/RerunAllButton';
import { formatBytes, formatTimestamp } from '../format';
import { anchorImage, sortVariants } from '../lib/captureGroup';
import { rerunMethods, rerunMlKit } from '../lib/rerun';
import type { RunMethodResult } from '../lib/runMethod';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, radius, spacing } from '../theme';

/**
 * One stored capture: the full image, its capture metadata, every attempt ever run against it, and
 * the same four method buttons - spec, § Screens — Image library.
 *
 * The screen is per **capture group**, not per row. A capture is up to two rows - the downscaled
 * upload and the archived original - ADR-3, and every attempt for the group is recorded against the
 * uploaded one whichever variant's pixels were read - ADR-20. So the variant being read is a choice
 * made here, while the attempts shown and written are always the group's. Recording against whichever
 * row was tapped would split one `(method, inputVariant)` group across two screens and report the
 * median of each half as though it were the whole.
 *
 * **Re-running is additive.** Nothing on this screen overwrites an attempt; a second run of the same
 * method appears as a second row under the same group.
 */

type DetailRoute = RouteProp<RootStackParamList, 'ImageDetail'>;

/** The methods that exist today, and the ones whose phase has not landed yet. */
const AVAILABLE_METHODS: readonly Method[] = METHODS.filter(
  (descriptor) => descriptor.unavailable === null,
).map((descriptor) => descriptor.method);
const PENDING_METHODS: readonly Method[] = METHODS.filter(
  (descriptor) => descriptor.unavailable !== null,
).map((descriptor) => descriptor.method);

/** `null` is "not applicable on this path" and renders as such - never as `0` or `false`. */
function orNotApplicable(value: string | number | boolean | null, suffix = ''): string {
  if (value === null) {
    return 'n/a';
  }
  return `${typeof value === 'boolean' ? (value ? 'yes' : 'no') : value}${suffix}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function describe(method: Method, result: RunMethodResult): string {
  return `${method} · ${result.attempt.inputVariant}: ${result.attempt.error ?? 'read'} · ${
    result.recordError ?? 'recorded'
  }`;
}

export function ImageDetailScreen() {
  const route = useRoute<DetailRoute>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  /** The row that was tapped. The group is loaded from the server; this is what to show meanwhile. */
  const tapped = route.params.image;

  /** `null` until the server has answered. Not `[tapped]` - see {@link anchor}. */
  const [group, setGroup] = useState<ImageRecord[] | null>(null);
  const [targetId, setTargetId] = useState(tapped.id);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [running, setRunning] = useState<Method | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const variants = useMemo(() => group ?? [tapped], [group, tapped]);

  const target = useMemo(
    () => variants.find((image) => image.id === targetId) ?? tapped,
    [tapped, targetId, variants],
  );

  /**
   * The row every attempt here is written against, or `null` while that is still unknown.
   *
   * A tapped `upload` row **is** the anchor: a group has at most one, so no fetch can change the
   * answer and the common path never waits. A tapped `original` is different - its anchor is the
   * sibling row, which is only known once the group has loaded. Guessing the original in the meantime
   * would let a fast press, or a failed group fetch, record the attempt against the wrong row and
   * split one `(method, inputVariant)` group across two of them, which is precisely what ADR-20
   * exists to prevent. So it stays `null` and the buttons stay disabled until the server answers.
   */
  const anchor = useMemo<ImageRecord | null>(() => {
    if (tapped.variant === 'upload') {
      return tapped;
    }
    return group === null ? null : anchorImage(group);
  }, [group, tapped]);

  const loadGroup = useCallback(async () => {
    try {
      // Both variants, so either can be chosen as the input. One of them may legitimately be
      // missing: the archive is best-effort and off entirely when ARCHIVE_ORIGINAL is - ADR-3.
      const response = await fetchImages({ captureGroupId: tapped.captureGroupId, limit: 10 });
      // An empty answer would mean the row this screen was opened with no longer exists. Keeping the
      // tapped row is the honest fallback for display; `anchor` above still refuses to guess.
      setGroup(response.items.length > 0 ? sortVariants(response.items) : [tapped]);
    } catch (failure: unknown) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : 'The capture group could not be loaded',
      );
    }
  }, [tapped]);

  const loadAttempts = useCallback(async () => {
    if (anchor === null) {
      return;
    }

    try {
      // Read back from the server rather than from what a run returned, so what is on screen is
      // exactly what was recorded - a row that failed to store cannot look like a measurement.
      const response = await fetchAttempts(anchor.id);
      setAttempts(response.items);
    } catch (failure: unknown) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : 'The attempts could not be loaded',
      );
    }
  }, [anchor]);

  useEffect(() => {
    void loadGroup();
  }, [loadGroup]);

  useEffect(() => {
    void loadAttempts();
  }, [loadAttempts]);

  const runOne = useCallback(
    async (method: Method) => {
      // Unreachable from the UI - the buttons are disabled without an anchor - and a guard rather
      // than a cast, because recording against the wrong row is worse than not recording at all.
      if (anchor === null) {
        return;
      }

      setRunning(method);
      setOutcomes([]);
      setError(null);

      try {
        if (method !== 'mlkit') {
          throw new Error(`${method} arrives with its own phase`);
        }
        setOutcomes([describe(method, await rerunMlKit({ anchor, target }))]);
      } catch (failure: unknown) {
        setOutcomes([`${method}: ${failure instanceof Error ? failure.message : 'failed'}`]);
      } finally {
        setRunning(null);
      }

      await loadAttempts();
    },
    [anchor, loadAttempts, target],
  );

  const runAll = useCallback(async () => {
    if (anchor === null) {
      return;
    }

    setBatchRunning(true);
    setOutcomes([]);
    setError(null);

    // Each result is reported as it lands, so a method that fails halfway is visible immediately
    // rather than at the end - and the ones after it still run.
    await rerunMethods({ anchor, target, methods: AVAILABLE_METHODS }, (method, result) => {
      setOutcomes((current) => [
        ...current,
        result instanceof Error ? `${method}: ${result.message}` : describe(method, result),
      ]);
    });

    setBatchRunning(false);
    await loadAttempts();
  }, [anchor, loadAttempts, target]);

  const busy = running !== null || batchRunning;
  /** No anchor, no run. Stated once here so every control below reads the same condition. */
  const blocked = busy || anchor === null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* The full image, unlike the grid, which only ever fetches thumbnails. The token is on the
          request rather than in the URL - ADR-14. */}
      <Image
        source={imageSourceFor(target.id)}
        style={[styles.image, { aspectRatio: target.width / target.height }]}
        resizeMode="contain"
        onError={({ nativeEvent }) => setError(`Could not load the image: ${nativeEvent.error}`)}
      />

      {variants.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.label}>Input variant</Text>
          <Text style={styles.caption}>
            Which pixels a run reads. The uploaded variant is the fair comparison - identical bytes
            to what the server engines receive - and the original is what the on-device path can do
            at its best - ADR-2.
          </Text>
          <View style={styles.variants}>
            {variants.map((image) => {
              const selected = image.id === target.id;
              return (
                <Pressable
                  key={image.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  disabled={blocked}
                  style={({ pressed }) => [
                    styles.variant,
                    selected && styles.variantSelected,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => setTargetId(image.id)}
                >
                  <Text style={[styles.variantLabel, selected && styles.variantLabelSelected]}>
                    {image.variant}
                  </Text>
                  {/* Named before anything is fetched: an original can be several megabytes and
                      that is the operator's decision to make, not a surprise afterwards. */}
                  <Text style={[styles.variantMeta, selected && styles.variantLabelSelected]}>
                    {image.width}×{image.height} · {formatBytes(image.bytes)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {group !== null && group.length === 1 && (
        <Text style={styles.caption}>
          Only the {group[0]?.variant} variant is stored for this capture. The full-resolution
          original is archived in the background and not at all when ARCHIVE_ORIGINAL is off -
          ADR-3.
        </Text>
      )}

      <View style={styles.card}>
        <Text style={styles.label}>Capture metadata</Text>
        <Row label="Source" value={target.source} />
        <Row label="Variant" value={target.variant} />
        <Row
          label="Stored"
          value={`${target.width}×${target.height} · ${formatBytes(target.bytes)}`}
        />
        <Row label="Type" value={target.mimeType} />
        <Row
          label="Capture resolution"
          value={
            target.captureWidth === null || target.captureHeight === null
              ? 'n/a'
              : `${target.captureWidth}×${target.captureHeight}`
          }
        />
        {/* `torch` is null for a gallery import - no capture condition there was ours to set. */}
        <Row label="Torch" value={orNotApplicable(target.torch)} />
        <Row label="Downscaled" value={orNotApplicable(target.downscaled)} />
        <Row
          label="Captured"
          value={`${formatTimestamp(target.capturedAt)} · from ${target.capturedAtSource}`}
        />
        <Row label="Stored at" value={formatTimestamp(target.createdAt)} />
        <Text style={styles.mono} selectable>
          image {target.id}
        </Text>
        <Text style={styles.mono} selectable>
          group {target.captureGroupId}
        </Text>
      </View>

      {anchor === null && (
        // Not a spinner in place of the buttons: the operator should see what is missing and why,
        // and a group fetch that failed leaves this on screen rather than silently enabling a run
        // that would be filed against the wrong row - ADR-20.
        <Text style={styles.caption}>
          Waiting for this capture&apos;s uploaded row before anything can be run: an attempt
          against an original is recorded against it, and running before it is known would split the
          group. Pull the Library and open the capture again if this does not clear.
        </Text>
      )}

      <MethodButtons running={running} disabled={blocked} onRun={(method) => void runOne(method)} />

      <RerunAllButton
        available={AVAILABLE_METHODS}
        pending={PENDING_METHODS}
        payload={formatBytes(target.bytes)}
        running={batchRunning}
        disabled={running !== null || anchor === null}
        onPress={() => void runAll()}
      />

      {busy && <ActivityIndicator color={colors.accent} />}

      {outcomes.map((outcome) => (
        <Text key={outcome} style={styles.caption}>
          {outcome}
        </Text>
      ))}

      {error !== null && <Text style={styles.error}>{error}</Text>}

      <View style={styles.attempts}>
        <View style={styles.attemptsHeader}>
          <Text style={styles.label}>Attempts</Text>
          {anchor !== null && anchor.id !== target.id && (
            // Said out loud rather than left as a surprise in the data: the run reads the original's
            // pixels and the row lands on the uploaded image - ADR-20.
            <Text style={styles.caption}>recorded against the uploaded row</Text>
          )}
        </View>

        {attempts === null ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <AttemptGroupList attempts={attempts} />
        )}

        {anchor !== null && (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            onPress={() => navigation.navigate('Result', { imageId: anchor.id })}
          >
            <Text style={styles.secondaryLabel}>Full latency breakdown of every attempt</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  content: { gap: spacing.md, padding: spacing.md },
  image: {
    backgroundColor: '#000000',
    borderRadius: radius.md,
    width: '100%',
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: colors.text, flex: 1, fontSize: 13 },
  rowValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'], fontWeight: '600' },
  variants: { flexDirection: 'row', gap: spacing.sm },
  variant: {
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: 2,
    padding: spacing.sm,
  },
  variantSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  variantLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  variantLabelSelected: { color: '#ffffff' },
  variantMeta: { color: colors.textMuted, fontSize: 11 },
  attempts: { gap: spacing.sm },
  attemptsHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between' },
  mono: { color: colors.textMuted, fontFamily: 'monospace', fontSize: 11 },
  caption: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.offline, fontSize: 13, lineHeight: 18 },
  secondary: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm + 2,
  },
  secondaryLabel: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
