import { useMemo } from 'react';
import { useCameraDevices } from 'react-native-vision-camera';
import type { CameraDevice } from 'react-native-vision-camera';

/**
 * The back cameras, ordered by how close they can focus.
 *
 * `useCameraDevice('back')` returns whichever device vision-camera scores highest, which on a
 * multi-lens handset is the main wide camera. That camera cannot focus on a date held a few
 * centimetres away - and a date held a few centimetres away is precisely the hard case this screen
 * exists for. On most Android handsets it is the ultra-wide that doubles as the macro lens, with a
 * minimum focus distance several times shorter.
 *
 * So the choice is made on the one property that matters here rather than on a general-purpose
 * score, and it is offered as a list rather than decided silently: the screen shows which lens is
 * in use and its minimum focus distance, and lets it be cycled. An automatic choice that turns out
 * wrong for a particular package must be recoverable without a rebuild.
 *
 * `minFocusDistance` is in centimetres, and `0` means the device did not report it - which is not
 * "focuses at zero centimetres". Unknown values sort last rather than first.
 */
export function useCaptureDevices(): CameraDevice[] {
  const devices = useCameraDevices();

  return useMemo(
    () =>
      devices
        .filter((device) => device.position === 'back')
        .sort((a, b) => rank(a.minFocusDistance) - rank(b.minFocusDistance)),
    [devices],
  );
}

function rank(minFocusDistance: number): number {
  return minFocusDistance > 0 ? minFocusDistance : Number.POSITIVE_INFINITY;
}

/** How the lens is named on screen. Physical types are more meaningful here than the device ID. */
export function describeLens(device: CameraDevice): string {
  const lenses = device.physicalDevices
    .map((physical) => physical.replace('-camera', '').replace('-angle', ''))
    .join('+');

  return device.minFocusDistance > 0
    ? `${lenses} · ${device.minFocusDistance}cm`
    : `${lenses} · min focus unknown`;
}
