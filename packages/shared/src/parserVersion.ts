import { z } from 'zod';

/**
 * Parser semantics are part of an attempt's result, so the value is stored rather than inferred
 * from its creation time.
 *
 * - `parser-v1` - the original rules.
 * - `parser-v2` - ADR-21: candidate boundaries, and the sanity window filtering before the rule.
 * - `parser-v3` - ADR-23: a date with no year is not a date. The year-less `DD/MM` reading is gone,
 *   so results that used to carry a manufactured year now carry none at all.
 *
 * **Every past version stays in the enum.** Rows recorded under older semantics keep saying so, and
 * an accuracy figure is a statement about an engine *and* a parser together - citing one without
 * the other is the confound this field exists to prevent.
 */
export const LEGACY_PARSER_VERSION = 'parser-v1' as const;
export const PARSER_VERSION = 'parser-v3' as const;

export const parserVersionSchema = z.enum([LEGACY_PARSER_VERSION, 'parser-v2', PARSER_VERSION]);

export type ParserVersion = z.infer<typeof parserVersionSchema>;
