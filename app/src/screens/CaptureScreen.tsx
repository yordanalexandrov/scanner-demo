import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import { Camera, useCameraDevice, useCameraFormat } from 'react-native-vision-camera';
import { elapsed, now } from '@scanner-demo/shared';
import type { Method, Millis } from '@scanner-demo/shared';
import { ApiError } from '../api/client';
import { CameraPermissionNotice } from '../components/CameraPermissionNotice';
import { FramingGuide } from '../components/FramingGuide';
import { MethodButtons } from '../components/MethodButtons';
import { config } from '../config';
import { useCameraPermission } from '../hooks/useCameraPermission';
import { useIsForeground } from '../hooks/useIsForeground';
import {
  archiveOriginal,
  discard,
  parseExifCapturedAt,
  storeCapture,
  type CaptureSource,
  type StoredCapture,
} from '../lib/capture';
import { runMlKit } from '../lib/runMethod';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, radius, spacing } from '../theme';

/**
 * Expiry-date capture: one full-resolution photo, stored, then read by whichever method is pressed.
 *
 * **Deliberately a different camera configuration from the barcode screen, sharing no component
 * with it** - spec, § Screens — Expiry date capture. The two conflict outright: that screen wants a
 * continuously running low-resolution analysis stream that never restarts, this one wants a single
 * still at the maximum the sensor offers with focus settled before the shutter. Merging them would
 * degrade both, and the specification forbids it.
 */

/**
 * CameraX cancels a focus-and-metering action after five seconds and returns to continuous
 * autofocus. vision-camera 4.7.3 builds its `FocusMeteringAction` without `disableAutoCancel()`
 * (`CameraSession+Focus.kt:14`), so `focus()` is a focus *action*, not the focus *lock* the phase
 * document asks for. The shutter below re-focuses and waits whenever this window has lapsed, which
 * is what makes "no focus hunt during capture" true rather than merely intended.
 */
const FOCUS_AUTOCANCEL_MS = 5_000;

type Stage = 'framing' | 'capturing' | 'stored';

interface RunOutcome {
  variant: string;
  recordError: string | null;
  error: string | null;
}

