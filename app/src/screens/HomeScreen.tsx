import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraPermissionNotice } from '../components/CameraPermissionNotice';
import { config } from '../config';
import { useCameraPermission } from '../hooks/useCameraPermission';
import { useServerHealth, type ServerHealthStatus } from '../hooks/useServerHealth';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { colors, radius, spacing } from '../theme';

/**
 * Home - the configured server, whether it is reachable, and the way in to every other screen.
 *
 * The health indicator is the point of this screen. Before any measurement is worth taking, it has
 * to be obvious at a glance that the app is talking to the server it thinks it is.
 */

/**
 * The routes that take no parameters, minus the one already being looked at.
 *
 * Derived rather than listed: a screen that needs an image - `Result`, `ImageDetail` - is not a place
 * to go from here, it is somewhere a capture or a grid tile leads to. Stating the rule as a type
 * means adding such a screen cannot silently put an un-navigable entry on this list, and `navigate`
 * stays typed without a cast.
 */
type ParameterlessRoute = {
  [Route in keyof RootStackParamList]: RootStackParamList[Route] extends undefined ? Route : never;
}[keyof RootStackParamList];

type Destination = Exclude<ParameterlessRoute, 'Home'>;

const DESTINATIONS: ReadonlyArray<{ route: Destination; title: string; subtitle: string }> = [
  { route: 'Barcode', title: 'Barcode', subtitle: 'Scan EAN-13 and record decode latency' },
  { route: 'Capture', title: 'Capture', subtitle: 'Photograph an expiry date and run the methods' },
  { route: 'Library', title: 'Library', subtitle: 'Stored images, re-runnable at any time' },
  { route: 'History', title: 'History', subtitle: 'Attempts, accuracy, latency and cost' },
];

const STATUS_LABEL: Record<ServerHealthStatus, string> = {
  checking: 'Checking…',
  online: 'Reachable',
  offline: 'Unreachable',
};

const STATUS_COLOR: Record<ServerHealthStatus, string> = {
  checking: colors.checking,
  online: colors.online,
  offline: colors.offline,
};

/** Server uptime, for reading rather than for arithmetic - a restart is visible as it dropping. */
function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function HomeScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const health = useServerHealth();
  const permission = useCameraPermission();

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Server</Text>
          <Text style={styles.url} selectable>
            {config.serverUrl}
          </Text>

          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: STATUS_COLOR[health.status] }]} />
            <Text style={[styles.statusText, { color: STATUS_COLOR[health.status] }]}>
              {STATUS_LABEL[health.status]}
            </Text>
          </View>

          {health.health !== null && (
            // Prefixed once the server stops answering. These are the last values it sent, and an
            // unlabelled "up 1m 2s" under a red "Unreachable" reads as a live fact about a server
            // that is down. Stale is fine to show; stale dressed as current is not.
            <Text style={styles.meta}>
              {health.status === 'online' ? '' : 'last seen: '}
              version {health.health.version} · up {formatUptime(health.health.uptimeMs)}
            </Text>
          )}

          {health.error !== null && <Text style={styles.error}>{health.error}</Text>}

          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            onPress={health.refresh}
          >
            <Text style={styles.secondaryButtonLabel}>Check now</Text>
          </Pressable>
        </View>

        <CameraPermissionNotice permission={permission} />

        <View style={styles.destinations}>
          {DESTINATIONS.map((destination) => (
            <Pressable
              key={destination.route}
              accessibilityRole="button"
              style={({ pressed }) => [styles.destination, pressed && styles.pressed]}
              onPress={() => navigation.navigate(destination.route)}
            >
              <Text style={styles.destinationTitle}>{destination.title}</Text>
              <Text style={styles.destinationSubtitle}>{destination.subtitle}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  url: {
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: 15,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  dot: {
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '600',
  },
  meta: {
    color: colors.textMuted,
    fontSize: 13,
  },
  error: {
    color: colors.offline,
    fontSize: 13,
    lineHeight: 18,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondaryButtonLabel: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  destinations: {
    gap: spacing.sm,
  },
  destination: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  destinationTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  destinationSubtitle: {
    color: colors.textMuted,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.7,
  },
});
