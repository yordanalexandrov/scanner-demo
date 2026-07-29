import { Platform } from 'react-native';

/**
 * The handset a measurement was taken on, as one string.
 *
 * Every recorded scan carries it, because decode latency is a property of the phone as much as of
 * the packaging - ADR-1. Without it, two runs on different handsets average into a number that
 * describes neither.
 *
 * Read from React Native's own platform constants rather than from a separate device-info package:
 * the two fields needed here are already there, and a native module added for a label is a native
 * module the dev build has to be rebuilt for.
 */
export function describeDevice(): string {
  if (Platform.OS === 'android') {
    const { Model, Release } = Platform.constants;
    return `${Model} (Android ${Release})`;
  }

  // Android is the only target - spec, § Stack - App. This branch exists so that adding a second
  // platform later is a matter of filling it in rather than of finding where the assumption was
  // baked in.
  return `${Platform.OS} ${String(Platform.Version)}`;
}
