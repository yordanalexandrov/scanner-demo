import { StyleSheet, Text, View } from 'react-native';
import { radius, spacing } from '../theme';

/**
 * The framing guide - spec, § Screens — Expiry date capture.
 *
 * It exists to make captures consistent rather than to look like a viewfinder. Two operators
 * framing the same package the same way is what keeps the dataset comparable; a date shot from
 * across the label and one shot close up are different inputs, and the difference would land in
 * the accuracy column as though it were the engine's doing.
 *
 * Purely decorative in the technical sense: it crops nothing and is not passed to any engine. The
 * whole frame is captured and uploaded.
 */

export interface FramingGuideProps {
  /** Shown under the frame. Kept short - it is read at arm's length, in a shop. */
  hint: string;
}

export function FramingGuide({ hint }: FramingGuideProps) {
  return (
    <View style={styles.container} pointerEvents="none">
      <View style={styles.frame}>
        <View style={[styles.corner, styles.topLeft]} />
        <View style={[styles.corner, styles.topRight]} />
        <View style={[styles.corner, styles.bottomLeft]} />
        <View style={[styles.corner, styles.bottomRight]} />
      </View>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

const CORNER = 28;
const THICKNESS = 3;

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  frame: {
    aspectRatio: 2.4,
    borderRadius: radius.md,
    width: '82%',
  },
  corner: {
    borderColor: '#ffffff',
    height: CORNER,
    position: 'absolute',
    width: CORNER,
  },
  topLeft: {
    borderLeftWidth: THICKNESS,
    borderTopLeftRadius: radius.md,
    borderTopWidth: THICKNESS,
    left: 0,
    top: 0,
  },
  topRight: {
    borderRightWidth: THICKNESS,
    borderTopRightRadius: radius.md,
    borderTopWidth: THICKNESS,
    right: 0,
    top: 0,
  },
  bottomLeft: {
    borderBottomLeftRadius: radius.md,
    borderBottomWidth: THICKNESS,
    borderLeftWidth: THICKNESS,
    bottom: 0,
    left: 0,
  },
  bottomRight: {
    borderBottomRightRadius: radius.md,
    borderBottomWidth: THICKNESS,
    borderRightWidth: THICKNESS,
    bottom: 0,
    right: 0,
  },
  hint: {
    color: '#ffffff',
    fontSize: 13,
    marginTop: spacing.md,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowRadius: 4,
  },
});
