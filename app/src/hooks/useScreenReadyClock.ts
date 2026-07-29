import { useCallback, useMemo, useRef } from 'react';
import { now } from '@scanner-demo/shared';
import type { Millis } from '@scanner-demo/shared';

/**
 * The clock `decodeMs` is measured against.
 *
 * It is armed the moment the camera reports it is *running* - not when the screen mounts and not
 * when navigation settles. Measuring from navigation start would fold the stack's push animation
 * into a camera number, and the point of the phase is a camera number.
 *
 * Every instant here comes from `now()` in the shared package, which is monotonic. The wall clock
 * jumps when NTP corrects it and can run backwards, so a duration derived from it is not a
 * duration - ADR-10.
 *
 * ## Why it re-arms
 *
 * The phase document defines `decodeMs` as `t_callback - t_screenReady` and, in the same breath,
 * asks for ten consecutive scans on one camera session with a median over them. Those two cannot
 * both hold against a single fixed origin: the camera is never restarted between reads, so the
 * second scan would report the first scan's latency plus everything since, the tenth would report
 * the whole session, and the median would describe how long the screen had been open rather than
 * how fast it decodes.
 *
 * So the origin is generalised from *screen*-ready to *scanner*-ready: armed when the session
 * starts, re-armed at the instant each scan is recorded. The first reading of a session is exactly
 * the figure the phase document specifies, camera warm-up included; every later one measures from
 * the previous decode, which means it also contains the time the user spent moving the phone to the
 * next package. That is a property of the metric rather than a defect in it - it is why the first
 * reading of each session is flagged separately on screen, and why the phase's own risk note leaves
 * the question of discarding it to the review.
 *
 * Everything here lives in a ref. A clock that re-rendered the screen on every tick would change
 * the very thing it is timing.
 */

export interface ScreenReadyClock {
  /** Call from the camera's `onStarted`. Arming an already-armed clock restarts it. */
  arm: () => void;
  /** Call from the camera's `onStopped`. A stopped camera has no meaningful origin. */
  disarm: () => void;
  /**
   * Milliseconds from the arm point to `instant`, re-arming the clock at that same instant, or
   * `null` if the camera was not running.
   *
   * `instant` is passed in rather than read here so that the caller can capture it as the very
   * first statement of the scanner callback - a reading taken after a dedupe check has that check
   * inside it. Re-arming at `instant` rather than at "now" leaves no gap between one measurement
   * ending and the next beginning.
   *
   * `null`, never `0`: a decode that arrived with no running session is a measurement that does not
   * exist, and rendering that as zero would drag every median towards it - global constraint.
   */
  consume: (instant: Millis) => Millis | null;
  /** Whether a reading taken now would be the first of this camera session. */
  isFirstReading: () => boolean;
}

export function useScreenReadyClock(): ScreenReadyClock {
  const armedAtRef = useRef<Millis | null>(null);
  const readingsRef = useRef(0);

  const arm = useCallback(() => {
    armedAtRef.current = now();
    readingsRef.current = 0;
  }, []);

  const disarm = useCallback(() => {
    armedAtRef.current = null;
  }, []);

  const consume = useCallback((instant: Millis) => {
    const armedAt = armedAtRef.current;

    if (armedAt === null) {
      return null;
    }

    armedAtRef.current = instant;
    readingsRef.current += 1;

    return instant - armedAt;
  }, []);

  const isFirstReading = useCallback(() => readingsRef.current === 0, []);

  // Memoised so that passing `arm` and `disarm` straight to the camera does not hand it a new
  // callback identity on every render.
  return useMemo(
    () => ({ arm, disarm, consume, isFirstReading }),
    [arm, disarm, consume, isFirstReading],
  );
}
