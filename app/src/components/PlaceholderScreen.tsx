import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

/**
 * A destination that exists in the navigation graph but whose contents belong to a later phase.
 *
 * It names the phase deliberately. A placeholder that says only "coming soon" is indistinguishable
 * from a screen someone forgot to finish.
 */

export interface PlaceholderScreenProps {
  phase: string;
  summary: string;
}

export function PlaceholderScreen({ phase, summary }: PlaceholderScreenProps) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.phase}>{phase}</Text>
        <Text style={styles.summary}>{summary}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.md,
    justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  phase: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  summary: {
    color: colors.text,
    fontSize: 16,
    lineHeight: 23,
  },
});
