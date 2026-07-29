import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useAudioPlayer } from 'expo-audio';
import { trigger as triggerHaptic } from 'react-native-haptic-feedback';
import {
  Camera,
  useCameraDevice,
  useCameraFormat,
  useCodeScanner,
} from 'react-native-vision-camera';
import type { Code, CodeScannerFrame } from 'react-native-vision-camera';
import { median, now } from '@scanner-demo/shared';
import type { Millis } from '@scanner-demo/shared';
// 70 ms of 1800 Hz, 16-bit mono PCM at 44.1 kHz, with a 5 ms linear fade at each end so it does not
// click. A generated tone rather than a recording: it has to be short enough to land inside the
// moment it is confirming.
import beepSound from '../../assets/beep.wav';
import { createBarcodeScan } from '../api/barcodeScans';
import { ApiError } from '../api/client';
import { BarcodeResultCard } from '../components/BarcodeResultCard';
import type { SessionScan } from '../components/BarcodeResultCard';
import { CameraPermissionNotice } from '../components/CameraPermissionNotice';
import { describeDevice } from '../device';
import { formatMs } from '../format';
import { useCameraPermission } from '../hooks/useCameraPermission';
import { useIsForeground } from '../hooks/useIsForeground';
import { useScreenReadyClock } from '../hooks/useScreenReadyClock';
import { colors, radius, spacing } from '../theme';

/**
 * Goal 1 of the project, with a number attached: how long from the scanner being ready to an EAN-13
 * coming back, on real packaging, measured repeatedly.
 *
 * Three things about this screen are load-bearing and must not be "tidied up":
 *
 * - **The camera opens on mount.** `isActive` is derived from screen focus and app foreground and
 *   from nothing else. There is no start button, because the session opening on a press is the
 *   single biggest latency factor there is - spec, § Screens - Barcode scan.
 * - **The camera is never restarted between reads.** A hit changes what is drawn over the preview
 *   and nothing about the session. The session counter in the status line is on screen so that this
 *   is observable rather than merely asserted.
 * - **The measurement is the first statement of the scanner callback.** The dedupe check, the
 *   haptic, the beep and the state update all happen after it, so none of them is inside the
 *   number.
 *
 * This screen shares no component with the capture screen of phase 05. The two camera
 * configurations conflict - a continuously running 720p analysis stream against a single
 * full-resolution still with focus lock - and the specification forbids merging them.
 */

/** Ignore the same value for this long - spec, § Screens - Barcode scan. */
const DEDUPE_WINDOW_MS = 800;

/** 720p is enough for a barcode and keeps the analysis stream cheap - spec. */
const ANALYSIS_RESOLUTION = { width: 1280, height: 720 } as const;

const HAPTIC_OPTIONS = {
  enableVibrateFallback: true,
  // The buzz is how the user knows the callback fired; it is confirmation of a measurement rather
  // than decoration, so it must not depend on a system-wide toggle the phone happens to have off.
  ignoreAndroidSystemSettings: true,
};

/** Constant for the lifetime of the process, so it is read once rather than per scan. */
const DEVICE = describeDevice();

