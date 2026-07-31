/**
 * The one expiry-date parser. Both the app and the server import it from here, and no phase may add
 * a second one - a parsing difference between two methods would be indistinguishable from an OCR
 * difference, which is the one confound this harness exists to avoid.
 *
 * It is a pure function of `blocks` and `referenceDate`. Nothing here reads the wall clock: a re-run
 * a year from now has to reach the same verdict on pixels that did not change, or the Library's
 * re-run workflow is measuring the calendar - ADR-6.
 *
 * The rules, in the order they are applied:
 *
 * 1. Extract every date-shaped candidate from every block, keeping its raw substring and its box.
 * 1b. Mark candidates outside the sanity window and exclude them from the deciding rules.
 * 2. `anchor-proximity` - an anchor phrase and a candidate that both have boxes, close enough.
 * 3. `latest-of-pair` - two or more candidates, no usable anchor: the later is the expiry and the
 *    earlier is the production date, which is reported rather than discarded.
 * 4. `sole-candidate` - exactly one.
 * 5. Numeric ambiguity in two-component dates, resolved positionally - ADR-6.
 *
 * A merely expired candidate remains eligible. The window rejects OCR noise, not old food - ADR-7,
 * ADR-21.
 */

import { ANCHOR_PHRASES } from './data/anchors.js';
import { MONTH_NAME_TABLES } from './data/months.js';
import type { Block } from './schemas/ocr.js';
import type {
  DatePrecision,
  ParseCandidate,
  ParseResult,
  ParseRule,
  ParseSignal,
} from './schemas/parse.js';

export interface ParseOptions {
  /**
   * What "in the past" is measured against. Defaults to the image's `capturedAt` at the call site,
   * never to `new Date()` here - a default that reads the clock would make this function impure and
   * every re-run non-reproducible - ADR-6.
   */
  referenceDate: Date;
}

/**
 * Dates further than this from `referenceDate`, in either direction, are treated as OCR noise rather
 * than as dates - ADR-6. Note the symmetry: a date merely in the past is *not* discarded, it is
 * reported with `status: "expired"` - ADR-7.
 */
const SANITY_WINDOW_YEARS = 10;

/**
 * How close an anchor has to be to a candidate before it is allowed to decide, expressed as a
 * multiple of the taller of the two boxes rather than in pixels. A pixel threshold would mean
 * something different on every image variant and every engine; a multiple of the text height is the
 * same distance to a reader at any resolution.
 */
const MAX_ANCHOR_DISTANCE_IN_TEXT_HEIGHTS = 6;

/**
 * Deductions from a starting score of 1. Deliberately blunt: the signals are the record, and the
 * score exists so that a list can be sorted. Anything more elaborate would imply a calibration that
 * has not been done - ADR-6.
 */
const SIGNAL_PENALTIES: Record<ParseSignal, number> = {
  'anchor-matched': 0,
  'ambiguous-numeric': 0.25,
  'month-precision-only': 0.1,
  'no-bbox': 0.1,
  'engine-confidence-missing': 0.05,
  'multiple-candidates': 0.1,
};

interface Candidate {
  /** The exact substring that matched, for `ParseCandidate.raw`. */
  raw: string;
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31, or `null` for a month-only date, which resolves to the last day - ADR-8. */
  day: number | null;
  precision: DatePrecision;
  bbox: Block['bbox'];
  /** Set when rule 5 had to guess between `DD/MM` and `MM/YY` - ADR-6. */
  ambiguous: boolean;
}

// ---------------------------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------------------------

/**
 * Case- and diacritic-folded, for matching only. Never used for anything that gets stored: the raw
 * substring a candidate came from is kept verbatim so a wrong answer can be traced to what was
 * actually printed.
 *
 * `ß` is handled explicitly because NFD does not decompose it, and German is one of the four
 * languages the anchor and month tables commit to - ADR-9.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').toLowerCase();
}

/**
 * `.`, `/`, `-` and a single space are equivalent separators, and a year is two or four digits in
 * any pattern that has one - ADR-16. Both live in the patterns below as character classes rather
 * than being rewritten into the text, so the raw substring stays exactly as printed.
 */
