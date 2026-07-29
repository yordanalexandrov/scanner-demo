import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { HealthResponse } from '@scanner-demo/shared';
import { ApiError } from '../api/client';
import { HEALTH_POLL_INTERVAL_MS, fetchHealth } from '../api/health';

/**
 * Polls the server's health endpoint and reports whether it is reachable right now.
 *
 * The next poll is scheduled only after the previous one settles, rather than on a fixed interval.
 * An interval would keep firing while a request hangs, and the answers would arrive out of order -
 * which is precisely the case the indicator has to get right.
 */

export type ServerHealthStatus = 'checking' | 'online' | 'offline';

export interface ServerHealth {
  status: ServerHealthStatus;
  /** The last successful response, or `null` if there has not been one yet - never a zeroed stand-in. */
  health: HealthResponse | null;
  /** Why the last check failed, or `null` while the server is reachable. */
  error: string | null;
  /** Forces a check now, without waiting out the interval. */
  refresh: () => void;
}

export function useServerHealth(): ServerHealth {
  const [status, setStatus] = useState<ServerHealthStatus>('checking');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A counter rather than a boolean: bumping it both cancels the in-flight check and starts a new
  // one, so a manual refresh cannot race the scheduled poll it replaces.
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  // Survives the effect being torn down and rebuilt by a refresh, which `status` alone could not
  // tell us: after a manual refresh the status is still whatever the last poll left behind.
  const hasAnsweredRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const scheduleNext = () => {
      if (!cancelled) {
        timer = setTimeout(check, HEALTH_POLL_INTERVAL_MS);
      }
    };

    async function check(): Promise<void> {
      // Only the checks before the first answer show "checking". Flipping back to it on every poll
      // would make a healthy server blink, and a reviewer could not tell that apart from a
      // genuinely flapping one.
      if (!hasAnsweredRef.current) {
        setStatus('checking');
      }

      try {
        const response = await fetchHealth({ signal: controller.signal });

        if (cancelled) {
          return;
        }

        hasAnsweredRef.current = true;
        setHealth(response);
        setError(null);
        setStatus('online');
      } catch (failure: unknown) {
        if (cancelled) {
          return;
        }

        hasAnsweredRef.current = true;
        setError(
          failure instanceof ApiError || failure instanceof Error
            ? failure.message
            : 'Health check failed',
        );
        setStatus('offline');
      } finally {
        scheduleNext();
      }
    }

    void check();

    // Android suspends timers for a backgrounded app, so the first thing the user sees on returning
    // could otherwise be a stale indicator. Re-checking on foreground is what makes criterion 2
    // hold "without an app restart".
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        refresh();
      }
    });

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
      subscription.remove();
    };
  }, [generation, refresh]);

  return { status, health, error, refresh };
}
