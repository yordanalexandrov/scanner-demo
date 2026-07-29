import { StyleSheet, Text, View } from 'react-native';
import type { Millis } from '@scanner-demo/shared';
import { formatMs } from '../format';
import { colors, radius, spacing } from '../theme';

/**
 * The result card the specification asks for: the decoded value, and the decode latency in ms.
 *
 * It also carries whether the row reached the server, because a benchmark screen that shows a
 * number it silently failed to persist is worse than one that shows nothing - ADR-1.
 */

/** Where a scan is on its way to the server. Not a measurement - purely the recording state. */
export type ScanRecordState = 'saving' | 'saved' | 'failed';

export interface SessionScan {
  /** Local list key. The server assigns the real ID; this one never leaves the phone. */
  key: string;
  value: string;
  decodeMs: Millis;
  /**
   * The first reading after the camera session started, which is the only one measured from
   * screen-ready in the phase document's literal sense - and the only one containing camera
   * warm-up. Flagged rather than dropped: the phase's risk note leaves that decision to the review.
   */
  firstOfSession: boolean;
  state: ScanRecordState;
  /** Why the row is not on the server yet, or `null` while nothing has gone wrong. */
  error: string | null;
}

const STATE_LABEL: Record<ScanRecordState, string> = {
  saving: 'recording…',
  saved: 'recorded on the server',
  failed: 'not recorded',
};

const STATE_COLOR: Record<ScanRecordState, string> = {
  saving: colors.checking,
  saved: colors.online,
  failed: colors.offline,
};

export interface BarcodeResultCardProps {
  scan: SessionScan | null;
}

export function BarcodeResultCard({ scan }: BarcodeResultCardProps) {
  if (scan === null) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>Latest scan</Text>
        <Text style={styles.empty}>
          The camera is already running. Hold an EAN-13 in the frame - no button to press.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.label}>Latest scan</Text>

      <Text style={styles.value} selectable>
        {scan.value}
      </Text>

      <Text style={styles.latency}>{formatMs(scan.decodeMs)}</Text>

      <Text style={styles.caption}>
        {scan.firstOfSession
          ? 'from camera start to callback - includes camera warm-up'
          : 'from the previous decode to this callback'}
      </Text>

      <View style={styles.stateRow}>
        <View style={[styles.dot, { backgroundColor: STATE_COLOR[scan.state] }]} />
        <Text style={[styles.stateText, { color: STATE_COLOR[scan.state] }]}>
          {STATE_LABEL[scan.state]}
        </Text>
      </View>

      {scan.error !== null && <Text style={styles.error}>{scan.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  empty: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
  },
  value: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 22,
    letterSpacing: 1,
  },
  latency: {
    color: colors.accent,
    fontSize: 28,
    fontWeight: '700',
  },
  caption: {
    color: colors.textMuted,
    fontSize: 12,
  },
  stateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  dot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  stateText: {
    fontSize: 13,
    fontWeight: '600',
  },
  error: {
    color: colors.offline,
    fontSize: 12,
    lineHeight: 17,
  },
});