const SEP = '[./\\- ]';

// ---------------------------------------------------------------------------------------------
// Month names
// ---------------------------------------------------------------------------------------------

/** Folded month name → 1-12. Built once; collisions across languages agree by construction - ADR-9. */
const MONTH_BY_NAME: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const table of MONTH_NAME_TABLES) {
    table.full.forEach((name, index) => map.set(fold(name), index + 1));
    table.abbreviated.forEach((name, index) => map.set(fold(name), index + 1));
  }
  return map;
})();

/**
 * Every month name in both the form it is printed in and its folded form, so that `März` and `MARZ`
 * are both matched by the same pattern. Folding the *text* before matching instead would be shorter
 * but wrong: NFD changes the string's length, and the raw substring reported on every candidate has
 * to be the one that was actually printed.
 *
 * Longest first, so `mars` is not consumed as `mar` and left with a stray `s`.
 */
const MONTH_NAME_ALTERNATION = [
  ...new Set(
    MONTH_NAME_TABLES.flatMap((table) =>
      [...table.full, ...table.abbreviated].flatMap((name) => [name, fold(name)]),
    ),
  ),
]
  .sort((a, b) => b.length - a.length)
  .join('|');

// ---------------------------------------------------------------------------------------------
// Calendar helpers - all UTC, so a device time zone never shifts a printed date by a day
// ---------------------------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toUtcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isValidDayMonth(day: number, month: number, year: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function yearsBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (365.2425 * 24 * 60 * 60 * 1000);
}

function withinSanityWindow(date: Date, referenceDate: Date): boolean {
  return yearsBetween(date, referenceDate) <= SANITY_WINDOW_YEARS;
}

/**
 * A two-digit year resolves into whichever century places it inside the sanity window - ADR-16.
 * When neither does, it still resolves to the 2000s so that the candidate exists and can be
 * rejected visibly, with a reason, rather than vanishing before it is ever recorded.
 */
function resolveTwoDigitYear(shortYear: number, referenceDate: Date): number {
  for (const century of [2000, 1900, 2100]) {
    if (withinSanityWindow(toUtcDate(century + shortYear, 1, 1), referenceDate)) {
      return century + shortYear;
    }
  }
  return 2000 + shortYear;
}

function resolveYear(raw: string, referenceDate: Date): number {
  const value = Number(raw);
  return raw.length <= 2 ? resolveTwoDigitYear(value, referenceDate) : value;
}

/**
 * A `DD/MM` with no year names the next such day at or after `referenceDate` - the reading of "the
 * year is implied" that does not put an expiry date in the past on the day it was printed.
 */
function nextOccurrence(day: number, month: number, referenceDate: Date): number {
  const year = referenceDate.getUTCFullYear();
  if (!isValidDayMonth(day, month, year)) {
    return year + 1;
  }
  return toUtcDate(year, month, day).getTime() >= referenceDate.getTime() ? year : year + 1;
}

// ---------------------------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------------------------

/**
 * The patterns, in the order they are tried at each position.
 *
 * Order is load-bearing rather than cosmetic. The four-digit-year-first form has to be attempted
 * before the generic three-component one, or `2027-03-12` matches from its third character as
 * `27-03-12`. Three components have to be attempted before two, or `12.03.2027` is read as `12.03`
 * and the year is left behind as litter.
 */
type PatternHandler = (
  match: RegExpExecArray,
  referenceDate: Date,
) => Omit<Candidate, 'raw' | 'bbox'> | null;

interface Pattern {
  regex: RegExp;
  handle: PatternHandler;
}

