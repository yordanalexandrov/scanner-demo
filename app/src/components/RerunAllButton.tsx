import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Method } from '@scanner-demo/shared';
import { colors, radius, spacing } from '../theme';

/**
 * "Re-run all methods on this image" - spec, § Screens — Image library.
 *
 * **This is the one place a batch action belongs**, and the capture screen deliberately has none: it
 * works on a fixed stored image rather than on a live capture, so every method reads identical bytes
 * and the runs are comparable. Pressing it is still four independent runs recorded as four separate
 * attempts, merely triggered together - one of them failing does not stop the others.
 *
 * The button names what it is about to fetch. A full-resolution original is several megabytes, and
 * an operator on mobile data should decide that before the download starts rather than after.
 */

export interface RerunAllButtonProps {
  /** The methods that exist today. Phases 07 to 09 add the other three. */
  available: readonly Method[];
  /** The methods still waiting for their phase, so the button says what it is not doing. */
  pending: readonly Method[];
  /** What one press will download, already formatted - the selected variant's size. */
  payload: string;
  running: boolean;
  disabled: boolean;
  onPress: () => void;
}

export function RerunAllButton({
  available,
  pending,
  payload,
  running,
  disabled,
  onPress,
}: RerunAllButtonProps) {
  const blocked = disabled || running || available.length === 0;

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: blocked, busy: running }}
        disabled={blocked}
        style={({ pressed }) => [
          styles.button,
          blocked && styles.blocked,
          pressed && styles.pressed,
        ]}
        onPress={onPress}
      >
        <Text style={styles.label}>Re-run all methods</Text>
        {running ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Text style={styles.count}>{available.length}</Text>
        )}
      </Pressable>

      <Text style={styles.caption}>
        {available.join(', ') || 'no method is available yet'} · downloads {payload}
        {pending.length > 0 && ` · ${pending.join(', ')} arrive with their phases`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  button: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  blocked: { opacity: 0.55 },
  label: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  count: { color: '#ffffff', fontSize: 13, fontVariant: ['tabular-nums'] },
  caption: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  pressed: { opacity: 0.7 },
});
