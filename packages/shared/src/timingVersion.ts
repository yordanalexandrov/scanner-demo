import { z } from 'zod';

/**
 * `totalMs` needs its own version because its start point is independent of parser semantics.
 * Existing rows start at the shutter or picker; ADR-22 starts each new row at method invocation.
 */
export const LEGACY_TIMING_VERSION = 'shutter-v1' as const;
export const TIMING_VERSION = 'method-v2' as const;

export const timingVersionSchema = z.enum([LEGACY_TIMING_VERSION, TIMING_VERSION]);

export type TimingVersion = z.infer<typeof timingVersionSchema>;
