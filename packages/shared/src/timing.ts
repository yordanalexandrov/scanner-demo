/**
 * Monotonic timing, used by both the app and the server so neither side reaches for the wall clock.
 *
 * The system wall clock jumps when NTP corrects it and can run backwards, which makes any duration
 * derived from it untrustworthy. It is fine for timestamps that only ever get ordered - those live
 * in `capturedAt`, `createdAt`, `scannedAt` - and never for durations - ADR-10. The ESLint rule at
 * the repository root names the exact API and rejects it.
 *
 * A duration is only meaningful against the clock that produced it. `totalMs` is measured entirely
 * on the phone from one method invocation; capture cost is separate under ADR-22. `engineMs` and
 * `serverTotalMs` are measured entirely on the server. Nothing from one clock is ever subtracted
 * from the other - ADR-10.
 */

export type ClockSource = 'hrtime' | 'performance';

/** Milliseconds, as a float. Sub-millisecond precision is kept; rounding is the caller's decision. */
export type Millis = number;

const hasHrtime =
  typeof process !== 'undefined' &&
  typeof process.hrtime === 'function' &&
  typeof process.hrtime.bigint === 'function';

/**
 * Node's `hrtime` counts nanoseconds from an arbitrary origin that can be large enough to lose
 * integer precision once converted to a double. Anchoring at module load keeps the numbers small
 * and the subtraction exact.
 */
const HRTIME_ORIGIN = hasHrtime ? process.hrtime.bigint() : 0n;

const NS_PER_MS = 1_000_000;

/** Which clock this runtime is using. Worth logging once when a measurement looks surprising. */
export function clockSource(): ClockSource {
  return hasHrtime ? 'hrtime' : 'performance';
}

/**
 * A monotonic timestamp in milliseconds. Meaningful only as a difference against another `now()`
 * from the same process - the origin is arbitrary.
 */
export function now(): Millis {
  if (hasHrtime) {
    return Number(process.hrtime.bigint() - HRTIME_ORIGIN) / NS_PER_MS;
  }
  return performance.now();
}

/** Milliseconds since `start`, which must have come from `now()` in this process. */
export function elapsed(start: Millis): Millis {
  return now() - start;
}

/**
 * Starts a timer and returns the function that stops it.
 *
 * ```ts
 * const done = startTimer();
 * const blocks = await recognise(image);
 * const engineMs = done();
 * ```
 */
export function startTimer(): () => Millis {
  const start = now();
  return () => elapsed(start);
}

/** Runs `fn` and reports how long it took, so a segment cannot be timed and then forgotten. */
export function measure<T>(fn: () => T): { value: T; ms: Millis } {
  const start = now();
  const value = fn();
  return { value, ms: elapsed(start) };
}

/** Async counterpart of {@link measure}. The timer stops when the promise settles. */
export async function measureAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: Millis }> {
  const start = now();
  const value = await fn();
  return { value, ms: elapsed(start) };
}