export function BarcodeScreen() {
  const permission = useCameraPermission();
  const device = useCameraDevice('back');
  const format = useCameraFormat(device, [{ videoResolution: ANALYSIS_RESOLUTION }]);

  // Focus and foreground only. A piece of state that a button sets must never appear in this
  // expression - phase 04 acceptance criterion 3.
  const isFocused = useIsFocused();
  const isForeground = useIsForeground();
  const isActive = isFocused && isForeground;

  const clock = useScreenReadyClock();
  const beep = useAudioPlayer(beepSound);

  const [torch, setTorch] = useState<'off' | 'on'>('off');
  const [scans, setScans] = useState<SessionScan[]>([]);
  const [sessions, setSessions] = useState(0);
  const [analysis, setAnalysis] = useState<CodeScannerFrame | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  /**
   * Last accepted time per value, so "the same value" means that value and not merely the previous
   * one - alternating between two codes must not defeat the window. Anchored on accepted scans
   * only: refreshing it on every dropped repeat would slide the window forward indefinitely and a
   * code held in front of the lens would record exactly once, which is not what "ignored for
   * 800 ms" says.
   */
  const lastAcceptedRef = useRef(new Map<string, Millis>());
  const nextKeyRef = useRef(0);

  const record = useCallback(async (scan: { key: string; value: string; decodeMs: Millis }) => {
    try {
      await createBarcodeScan({ value: scan.value, decodeMs: scan.decodeMs, device: DEVICE });
      setScans((current) =>
        current.map((row) =>
          row.key === scan.key ? { ...row, state: 'saved', error: null } : row,
        ),
      );
    } catch (failure: unknown) {
      const message =
        failure instanceof ApiError || failure instanceof Error
          ? failure.message
          : 'Could not record the scan';
      setScans((current) =>
        current.map((row) =>
          row.key === scan.key ? { ...row, state: 'failed', error: message } : row,
        ),
      );
    }
  }, []);

  const onCodeScanned = useCallback(
    (codes: Code[], frame: CodeScannerFrame) => {
      // The measurement, before anything else in this callback. Everything below - the lookup, the
      // dedupe check, the feedback, the re-render - happens after the decode and would otherwise be
      // inside the figure this phase exists to produce.
      const at = now();

      const value = codes.find((code) => code.value !== undefined)?.value;
      if (value === undefined) {
        return;
      }

      const lastAccepted = lastAcceptedRef.current.get(value);
      if (lastAccepted !== undefined && at - lastAccepted < DEDUPE_WINDOW_MS) {
        return;
      }

      // Read before `consume`, which is what makes the reading no longer the first one.
      const firstOfSession = clock.isFirstReading();
      const decodeMs = clock.consume(at);

      if (decodeMs === null) {
        // A decode with no running session has no origin to measure against. It is not recorded as
        // `0 ms` - a null measurement is null - and it is not confirmed with a beep either, because
        // confirming a scan that was thrown away is a lie. Unreachable while the session runs.
        return;
      }

      lastAcceptedRef.current.set(value, at);
      for (const [seen, when] of lastAcceptedRef.current) {
        if (at - when >= DEDUPE_WINDOW_MS) {
          lastAcceptedRef.current.delete(seen);
        }
      }

      // Fired before any rendering work, so neither is queued behind a re-render - spec.
      triggerHaptic('impactMedium', HAPTIC_OPTIONS);
      // Rewound first: the player is parked at the end of the previous beep and `play()` from there
      // is silent. Neither call is awaited - the measurement is already taken, and a beep that
      // fails must not cost a scan.
      beep.seekTo(0).catch(() => undefined);
      beep.play();

      nextKeyRef.current += 1;
      const key = String(nextKeyRef.current);

      setScans((current) => [
        { key, value, decodeMs, firstOfSession, state: 'saving', error: null },
        ...current,
      ]);

      // What the scanner actually looked at, reported by the scanner itself rather than by the
      // format we asked for. It is on screen so that "720p analysis stream" is something a reviewer
      // can read off the device instead of taking on trust.
      setAnalysis((current) =>
        current?.width === frame.width && current.height === frame.height ? current : frame,
      );

      void record({ key, value, decodeMs });
    },
    [beep, clock, record],
  );

  const codeScanner = useCodeScanner({
    // EAN-13 and nothing else. The scanner is configured for one format rather than filtered
    // afterwards, so a QR code or a Code 128 is never decoded in the first place - spec.
    codeTypes: ['ean-13'],
    onCodeScanned,
  });

  const onStarted = useCallback(() => {
    clock.arm();
    setSessions((count) => count + 1);
    setCameraError(null);
    console.log('[barcode] camera session started');
  }, [clock]);

  /**
   * Measured on an SM-S928B: vision-camera 4.7.3 does not deliver this on Android - three camera
   * sessions produced three `started` logs and no `stopped` one. It is kept because it is correct
   * and costs nothing if the library starts firing it, but nothing may depend on it: the origin is
   * safe regardless, since `arm()` overwrites it on every start, and camera sessions have to be
   * counted from the `started` log alone.
   */
  const onStopped = useCallback(() => {
    clock.disarm();
    console.log('[barcode] camera session stopped');
  }, [clock]);

  const sessionMedian = useMemo(() => median(scans.map((scan) => scan.decodeMs)), [scans]);
  const unsaved = useMemo(() => scans.filter((scan) => scan.state === 'failed'), [scans]);

  const retryUnsaved = useCallback(() => {
    setScans((current) =>
      current.map((row) => (row.state === 'failed' ? { ...row, state: 'saving' } : row)),
    );
    for (const row of unsaved) {
      void record({ key: row.key, value: row.value, decodeMs: row.decodeMs });
    }
  }, [record, unsaved]);

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
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          // Focus and foreground. Never a press handler - acceptance criterion 3.
          isActive={isActive}
          torch={torch}
          codeScanner={codeScanner}
          onStarted={onStarted}
          onStopped={onStopped}
          onError={(error) => setCameraError(error.message)}
        />

        <View style={styles.overlayTop} pointerEvents="box-none">
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {isActive ? 'live' : 'paused'} · session {sessions}
              {analysis !== null ? ` · ${analysis.width}×${analysis.height}` : ''}
            </Text>
          </View>

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
        </View>

        {scans[0] !== undefined && (
          // The visible half of the hit, alongside the haptic and the beep. It draws over the
          // preview and touches nothing about the session, which is what keeps the pipeline running
          // through ten scans in a row.
          <View style={styles.overlayBottom} pointerEvents="none">
            <Text style={styles.overlayValue}>{scans[0].value}</Text>
            <Text style={styles.overlayLatency}>{formatMs(scans[0].decodeMs)}</Text>
          </View>
        )}
      </View>

      <ScrollView style={styles.panel} contentContainerStyle={styles.panelContent}>
        {cameraError !== null && <Text style={styles.cameraError}>Camera: {cameraError}</Text>}

        <BarcodeResultCard scan={scans[0] ?? null} />

        <View style={styles.card}>
          <Text style={styles.label}>This session</Text>
          <Text style={styles.summary}>
            {scans.length} {scans.length === 1 ? 'scan' : 'scans'} · median{' '}
            {formatMs(sessionMedian)}
          </Text>
          <Text style={styles.caption}>
            The median covers the scans listed below - this session only, on this device. The full
            history on the server spans sessions and handsets and would not be comparable.
          </Text>

          {unsaved.length > 0 && (
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
              onPress={retryUnsaved}
            >
              <Text style={styles.retryLabel}>
                Retry {unsaved.length} unrecorded {unsaved.length === 1 ? 'scan' : 'scans'}
              </Text>
            </Pressable>
          )}
        </View>

        {scans.map((scan, index) => (
          <View key={scan.key} style={styles.row}>
            <Text style={styles.rowIndex}>{scans.length - index}</Text>
            <Text style={styles.rowValue}>{scan.value}</Text>
            <Text style={styles.rowLatency}>{formatMs(scan.decodeMs)}</Text>
            <Text style={[styles.rowState, scan.state === 'failed' && styles.rowStateFailed]}>
              {scan.firstOfSession ? 'first' : ''}
              {scan.firstOfSession && scan.state !== 'saved' ? ' · ' : ''}
              {scan.state === 'saved' ? '' : scan.state === 'saving' ? '…' : 'unsaved'}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: colors.background,
    flex: 1,
  },
  gate: {
    flex: 1,
    padding: spacing.md,
  },
  gateText: {
    color: colors.text,
    fontSize: 15,
  },
  preview: {
    backgroundColor: '#000000',
    flex: 1,
    minHeight: 260,
  },
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
  badgeText: {
    color: '#ffffff',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  torch: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  torchOn: {
    backgroundColor: '#ffffff',
  },
  torchLabel: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  torchLabelOn: {
    color: colors.text,
  },
  overlayBottom: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    bottom: 0,
    left: 0,
    padding: spacing.sm,
    position: 'absolute',
    right: 0,
  },
  overlayValue: {
    color: '#ffffff',
    fontFamily: 'monospace',
    fontSize: 18,
    letterSpacing: 1,
  },
  overlayLatency: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  panel: {
    flex: 1,
  },
  panelContent: {
    gap: spacing.sm,
    padding: spacing.md,
  },
  cameraError: {
    color: colors.offline,
    fontSize: 13,
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
  summary: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '600',
  },
  caption: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  retry: {
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  retryLabel: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowIndex: {
    color: colors.textMuted,
    fontSize: 12,
    minWidth: 20,
  },
  rowValue: {
    color: colors.text,
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  rowLatency: {
    color: colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  rowState: {
    color: colors.textMuted,
    fontSize: 11,
    minWidth: 46,
    textAlign: 'right',
  },
  rowStateFailed: {
    color: colors.offline,
  },
  pressed: {
    opacity: 0.7,
  },
});