const PATTERNS: readonly Pattern[] = [
  {
    // YYYY-MM-DD
    regex: new RegExp(`^(\\d{4})${SEP}(\\d{1,2})${SEP}(\\d{1,2})`),
    handle: ([, y, m, d]) => {
      const year = Number(y);
      const month = Number(m);
      const day = Number(d);
      return isValidDayMonth(day, month, year)
        ? { year, month, day, precision: 'day', ambiguous: false }
        : null;
    },
  },
  {
    // DD MMM YYYY - the one format with a month name. The separator is optional so that `05MAR27`
    // and `05 MAR 2027` are the same date, per the separator rule of ADR-16.
    regex: new RegExp(`^(\\d{1,2})${SEP}*(${MONTH_NAME_ALTERNATION})\\.?${SEP}*(\\d{2,4})`, 'i'),
    handle: ([, d, name, y], referenceDate) => {
      const month = MONTH_BY_NAME.get(fold(name ?? ''));
      if (month === undefined) {
        return null;
      }
      const year = resolveYear(y ?? '', referenceDate);
      const day = Number(d);
      return isValidDayMonth(day, month, year)
        ? { year, month, day, precision: 'day', ambiguous: false }
        : null;
    },
  },
  {
    // DD MM YYYY. Three components are never ambiguous: `MM DD YYYY` is deliberately absent from the
    // recognised orders, which is what makes `01/03/27` unambiguously the first of March - ADR-16.
    regex: new RegExp(`^(\\d{1,2})${SEP}(\\d{1,2})${SEP}(\\d{2,4})`),
    handle: ([, d, m, y], referenceDate) => {
      const year = resolveYear(y ?? '', referenceDate);
      const month = Number(m);
      const day = Number(d);
      return isValidDayMonth(day, month, year)
        ? { year, month, day, precision: 'day', ambiguous: false }
        : null;
    },
  },
  {
    // Two components - `MM/YYYY`, `MM/YY` or a year-less `DD/MM`. Resolved positionally by rule 5.
    regex: new RegExp(`^(\\d{1,2})${SEP}(\\d{2,4})`),
    handle: ([, first, second], referenceDate) =>
      twoComponent(first ?? '', second ?? '', referenceDate),
  },
  {
    // DDMMYY, which has no separator to normalise and so stays its own pattern - ADR-16.
    regex: /^(\d{2})(\d{2})(\d{2})(?!\d)/,
    handle: ([, d, m, y], referenceDate) => {
      const year = resolveTwoDigitYear(Number(y), referenceDate);
      const month = Number(m);
      const day = Number(d);
      return isValidDayMonth(day, month, year)
        ? { year, month, day, precision: 'day', ambiguous: false }
        : null;
    },
  },
];

/**
 * Rule 5 of ADR-6, applied positionally.
 *
 * The specification's own wording - "if either number exceeds 12 it is the day" - gets the common
 * case backwards: in `03/25` the `25` is a year. Which position the out-of-range number sits in is
 * what decides.
 */
function twoComponent(
  first: string,
  second: string,
  referenceDate: Date,
): Omit<Candidate, 'raw' | 'bbox'> | null {
  const a = Number(first);
  const b = Number(second);

  // A four-digit second component can only be a year, whatever its value.
  if (second.length === 4) {
    return a >= 1 && a <= 12
      ? { year: b, month: a, day: null, precision: 'month', ambiguous: false }
      : null;
  }

  const asMonthYear =
    a >= 1 && a <= 12
      ? {
          year: resolveTwoDigitYear(b, referenceDate),
          month: a,
          day: null,
          precision: 'month' as const,
        }
      : null;

  const asDayMonth =
    b >= 1 && b <= 12 && a >= 1 && a <= 31
      ? {
          year: nextOccurrence(a, b, referenceDate),
          month: b,
          day: a,
          precision: 'day' as const,
        }
      : null;

  // First component out of month range: it cannot be a month, so this is `DD/MM`.
  if (a > 12) {
    return asDayMonth === null ? null : { ...asDayMonth, ambiguous: false };
  }

  // Second component out of month range: it cannot be a month either, so this is `MM/YY`.
  if (b > 12) {
    return asMonthYear === null ? null : { ...asMonthYear, ambiguous: false };
  }

  // Both plausible as a month. Prefer whichever reading lands inside the sanity window; when both
  // do, `MM/YY` wins because it is the format the specification actually lists.
  const monthYearSane =
    asMonthYear !== null &&
    withinSanityWindow(toUtcDate(asMonthYear.year, asMonthYear.month, 1), referenceDate);
  const dayMonthSane =
    asDayMonth !== null &&
    withinSanityWindow(toUtcDate(asDayMonth.year, asDayMonth.month, asDayMonth.day), referenceDate);

  if (monthYearSane && asMonthYear !== null) {
    return { ...asMonthYear, ambiguous: true };
  }
  if (dayMonthSane && asDayMonth !== null) {
    return { ...asDayMonth, ambiguous: true };
  }
  if (asMonthYear !== null) {
    return { ...asMonthYear, ambiguous: true };
  }
  return asDayMonth === null ? null : { ...asDayMonth, ambiguous: true };
}

