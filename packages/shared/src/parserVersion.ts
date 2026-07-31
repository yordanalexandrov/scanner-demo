import { z } from 'zod';

/**
 * Parser semantics are part of an attempt's result, so the value is stored rather than inferred
 * from its creation time. Existing rows are parser-v1; ADR-21 introduces parser-v2.
 */
export const LEGACY_PARSER_VERSION = 'parser-v1' as const;
export const PARSER_VERSION = 'parser-v2' as const;

export const parserVersionSchema = z.enum([LEGACY_PARSER_VERSION, PARSER_VERSION]);

export type ParserVersion = z.infer<typeof parserVersionSchema>;
