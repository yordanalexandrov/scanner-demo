/**
 * Month names for the `DD MMM YYYY` format, in the four languages the anchor list commits to -
 * English, Bulgarian, German and French, full and abbreviated - ADR-9.
 *
 * Data only. Case folding and diacritic folding happen in the parser in phase 05; the names are
 * stored as printed. Collisions across languages are harmless because they resolve to the same
 * month number (`MAI` is 5 in German and in French).
 *
 * Adding a language means adding one entry to this table and one to the anchor table.
 */

import type { AnchorLocale } from './anchors.js';

/** The month-name locales are the same set as the anchor locales, and stay that way on purpose. */
export type MonthLocale = AnchorLocale;

/** Exactly twelve, indexed January = 0, so a lookup never needs a length check. */
export type TwelveMonths = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export interface MonthNameTable {
  readonly locale: MonthLocale;
  readonly full: TwelveMonths;
  /** As printed, without a trailing full stop - the parser strips punctuation before matching. */
  readonly abbreviated: TwelveMonths;
}

export const MONTH_NAME_TABLES: readonly MonthNameTable[] = [
  {
    locale: 'en',
    full: [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ],
    abbreviated: [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ],
  },
  {
    locale: 'bg',
    full: [
      'януари',
      'февруари',
      'март',
      'април',
      'май',
      'юни',
      'юли',
      'август',
      'септември',
      'октомври',
      'ноември',
      'декември',
    ],
    abbreviated: [
      'ян',
      'фев',
      'мар',
      'апр',
      'май',
      'юни',
      'юли',
      'авг',
      'сеп',
      'окт',
      'ное',
      'дек',
    ],
  },
  {
    locale: 'de',
    full: [
      'Januar',
      'Februar',
      'März',
      'April',
      'Mai',
      'Juni',
      'Juli',
      'August',
      'September',
      'Oktober',
      'November',
      'Dezember',
    ],
    abbreviated: [
      'Jan',
      'Feb',
      'Mär',
      'Apr',
      'Mai',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Okt',
      'Nov',
      'Dez',
    ],
  },
  {
    locale: 'fr',
    full: [
      'janvier',
      'février',
      'mars',
      'avril',
      'mai',
      'juin',
      'juillet',
      'août',
      'septembre',
      'octobre',
      'novembre',
      'décembre',
    ],
    abbreviated: [
      'janv',
      'févr',
      'mars',
      'avr',
      'mai',
      'juin',
      'juil',
      'août',
      'sept',
      'oct',
      'nov',
      'déc',
    ],
  },
];
