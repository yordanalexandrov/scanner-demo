import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Method } from '@scanner-demo/shared';
import { colors, radius, spacing } from '../theme';

/**
 * The four methods, as four separate buttons, run one at a time.
 *
 * **There is deliberately no "run all" control here** - spec, § Screens — Expiry date capture. The
 * methods are meant to be evaluated one at a time and watched while they run; a batch action
 * appears once the methods have been evaluated separately, in the Library, in phase 06.
 *
 * The server methods that have no phase yet are present but disabled, each naming the phase that
 * turns it on. Absent buttons would leave the screen looking finished when it is not, and would
 * hide the fact that the comparison is a comparison of four.
 */

export interface MethodDescriptor {
  method: Method;
  label: string;
  /** `null` when the method is available; otherwise why it is not, naming its phase. */
  unavailable: string | null;
}

export const METHODS: readonly MethodDescriptor[] = [
  { method: 'mlkit', label: 'ML Kit · on-device', unavailable: null },
  { method: 'onnx-paddleocr', label: 'Self-hosted OCR', unavailable: null },
  { method: 'gcv', label: 'Google Cloud Vision', unavailable: 'Phase 08' },
  { method: 'vlm', label: 'VLM', unavailable: 'Phase 09' },
];

export interface MethodButtonsProps {
  /** The method currently running, or `null`. One at a time, so this is not a set. */
  running: Method | null;
  disabled: boolean;
  onRun: (method: Method) => void;
}

export function MethodButtons({ running, disabled, onRun }: MethodButtonsProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>Methods</Text>

      {METHODS.map((descriptor) => {
        const isRunning = running === descriptor.method;
        const blocked = descriptor.unavailable !== null || disabled || running !== null;

        return (
          <Pressable
            key={descriptor.method}
            accessibilityRole="button"
            accessibilityState={{ disabled: blocked, busy: isRunning }}
            disabled={blocked}
            style={({ pressed }) => [
              styles.button,
              blocked && styles.blocked,
              pressed && styles.pressed,
            ]}
            onPress={() => onRun(descriptor.method)}
          >
            <Text style={[styles.buttonLabel, blocked && styles.blockedLabel]}>
              {descriptor.label}
            </Text>

            {isRunning ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              descriptor.unavailable !== null && (
                <Text style={styles.phase}>{descriptor.unavailable}</Text>
              )
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  label: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  button: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  blocked: {
    opacity: 0.55,
  },
  buttonLabel: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  blockedLabel: {
    color: colors.textMuted,
  },
  phase: {
    color: colors.textMuted,
    fontSize: 12,
  },
  pressed: {
    opacity: 0.7,
  },
});
