/**
 * Anchor phrases that mark an expiry date on packaging.
 *
 * Data only. Matching - case folding, diacritic folding, proximity to a candidate's bbox - belongs
 * to the parser in phase 05. This table is the single place a language gets added.
 *
 * The four languages here are the same four the month-name table covers, deliberately: recognising
 * `MHD` but not `MARZ` would show up as a fake accuracy difference between packages - ADR-9.
 *
 * ML Kit Text Recognition v2 does not read Cyrillic, so the `bg` entries can never match on the
 * on-device path. That is a property of the method, recorded in the README, not a defect here.
 */

export type AnchorLocale = 'en' | 'bg' | 'de' | 'fr';

export interface AnchorPhrase {
  /** As printed. Compared case-insensitively by the parser. */
  readonly phrase: string;
  readonly locale: AnchorLocale;
}

export const ANCHOR_PHRASES: readonly AnchorPhrase[] = [
  { phrase: 'EXP', locale: 'en' },
  { phrase: 'EXP.', locale: 'en' },
  { phrase: 'BB', locale: 'en' },
  { phrase: 'BBE', locale: 'en' },
  { phrase: 'BEST BEFORE', locale: 'en' },
  { phrase: 'USE BY', locale: 'en' },
  { phrase: 'MHD', locale: 'de' },
  { phrase: 'Mindestens haltbar bis', locale: 'de' },
  { phrase: 'DLC', locale: 'fr' },
  { phrase: 'Годен до', locale: 'bg' },
  { phrase: 'Срок на годност', locale: 'bg' },
  { phrase: 'Използвай преди', locale: 'bg' },
];