/**
 * Walks the text once, trying every pattern at each position and advancing past whatever matched.
 *
 * A failed match advances by a single character rather than skipping the token, which is what lets
 * `L4471 15.01.2024` find the real date: the scanner tries `71 15.01`, rejects it because 71 is not
 * a day, and carries on rather than giving up on the rest of the string.
 */
function extractFrom(text: string, bbox: Block['bbox'], referenceDate: Date): Candidate[] {
  const found: Candidate[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (!/\d/.test(text[index] ?? '')) {
      continue;
    }

    // A run of digits that a previous candidate already consumed part of must not be re-entered
    // from its middle; only positions at the start of a digit run are considered.
    if (index > 0 && /\d/.test(text[index - 1] ?? '')) {
      continue;
    }

    const rest = text.slice(index);

    for (const pattern of PATTERNS) {
      const match = pattern.regex.exec(rest);
      if (match === null) {
        continue;
      }

      const parsed = pattern.handle(match, referenceDate);
      if (parsed === null) {
        continue;
      }

      found.push({ ...parsed, raw: match[0], bbox });
      index += match[0].length - 1;
      break;
    }
  }

  return found;
}

// ---------------------------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------------------------

interface Anchor {
  bbox: Block['bbox'];
}

function findAnchors(blocks: readonly Block[]): Anchor[] {
  const anchors: Anchor[] = [];

  for (const block of blocks) {
    const folded = fold(block.text);
    const matched = ANCHOR_PHRASES.some(({ phrase }) => folded.includes(fold(phrase)));
    if (matched) {
      anchors.push({ bbox: block.bbox });
    }
  }

  return anchors;
}

type Box = NonNullable<Block['bbox']>;

function centre(box: Box): { x: number; y: number } {
  return { x: box[0] + box[2] / 2, y: box[1] + box[3] / 2 };
}

function distance(a: Box, b: Box): number {
  const from = centre(a);
  const to = centre(b);
  return Math.hypot(from.x - to.x, from.y - to.y);
}

// ---------------------------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------------------------

function toIso(candidate: Candidate): string {
  const day = candidate.day ?? daysInMonth(candidate.year, candidate.month);
  return toIsoDate(toUtcDate(candidate.year, candidate.month, day));
}

function toDate(candidate: Candidate): Date {
  const day = candidate.day ?? daysInMonth(candidate.year, candidate.month);
  return toUtcDate(candidate.year, candidate.month, day);
}

function score(signals: readonly ParseSignal[]): number {
  const deducted = signals.reduce((total, signal) => total - SIGNAL_PENALTIES[signal], 1);
  return Math.max(0, Math.min(1, Number(deducted.toFixed(4))));
}