export function CaptureScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const permission = useCameraPermission();
  const device = useCameraDevice('back');

  // The maximum the sensor offers. The hard case here is an embossed or laser-etched date, where
  // the difference between resolutions is the difference between readable and not.
  const format = useCameraFormat(device, [{ photoResolution: 'max' }]);

  const isFocused = useIsFocused();
  const isForeground = useIsForeground();

  const camera = useRef<Camera>(null);
  const focusedAtRef = useRef<Millis | null>(null);
  const focusPointRef = useRef<{ x: number; y: number } | null>(null);

  // Torch defaults to ON, without interaction - spec. Embossed dates need the light far more often
  // than they are hurt by it.
  const [torch, setTorch] = useState<'off' | 'on'>('on');

  const [stage, setStage] = useState<Stage>('framing');
  const [stored, setStored] = useState<StoredCapture | null>(null);
  const [source, setSource] = useState<CaptureSource | null>(null);
  const [archived, setArchived] = useState<boolean | null>(null);
  const [running, setRunning] = useState<Method | null>(null);
  const [outcomes, setOutcomes] = useState<RunOutcome[]>([]);
  const [error, setError] = useState<string | null>(null);

  const isActive = isFocused && isForeground && stage !== 'stored';

  const focusAt = useCallback(async (point: { x: number; y: number }) => {
    focusPointRef.current = point;
    try {
      await camera.current?.focus(point);
      focusedAtRef.current = now();
    } catch {
      // Some devices report focus as unsupported for a given point. Leaving the timestamp unset
      // means the shutter tries again rather than assuming a focus that never happened.
      focusedAtRef.current = null;
    }
  }, []);

  /** Re-focuses when the tap's five-second window has lapsed, so the shutter never fires mid-hunt. */
  const settleFocus = useCallback(async () => {
    const point = focusPointRef.current;
    const focusedAt = focusedAtRef.current;

    if (point === null) {
      return;
    }
    if (focusedAt !== null && elapsed(focusedAt) < FOCUS_AUTOCANCEL_MS) {
      return;
    }

    await focusAt(point);
  }, [focusAt]);

  const beginFrom = useCallback(async (captureSource: CaptureSource) => {
    try {
      const result = await storeCapture(captureSource);

      setSource(captureSource);
      setStored(result);
      setStage('stored');

      // Started strictly after the measured upload resolved - ADR-3, acceptance criterion 7.
      void archiveOriginal(result, captureSource)
        .then((didArchive) => {
          setArchived(didArchive);
          if (didArchive) {
            discard(result.original?.uri);
          }
        })
        .catch(() => setArchived(false));
    } catch (failure: unknown) {
      setError(
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : 'The capture could not be stored',
      );
      setStage('framing');
    }
  }, []);

  const capture = useCallback(async () => {
    if (camera.current === null || stage !== 'framing') {
      return;
    }

    setError(null);
    setOutcomes([]);
    setArchived(null);
    setStage('capturing');

    try {
      await settleFocus();

      const shutterAt = now();
      const photo = await camera.current.takePhoto({ flash: 'off', enableShutterSound: false });
      const captureMs = elapsed(shutterAt);

      await beginFrom({
        uri: `file://${photo.path}`,
        width: photo.width,
        height: photo.height,
        source: 'camera',
        // eslint-disable-next-line no-restricted-syntax -- ordered timestamp, not a duration
        capturedAt: Date.now(),
        capturedAtSource: 'camera',
        torch: torch === 'on',
        captureMs,
      });
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'The capture failed');
      setStage('framing');
    }
  }, [beginFrom, settleFocus, stage, torch]);

  const importFromGallery = useCallback(async () => {
    setError(null);
    setOutcomes([]);
    setArchived(null);

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // No editing and no re-encoding: the dataset is only worth having if the bytes are the ones
      // the photograph actually had.
      allowsEditing: false,
      quality: 1,
      exif: true,
    });

    const asset = picked.assets?.[0];
    if (picked.canceled || asset === undefined) {
      return;
    }

    setStage('capturing');

    const exifCapturedAt = parseExifCapturedAt(
      (asset.exif as Record<string, unknown> | undefined)?.['DateTimeOriginal'],
    );

    await beginFrom({
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      source: 'gallery',
      // eslint-disable-next-line no-restricted-syntax -- ordered timestamp, not a duration
      capturedAt: exifCapturedAt ?? Date.now(),
      capturedAtSource: exifCapturedAt === null ? 'import' : 'exif',
      // Nothing about this photo's capture conditions was ours to set - ADR-3.
      torch: null,
      // No capture happened on this path. `null`, never `0` - a zero would enter every average.
      captureMs: null,
    });
  }, [beginFrom]);

  /**
   * Runs the on-device path over **both** variants and records two attempts - ADR-2.
   *
   * The `upload` run is the fair comparison: identical bytes to what the server engines will read.
   * The `original` run is what the on-device path can do at its best, and the gap between the two
   * is a direct measurement of what the downscale costs in accuracy.
   */
  const run = useCallback(
    async (method: Method) => {
      if (stored === null || source === null || method !== 'mlkit') {
        return;
      }

      setRunning(method);
      setOutcomes([]);

      const referenceDate = new Date(stored.capturedAt);
      const results: RunOutcome[] = [];

      const variants = [
        { variant: 'upload' as const, image: stored.upload },
        ...(stored.original === null
          ? []
          : [{ variant: 'original' as const, image: stored.original }]),
      ];

      for (const { variant, image } of variants) {
        const startedAt = now();
        const outcome = await runMlKit({
          imageId: stored.imageId,
          captureGroupId: stored.captureGroupId,
          inputVariant: variant,
          uri: image.uri,
          imageWidth: image.width,
          imageHeight: image.height,
          referenceDate,
          prior: {
            // Only the `upload` variant went through the measured path. Attributing the capture and
            // the upload to the second run as well would count them twice - ADR-10.
            captureMs: variant === 'upload' ? source.captureMs : null,
            downscaleMs: variant === 'upload' ? stored.downscaleMs : null,
            uploadMs: variant === 'upload' ? stored.uploadMs : null,
            downloadMs: null,
          },
          startedAt,
        });

        results.push({ variant, recordError: outcome.recordError, error: outcome.attempt.error });
      }

      setOutcomes(results);
      setRunning(null);
      navigation.navigate('Result', { imageId: stored.imageId });
    },
    [navigation, source, stored],
  );

  const reset = useCallback(() => {
    // `takePhoto` writes a temporary file and nothing deletes it for us. Criterion 4 checks that no
    // full-size photo survives the flow in the app's directories or the gallery.
    discard(stored?.upload.uri);
    discard(stored?.original?.uri);
    setStored(null);
    setSource(null);
    setOutcomes([]);
    setArchived(null);
    setError(null);
    setStage('framing');
  }, [stored]);

  if (!permission.granted) {
    return (
      <View style={styles.gate}>
        <CameraPermissionNotice permission={permission} />
      </View>
    );
  }

  if (device === undefined) {
    return (
      <View style={styles.gate}>
        <Text style={styles.gateText}>No back camera on this device.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.preview}>
        {stage !== 'stored' && (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={(event) =>
              void focusAt({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY })
            }
          >
            <Camera
              ref={camera}
              style={StyleSheet.absoluteFill}
              device={device}
              format={format}
              isActive={isActive}
              photo
              torch={torch}
              onError={(cameraError) => setError(cameraError.message)}
            />
            <FramingGuide hint="Fill the frame with the printed date, then tap to focus" />
          </Pressable>
        )}

        <View style={styles.overlayTop} pointerEvents="box-none">
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {stage === 'stored' ? 'captured' : 'live'} · {config.downscaleLongEdge}px q
              {config.downscaleQuality}
              {config.archiveOriginal ? ' · archiving' : ''}
            </Text>
          </View>

          {stage !== 'stored' && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Toggle torch"
              style={({ pressed }) => [
                styles.torch,
                torch === 'on' && styles.torchOn,
                pressed && styles.pressed,
              ]}
              onPress={() => setTorch((current) => (current === 'on' ? 'off' : 'on'))}
            >
              <Text style={[styles.torchLabel, torch === 'on' && styles.torchLabelOn]}>
                Torch {torch}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
        {error !== null && <Text style={styles.error}>{error}</Text>}

        {stage !== 'stored' ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={stage === 'capturing'}
              style={({ pressed }) => [
                styles.shutter,
                stage === 'capturing' && styles.blocked,
                pressed && styles.pressed,
              ]}
              onPress={() => void capture()}
            >
              {stage === 'capturing' ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Text style={styles.shutterLabel}>Capture</Text>
              )}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={stage === 'capturing'}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              onPress={() => void importFromGallery()}
            >
              <Text style={styles.secondaryLabel}>Import from gallery</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.label}>Stored</Text>
              <Text style={styles.mono}>{stored?.imageId}</Text>
              <Text style={styles.caption}>
                {source?.source === 'gallery' ? 'Gallery import' : 'Camera capture'} ·{' '}
                {stored?.upload.width}×{stored?.upload.height} uploaded
                {stored?.original !== null && ` · ${source?.width}×${source?.height} captured`}
              </Text>
              {source?.source === 'gallery' && (
                // A gallery import has no controlled capture conditions. Its results are valid for
                // comparing OCR accuracy and meaningless for comparing capture latency, so it is
                // labelled here rather than only in the data - criterion 5.
                <Text style={styles.caption}>
                  No capture latency and no torch state · reference date from{' '}
                  {source.capturedAtSource === 'exif' ? 'EXIF' : 'import time'}
                </Text>
              )}
              {archived !== null && (
                <Text style={styles.caption}>
                  {archived
                    ? 'Full-resolution original archived after the measured upload'
                    : 'Original not archived'}
                </Text>
              )}
            </View>

            <MethodButtons
              running={running}
              disabled={false}
              onRun={(method) => void run(method)}
            />

            {outcomes.map((outcome) => (
              <Text
                key={outcome.variant}
                style={outcome.recordError === null ? styles.caption : styles.error}
              >
                {outcome.variant}: {outcome.error ?? 'read'} · {outcome.recordError ?? 'recorded'}
              </Text>
            ))}

            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
              onPress={reset}
            >
              <Text style={styles.secondaryLabel}>Capture another</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  gate: { flex: 1, padding: spacing.md },
  gateText: { color: colors.text, fontSize: 15 },
  preview: { backgroundColor: '#000000', flex: 1, minHeight: 240 },
  overlayTop: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    padding: spacing.sm,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  badge: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  badgeText: { color: '#ffffff', fontFamily: 'monospace', fontSize: 12 },
  torch: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  torchOn: { backgroundColor: '#ffffff' },
  torchLabel: { color: '#ffffff', fontSize: 13, fontWeight: '600' },
  torchLabelOn: { color: colors.text },
  panel: { flex: 1 },
  panelContent: { gap: spacing.sm, padding: spacing.md },
  actions: { gap: spacing.sm },
  shutter: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
  },
  shutterLabel: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  secondary: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm + 2,
  },
  secondaryLabel: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  blocked: { opacity: 0.6 },
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
  mono: { color: colors.text, fontFamily: 'monospace', fontSize: 13 },
  caption: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.offline, fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.7 },
});
