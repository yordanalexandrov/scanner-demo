import { StyleSheet, Text, View } from 'react-native';
import type { Timing } from '@scanner-demo/shared';
import { formatMs } from '../format';
import { colors, spacing } from '../theme';

/**
 * The latency breakdown - spec, screen 5.
 *
 * Two rules here are not cosmetic:
 *
 * - **A `null` segment renders "n/a", never "0 ms".** `null` means "not applicable on this path" -
 *   a gallery import has no capture, a re-run has neither capture nor upload - and showing it as
 *   zero would corrupt every average computed from what is on screen.
 * - **Capture cost is outside the method total.** It happened once before any method was invoked
 *   and must not enter a method median or be charged repeatedly to every engine - ADR-22.
 * - **Nothing here subtracts a phone-measured value from a server-measured one.** The network
 *   estimate below is derived from two stored fields and labelled as an estimate; it is never
 *   presented as a precise figure, because its two operands come from unrelated clocks - ADR-10.
 */

export interface LatencyBreakdownProps {
  timing: Timing;
  /** What `engineMs` covers on this path. The label changes meaning without it - ADR-10. */
  engineMsScope: 'inference' | 'inference+network' | null;
  /** A capture has one shared cost even when it has many attempt rows - ADR-22. */
  showCaptureCost: boolean;
}

interface Segment {
  label: string;
  value: number | null;
  note?: string;
}

export function LatencyBreakdown({
  timing,
  engineMsScope,
  showCaptureCost,
}: LatencyBreakdownProps) {
  const captureSegments: Segment[] = [
    { label: 'Capture', value: timing.captureMs },
    { label: 'Downscale', value: timing.downscaleMs },
    { label: 'Upload', value: timing.uploadMs },
  ];
  const methodSegments: Segment[] = [
    { label: 'Download', value: timing.downloadMs },
    { label: 'Request round trip', value: timing.requestMs },
    {
      label: 'Engine',
      value: timing.engineMs,
      note: engineMsScope === null ? undefined : engineMsScope,
    },
    { label: 'Server handler', value: timing.serverTotalMs },
    { label: 'Parse', value: timing.parseMs },
  ];
  const applicableCaptureSegments = captureSegments
    .map((segment) => segment.value)
    .filter((value): value is number => value !== null);
  const captureCostMs =
    applicableCaptureSegments.length === 0
      ? null
      : applicableCaptureSegments.reduce((total, value) => total + value, 0);

  // Both operands are stored, so this can be recomputed from the export rather than existing only
  // here - ADR-10. It stays an estimate: one number came off the phone's clock and the other off
  // the server's, and no amount of presentation makes that difference precise.
  const networkEstimate =
    timing.requestMs !== null && timing.serverTotalMs !== null
      ? timing.requestMs - timing.serverTotalMs
      : null;

  return (
    <View style={styles.container}>
      {showCaptureCost && (
        <>
          <Text style={styles.label}>Capture cost · shared, outside method total</Text>

          {captureSegments.map((segment) => (
            <View key={segment.label} style={styles.row}>
              <Text style={styles.rowLabel}>
                {segment.label}
                {segment.note !== undefined && <Text style={styles.note}> · {segment.note}</Text>}
              </Text>
              <Text style={[styles.rowValue, segment.value === null && styles.notApplicable]}>
                {formatMs(segment.value)}
              </Text>
            </View>
          ))}

          <View style={[styles.row, styles.subtotalRow]}>
            <Text style={styles.subtotalLabel}>Capture cost</Text>
            <Text style={[styles.rowValue, captureCostMs === null && styles.notApplicable]}>
              {formatMs(captureCostMs)}
            </Text>
          </View>
        </>
      )}

      <Text style={[styles.label, showCaptureCost && styles.methodLabel]}>Method latency</Text>

      {methodSegments.map((segment) => (
        <View key={segment.label} style={styles.row}>
          <Text style={styles.rowLabel}>
            {segment.label}
            {segment.note !== undefined && <Text style={styles.note}> · {segment.note}</Text>}
          </Text>
          <Text style={[styles.rowValue, segment.value === null && styles.notApplicable]}>
            {formatMs(segment.value)}
          </Text>
        </View>
      ))}

      {networkEstimate !== null && (
        <View style={styles.row}>
          <Text style={styles.rowLabel}>
            Network<Text style={styles.note}> · estimate, two clocks</Text>
          </Text>
          <Text style={styles.estimate}>≈ {formatMs(networkEstimate)}</Text>
        </View>
      )}

      <View style={[styles.row, styles.totalRow]}>
        <Text style={styles.totalLabel}>Method total · phone clock</Text>
        <Text style={styles.totalValue}>{formatMs(timing.totalMs)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  methodLabel: {
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  rowLabel: {
    color: colors.text,
    flex: 1,
    fontSize: 13,
  },
  note: {
    color: colors.textMuted,
    fontSize: 11,
  },
  rowValue: {
    color: colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
  },
  notApplicable: {
    color: colors.textMuted,
    fontWeight: '400',
  },
  estimate: {
    color: colors.textMuted,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  subtotalRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
  },
  subtotalLabel: {
    color: colors.text,
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  totalRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
  },
  totalLabel: {
    color: colors.text,
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
  },
  totalValue: {
    color: colors.accent,
    fontSize: 15,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
