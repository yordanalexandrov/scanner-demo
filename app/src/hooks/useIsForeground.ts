import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Whether the app is the app the user is looking at.
 *
 * A camera session held open behind a locked screen is a session Android may tear down from under
 * the app, and it drains the battery while it lasts. Combining this with screen focus is what makes
 * `isActive` depend on nothing but where the user is - never on a button, which is an explicit
 * acceptance criterion of phase 04.
 */
export function useIsForeground(): boolean {
  const [isForeground, setIsForeground] = useState(() => AppState.currentState === 'active');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setIsForeground(next === 'active');
    });

    return () => subscription.remove();
  }, []);

  return isForeground;
}
