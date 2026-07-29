import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { Camera, type CameraPermissionStatus } from 'react-native-vision-camera';

/**
 * The camera permission, as a state a screen can render rather than a promise it has to sequence.
 *
 * Only vision-camera's static permission API is touched here. No camera session is opened and no
 * `<Camera>` is mounted - that is phases 04 and 05 - so this hook is safe to call from any screen,
 * including Home.
 *
 * A denied permission must never be a dead screen - spec, § Gotchas. Once Android has recorded a
 * permanent denial, no dialog can be shown again and the only route back is the system settings
 * page. Two things make that recoverable: `openSettings`, and re-reading the status whenever the
 * app returns to the foreground, so granting it in Settings and swiping back clears the state
 * without a restart.
 */

export interface CameraPermission {
  status: CameraPermissionStatus;
  granted: boolean;
  /**
   * Whether the system dialog can still be shown. When this is `false` and `granted` is also
   * `false`, `openSettings` is the only way forward.
   */
  canAsk: boolean;
  /** Shows the system dialog, then re-reads the status. Safe to call when `canAsk` is false. */
  request: () => Promise<void>;
  /** Opens this app's page in Android's system settings. */
  openSettings: () => Promise<void>;
}

export function useCameraPermission(): CameraPermission {
  const [status, setStatus] = useState<CameraPermissionStatus>(() =>
    Camera.getCameraPermissionStatus(),
  );

  const refresh = useCallback(() => {
    setStatus(Camera.getCameraPermissionStatus());
  }, []);

  const request = useCallback(async () => {
    await Camera.requestCameraPermission();
    // The request resolves with its own result, but the status is re-read rather than derived from
    // it: `not-determined` turning into a permanent `denied` is a transition only the status shows.
    refresh();
  }, [refresh]);

  const openSettings = useCallback(async () => {
    await Linking.openSettings();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refresh();
      }
    });

    return () => subscription.remove();
  }, [refresh]);

  return {
    status,
    granted: status === 'granted',
    // 'restricted' is an iOS parental-controls state and cannot be requested either. It is handled
    // here rather than assumed away, because the type includes it on both platforms.
    canAsk: status === 'not-determined',
    request,
    openSettings,
  };
}
