import { z } from 'zod';

/**
 * Why the parser is as confident as it says it is. Signals are recorded rather than folded away, so
 * a low score can be explained instead of merely reported - the harness never silently guesses.
 */
export const parseSignalSchema = z.enum([
  'anchor-matched',
  'ambiguous-numeric',
  'month-precision-only',
  'no-bbox',
  'engine-confidence-missing',
  'multiple-candidates',
]);

export type ParseSignal = z.infer<typeof parseSignalSchema>;

/** A month-only date resolves to the last day of that month, and says so here - ADR-8. */
export const datePrecisionSchema = z.enum(['day', 'month']);

export type DatePrecision = z.infer<typeof datePrecisionSchema>;

/** An expired date is a successful extraction, not a failure to extract - ADR-7. */
export const expiryStatusSchema = z.enum(['valid', 'expired']);

export type ExpiryStatus = z.infer<typeof expiryStatusSchema>;

/** Which disambiguation rule decided the answer. Stored so a wrong answer can be traced - ADR-4. */
export const parseRuleSchema = z.enum([
  'anchor-proximity',
  'latest-of-pair',
  'sole-candidate',
  'none',
]);

export type ParseRule = z.infer<typeof parseRuleSchema>;

export const parseCandidateSchema = z.object({
  raw: z.string(),
  date: z.string(),
  /** `null` when the candidate was accepted. Otherwise the reason it lost. */
  rejectedFor: z.string().nullable(),
});

export type ParseCandidate = z.infer<typeof parseCandidateSchema>;

export const parseResultSchema = z.object({
  expiry: z
    .object({
      /** ISO `yyyy-mm-dd`. */
      date: z.string(),
      precision: datePrecisionSchema,
      status: expiryStatusSchema,
      raw: z.string(),
    })
    .nullable(),
  productionDate: z.object({ date: z.string(), raw: z.string() }).nullable(),
  rule: parseRuleSchema,
  ambiguous: z.boolean(),
  confidence: z.object({
    score: z.number().min(0).max(1),
    signals: z.array(parseSignalSchema),
  }),
  /** Every candidate the parser saw, including the rejected ones, so the choice is inspectable. */
  candidates: z.array(parseCandidateSchema),
  /** ISO. Stored so a re-run a year later reaches the same verdict on unchanged pixels - ADR-6. */
  referenceDate: z.string(),
});

export type ParseResult = z.infer<typeof parseResultSchema>;
