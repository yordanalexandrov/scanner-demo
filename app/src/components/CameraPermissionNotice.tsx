import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CameraPermission } from '../hooks/useCameraPermission';
import { colors, radius, spacing } from '../theme';

/**
 * The recoverable denied state - spec, § Gotchas.
 *
 * Whichever way the permission is missing, this renders a button that does something. A permanently
 * denied permission cannot show a dialog again, so the button opens system settings instead; the
 * hook re-reads the status when the app comes back, which is what clears this notice without a
 * restart.
 */

export interface CameraPermissionNoticeProps {
  permission: CameraPermission;
}

export function CameraPermissionNotice({ permission }: CameraPermissionNoticeProps) {
  if (permission.granted) {
    return null;
  }

  const permanentlyDenied = !permission.canAsk;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Camera permission required</Text>
      <Text style={styles.body}>
        {permanentlyDenied
          ? 'The camera permission was denied for good, so Android will not show the prompt again. Grant it under Permissions in the app settings, then come back - this notice clears itself.'
          : 'Barcode scanning and expiry-date capture need the camera. Nothing is recorded until you grant it.'}
      </Text>

      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={() => {
          void (permanentlyDenied ? permission.openSettings() : permission.request());
        }}
      >
        <Text style={styles.buttonLabel}>
          {permanentlyDenied ? 'Open settings' : 'Grant camera permission'}
        </Text>
      </Pressable>

      <Text style={styles.status}>Status: {permission.status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warningBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  body: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  status: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 12,
  },
});