export function parseExpiryDate(blocks: readonly Block[], opts: ParseOptions): ParseResult {
  const { referenceDate } = opts;
  const referenceIso = toIsoDate(referenceDate);

  const candidates = blocks.flatMap((block) => extractFrom(block.text, block.bbox, referenceDate));
  const eligibleCandidates = candidates.filter((candidate) =>
    withinSanityWindow(toDate(candidate), referenceDate),
  );

  const signals: ParseSignal[] = [];

  // A missing confidence is "no signal", never a number - substituting 1.0 would make the
  // on-device path look maximally certain about everything it ever emitted - ADR-5.
  if (blocks.length > 0 && blocks.every((block) => block.confidence === null)) {
    signals.push('engine-confidence-missing');
  }

  if (candidates.length === 0) {
    return {
      expiry: null,
      productionDate: null,
      rule: 'none',
      ambiguous: false,
      confidence: { score: 0, signals },
      candidates: [],
      referenceDate: referenceIso,
    };
  }

  if (candidates.length > 1) {
    signals.push('multiple-candidates');
  }

  const rejectedFor = (
    candidate: Candidate,
    chosen: Candidate | undefined,
    production: Candidate | null,
  ): string | null => {
    if (!withinSanityWindow(toDate(candidate), referenceDate)) {
      return `more than ${SANITY_WINDOW_YEARS} years from the reference date`;
    }
    if (candidate === chosen) {
      return null;
    }
    if (candidate === production) {
      return 'earlier of a pair, treated as the production date';
    }
    return 'not selected by the deciding rule';
  };

  const reportCandidates = (
    chosen: Candidate | undefined,
    production: Candidate | null,
  ): ParseCandidate[] =>
    candidates.map((candidate) => ({
      raw: candidate.raw,
      date: toIso(candidate),
      rejectedFor: rejectedFor(candidate, chosen, production),
    }));

  if (eligibleCandidates.length === 0) {
    return {
      expiry: null,
      productionDate: null,
      rule: 'none',
      ambiguous: candidates.some((candidate) => candidate.ambiguous),
      confidence: { score: 0, signals },
      candidates: reportCandidates(undefined, null),
      referenceDate: referenceIso,
    };
  }

  const anchors = findAnchors(blocks);

  let rule: ParseRule;
  let chosen: Candidate | undefined;
  let production: Candidate | null = null;

  const anchorBoxes = anchors
    .map((anchor) => anchor.bbox)
    .filter((box): box is Box => box !== null);
  const boxed = eligibleCandidates.filter(
    (candidate): candidate is Candidate & { bbox: Box } => candidate.bbox !== null,
  );

  const nearest =
    anchorBoxes.length > 0 && boxed.length > 0
      ? boxed
          .map((candidate) => {
            const best = Math.min(...anchorBoxes.map((anchor) => distance(anchor, candidate.bbox)));
            const limit =
              MAX_ANCHOR_DISTANCE_IN_TEXT_HEIGHTS *
              Math.max(candidate.bbox[3], ...anchorBoxes.map((anchor) => anchor[3]));
            return { candidate, best, limit };
          })
          .filter((entry) => entry.best <= entry.limit)
          .sort((a, b) => a.best - b.best)[0]
      : undefined;

  if (nearest !== undefined) {
    rule = 'anchor-proximity';
    chosen = nearest.candidate;
    signals.push('anchor-matched');
  } else if (eligibleCandidates.length > 1) {
    // The later date is the expiry and the earlier is the production date, which is reported rather
    // than thrown away - ADR-6.
    const ordered = [...eligibleCandidates].sort(
      (a, b) => toDate(a).getTime() - toDate(b).getTime(),
    );
    rule = 'latest-of-pair';
    chosen = ordered[ordered.length - 1];
    production = ordered[0] ?? null;
  } else {
    rule = 'sole-candidate';
    chosen = eligibleCandidates[0];
  }

  if (chosen === undefined) {
    return {
      expiry: null,
      productionDate: null,
      rule: 'none',
      ambiguous: false,
      confidence: { score: 0, signals },
      candidates: [],
      referenceDate: referenceIso,
    };
  }

  if (chosen.bbox === null) {
    signals.push('no-bbox');
  }
  if (chosen.precision === 'month') {
    signals.push('month-precision-only');
  }
  if (chosen.ambiguous) {
    signals.push('ambiguous-numeric');
  }

  const chosenDate = toDate(chosen);

  return {
    expiry: {
      date: toIso(chosen),
      precision: chosen.precision,
      // Strictly before the reference date, so a product expiring today is still valid today.
      status: chosenDate.getTime() < referenceDate.getTime() ? 'expired' : 'valid',
      raw: chosen.raw,
    },
    productionDate: production === null ? null : { date: toIso(production), raw: production.raw },
    rule,
    ambiguous: chosen.ambiguous,
    confidence: { score: score(signals), signals },
    candidates: reportCandidates(chosen, production),
    referenceDate: referenceIso,
  };
}
