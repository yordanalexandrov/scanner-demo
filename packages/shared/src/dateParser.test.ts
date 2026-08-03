import { describe, expect, it } from 'vitest';
import { parseExpiryDate } from './dateParser.js';
import type { Block } from './schemas/ocr.js';
import { parseResultSchema } from './schemas/parse.js';

/**
 * The acceptance table of phase 05, plus the cases the ADRs argue about.
 *
 * Every case pins `referenceDate`, which is the whole point of it being an input: these assertions
 * have to still hold in 2030 - ADR-6. A test that passes because of today's date would be testing
 * the calendar.
 */

const REFERENCE = new Date(Date.UTC(2025, 5, 1));

/** Blocks with no geometry - the common case, and the one that forces the positional-free rules. */
function textBlocks(...texts: string[]): Block[] {
  return texts.map((text) => ({ text, bbox: null, confidence: null }));
}

function parse(text: string) {
  return parseExpiryDate(textBlocks(text), { referenceDate: REFERENCE });
}

describe('date parser - the phase 05 acceptance table', () => {
  it.each([
    ['EXP 12.03.2027', '2027-03-12', 'day', 'valid'],
    ['BEST BEFORE 05 MAR 2027', '2027-03-05', 'day', 'valid'],
    ['MHD 31.12.25', '2025-12-31', 'day', 'valid'],
    ['MHD 31/12/2025', '2025-12-31', 'day', 'valid'],
    ['DLC 01/03/27', '2027-03-01', 'day', 'valid'],
    ['Годен до 03/2027', '2027-03-31', 'month', 'valid'],
    ['EXP 03/27', '2027-03-31', 'month', 'valid'],
    // `EXP 25/03` and `EXP 05/12` used to sit here, reading 2026-03-25 and 2025-12-05. **Both were
    // removed from the table on 2026-08-03, deliberately departing from the specification** - a
    // year-less run now yields no date at all, and the two cases have their own tests below.
    // ADR-23 records the measurement that settled it.
    ['311225', '2025-12-31', 'day', 'valid'],
    ['EXP 01.06.2024', '2024-06-01', 'day', 'expired'],
  ])('%s → %s', (text, date, precision, status) => {
    const result = parse(text);
    expect(result.expiry).not.toBeNull();
    expect(result.expiry?.date).toBe(date);
    expect(result.expiry?.precision).toBe(precision);
    expect(result.expiry?.status).toBe(status);
  });

  it('reads the same date whatever the separator and year width - ADR-16', () => {
    // The two rows of the table that exist only to be compared with each other.
    expect(parse('MHD 31.12.25').expiry?.date).toBe(parse('MHD 31/12/2025').expiry?.date);
    expect(parse('EXP 12-03-2027').expiry?.date).toBe(parse('EXP 12.03.2027').expiry?.date);
  });

  it('treats three components as DD/MM/YY without ambiguity - ADR-6', () => {
    // `MM/DD/YY` is deliberately not a recognised order, which is what settles this one.
    const result = parse('DLC 01/03/27');
    expect(result.ambiguous).toBe(false);
    expect(result.confidence.signals).not.toContain('ambiguous-numeric');
  });

  it('resolves a two-component date as month and year, by position', () => {
    // Second component out of month range → it is the year.
    expect(parse('EXP 03/27').expiry?.date).toBe('2027-03-31');
    // A two-digit year is still a year that was *read*. Only the century is supplied - ADR-16.
    expect(parse('EXP 03/2027').expiry?.date).toBe('2027-03-31');
  });

  it('refuses a date with no year rather than supplying one - ADR-23', () => {
    // `25/03` can only be the 25th of March, and the package does not say of which year. The old
    // reading named the next occurrence, which produced a confident, fully-specified date whose
    // year appeared nowhere on the packaging.
    const result = parse('EXP 25/03');

    expect(result.expiry).toBeNull();
    expect(result.rule).toBe('none');
    expect(result.candidates).toEqual([]);
  });

  it('refuses a two-component date whose month reading fails the sanity window', () => {
    // `05/12` reads as May 2012 - the only reading left once a year-less one is not a date. It is
    // outside the sanity window, so it is rejected *visibly*: recorded as a candidate with a
    // reason, never silently dropped.
    const result = parse('EXP 05/12');

    expect(result.expiry).toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.date).toBe('2012-05-31');
    expect(result.candidates[0]?.rejectedFor).not.toBeNull();
  });

  it('does not invent a year for a dot-matrix date read without one - ADR-23', () => {
    // Observed on 2026-08-03, on a real package, and the reason this rule exists. The stamp reads
    // `30.06.25` upside down; ML Kit read the rotated `6` as a `9` and dropped the year, giving
    // `30.09`. The parser then supplied 2026 and reported `2026-09-30` as a `day`-precision,
    // `valid` date - a year that is on no packaging anywhere, on a product that expired in 2025.
    const result = parse('NUTTY ALMOND NO SUGARS 000 AR400307:20 30.09, L LNUT');

    expect(result.expiry).toBeNull();

    // The engine that read the same stamp correctly is unaffected.
    expect(parse('NUTTY ALMOND NO SUGARS LNUT 000.10 8A400307:20 30.06.25').expiry?.date).toBe(
      '2025-06-30',
    );
  });

  it('reports the production date rather than discarding it - ADR-6', () => {
    const result = parse('L4471 15.01.2024 20.01.2026');
    expect(result.rule).toBe('latest-of-pair');
    expect(result.expiry?.date).toBe('2026-01-20');
    expect(result.productionDate?.date).toBe('2024-01-15');
    // The lot code must not become a date of its own.
    expect(result.candidates).toHaveLength(2);
  });

  it('returns an expired date rather than nothing - ADR-7', () => {
    const result = parse('EXP 01.06.2024');
    expect(result.expiry?.status).toBe('expired');
    expect(result.expiry?.date).toBe('2024-06-01');
  });

  it('discards an implausible date but leaves it visible in candidates', () => {
    const result = parse('EXP 01.06.2045');
    expect(result.expiry).toBeNull();
    expect(result.rule).toBe('none');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.date).toBe('2045-06-01');
    expect(result.candidates[0]?.rejectedFor).toMatch(/10 years/);
  });

  it('fails explicitly on text with no date', () => {
    const result = parse('NET WT 500g · Lot ABC · Store in a cool dry place');
    expect(result.expiry).toBeNull();
    expect(result.rule).toBe('none');
    expect(result.candidates).toEqual([]);
  });

  it('resolves a month-only date to the last day of the month - ADR-8', () => {
    expect(parse('Годен до 02/2028').expiry?.date).toBe('2028-02-29');
    expect(parse('Годен до 03/2027').expiry?.precision).toBe('month');
    expect(parse('Годен до 03/2027').confidence.signals).toContain('month-precision-only');
  });

  it('reads month names in all four committed languages - ADR-9', () => {
    for (const text of [
      'BEST BEFORE 05 MAR 2027',
      'MHD 05 März 2027',
      'DLC 05 mars 2027',
      'Годен до 05 март 2027',
    ]) {
      expect(parse(text).expiry?.date).toBe('2027-03-05');
    }
    // Diacritics must not be required to match.
    expect(parse('MHD 05 Marz 2027').expiry?.date).toBe('2027-03-05');
  });
});

describe('date parser - rules and geometry', () => {
  /** A box as `[x, y, width, height]` in pixels of the processed image - ADR-5. */
  function block(text: string, bbox: Block['bbox']): Block {
    return { text, bbox, confidence: null };
  }

  it('lets a nearby anchor decide between two candidates - criterion 9', () => {
    const result = parseExpiryDate(
      [
        block('15.01.2024', [10, 400, 120, 30]),
        block('EXP', [10, 100, 40, 30]),
        block('20.01.2026', [60, 100, 120, 30]),
      ],
      { referenceDate: REFERENCE },
    );

    expect(result.rule).toBe('anchor-proximity');
    expect(result.expiry?.date).toBe('2026-01-20');
    expect(result.confidence.signals).toContain('anchor-matched');
  });

  it('picks the same text apart without any boxes at all - criterion 9', () => {
    const result = parseExpiryDate(textBlocks('15.01.2024', 'EXP', '20.01.2026'), {
      referenceDate: REFERENCE,
    });

    // No geometry means the anchor cannot be used positionally, so the fallback rule decides - and
    // says so, which is the point of recording the rule at all - ADR-4.
    expect(result.rule).toBe('latest-of-pair');
    expect(result.expiry?.date).toBe('2026-01-20');
    expect(result.confidence.signals).toContain('no-bbox');
  });

  it('ignores an anchor that is too far from any candidate to mean anything', () => {
    const result = parseExpiryDate(
      [
        block('EXP', [10, 10, 40, 30]),
        block('15.01.2024', [10, 2000, 120, 30]),
        block('20.01.2026', [10, 2400, 120, 30]),
      ],
      { referenceDate: REFERENCE },
    );

    expect(result.rule).toBe('latest-of-pair');
  });

  it('records that the engine reported no confidence rather than assuming it was certain - ADR-5', () => {
    expect(parse('EXP 12.03.2027').confidence.signals).toContain('engine-confidence-missing');

    const withConfidence = parseExpiryDate(
      [{ text: 'EXP 12.03.2027', bbox: null, confidence: 0.9 }],
      {
        referenceDate: REFERENCE,
      },
    );
    expect(withConfidence.confidence.signals).not.toContain('engine-confidence-missing');
  });

  it('is a pure function of its inputs, so a re-run reaches the same verdict - ADR-6', () => {
    const blocks = textBlocks('EXP 01.06.2024');
    const first = parseExpiryDate(blocks, { referenceDate: REFERENCE });
    const later = parseExpiryDate(blocks, { referenceDate: new Date(Date.UTC(2030, 0, 1)) });

    expect(first.expiry?.status).toBe('expired');
    expect(first.referenceDate).toBe('2025-06-01');
    // The same pixels under a later reference date are still expired, and the stored reference
    // makes which one was used inspectable rather than implicit.
    expect(later.referenceDate).toBe('2030-01-01');
  });

  it('always returns a value that satisfies the shared schema', () => {
    for (const text of ['EXP 12.03.2027', 'nothing here', 'EXP 01.06.2045', '311225']) {
      expect(parseResultSchema.safeParse(parse(text)).success).toBe(true);
    }
  });
});

const RECORDED_REFERENCE = new Date(Date.UTC(2026, 6, 30));

const PESTO_BLOCKS: Block[] = [
  { text: '8.54', bbox: [38, 1055, 363, 374], confidence: null },
  { text: 'PESTO', bbox: [268, 1409, 579, 433], confidence: null },
  { text: 'GENOVE', bbox: [458, 1658, 378, 275], confidence: null },
  {
    text: 'L6152 21:05:18\n01/12/2026',
    bbox: [1339, 1214, 717, 858],
    confidence: null,
  },
];

const OIL_BLOCKS: Block[] = [
  { text: 'DE-OKO- 003\nFU-Landwirtschaft', bbox: [346, 146, 611, 249], confidence: null },
  { text: 'Hergestellt in Deutschland', bbox: [475, 331, 846, 178], confidence: null },
  { text: 'Rapssaat aus der EU', bbox: [362, 495, 523, 137], confidence: null },
  { text: 'VEGAN', bbox: [987, -8, 407, 102], confidence: null },
  {
    text: 'di-drogerie markt GmbH + Co. KG\nAm dm-Platz 1, DE-76227 Karlsruhe\nWWw.dm.de',
    bbox: [358, 565, 953, 333],
    confidence: null,
  },
  { text: 'Vertrieb in Österreich:', bbox: [381, 866, 557, 129], confidence: null },
  {
    text: 'dm drogerie markt, AT-S5071 Wals\nww.dm.at',
    bbox: [378, 923, 882, 238],
    confidence: null,
  },
  {
    text: 'Trocken, vor Wärme und\nLicht geschützt lagern.\nMindestens haltbar bis:',
    bbox: [392, 1166, 634, 296],
    confidence: null,
  },
  { text: '329004', bbox: [406, 1627, 75, 219], confidence: null },
  { text: 'GL', bbox: [1414, 705, 78, 49], confidence: null },
  { text: '90', bbox: [1435, 882, 67, 78], confidence: null },
  { text: 'C/ALU', bbox: [1366, 1036, 188, 54], confidence: null },
  { text: '0,5le', bbox: [1104, 1232, 464, 225], confidence: null },
  { text: '4 l0664447876383', bbox: [460, 2683, 1031, 106], confidence: null },
  { text: '04-2503', bbox: [1506, 1554, 85, 268], confidence: null },
];

const YOGHURT_BLOCKS: Block[] = [
  { text: 'a9-z nu', bbox: [-36, 527, 466, 620], confidence: null },
  { text: 'KUceNO MAAKO', bbox: [992, 1241, 1362, 185], confidence: null },
  { text: 'Bepe', bbox: [731, 1400, 1490, 540], confidence: null },
  { text: 'ofPo,', bbox: [1252, 2231, 637, 169], confidence: null },
  { text: '2,9%', bbox: [1340, 2530, 590, 343], confidence: null },
  { text: 'Ogpd', bbox: [1204, 2974, 441, 233], confidence: null },
  { text: 'TBe', bbox: [1745, 2759, 258, 296], confidence: null },
  { text: 'Buk gamama.', bbox: [2422, 340, 506, 594], confidence: null },
];

const SNACK_BLOCKS: Block[] = [
  { text: 'Rost', bbox: [-2, -2, 103, 79], confidence: null },
  { text: '1504', bbox: [4, 2080, 318, 120], confidence: null },
  { text: '2349', bbox: [1432, 59, 162, 107], confidence: null },
  { text: '0,03g', bbox: [1428, 171, 168, 114], confidence: null },
  {
    text: 'Netokoqus: /Neto daudzums:\nGynasis kiekis/Netó tömeg/\nHerHO KOMVWYeCTBO:',
    bbox: [730, 364, 809, 395],
    confidence: null,
  },
  { text: '16.12.2026', bbox: [862, 1571, 774, 141], confidence: null },
  { text: '00:22', bbox: [1009, 1955, 371, 107], confidence: null },
  { text: 'WSABUPIAW', bbox: [1830, 24, 328, 145], confidence: null },
  {
    text: 'Parim enne:/Parti r/leteicams lidz/Geriausias ili\nPartijos Nr:/lLaikyi vésioje ir sausoje vietoje,/Bontta\ncsomagolásban, száraz, húvôs helyen tárolva mintsigét vo:\n(hap hónap/év-/HeorsopeN Hai- ao6sp ao,/laprnga:',
    bbox: [732, 862, 1529, 550],
    confidence: null,
  },
  { text: 'LDPEJPP', bbox: [2046, 303, 247, 120], confidence: null },
  { text: '100 ge', bbox: [1731, 558, 665, 342], confidence: null },
  { text: 'LPK100BGMU26006', bbox: [880, 1761, 1450, 135], confidence: null },
  { text: 'A6', bbox: [1786, 1953, 192, 113], confidence: null },
];

describe('date parser - phase 06b recorded-block regressions', () => {
  it('does not let a newline glue the Nurofen lot suffix onto its month-only date', () => {
    const result = parseExpiryDate(textBlocks('62H24\n07/2027'), {
      referenceDate: RECORDED_REFERENCE,
    });

    expect(result.expiry).toMatchObject({
      date: '2027-07-31',
      precision: 'month',
      raw: '07/2027',
    });
  });

  it('chooses the recognised pesto date after filtering implausible OCR noise', () => {
    const result = parseExpiryDate(PESTO_BLOCKS, { referenceDate: RECORDED_REFERENCE });

    expect(result.expiry?.date).toBe('2026-12-01');
    expect(result.rule).toBe('sole-candidate');
    expect(result.candidates).toEqual([
      {
        raw: '8.54',
        date: '2054-08-31',
        rejectedFor: 'more than 10 years from the reference date',
      },
      { raw: '01/12/2026', date: '2026-12-01', rejectedFor: null },
    ]);
    // The signal describes everything extracted for diagnostics, even though only one candidate
    // was eligible to decide - ADR-21.
    expect(result.confidence.signals).toContain('multiple-candidates');
  });

  it('does not invent the oil date that ML Kit failed to recognise', () => {
    const result = parseExpiryDate(OIL_BLOCKS, { referenceDate: RECORDED_REFERENCE });

    expect(result.expiry).toBeNull();
    expect(result.candidates).toEqual([
      {
        raw: '04-2503',
        date: '2503-04-30',
        rejectedFor: 'more than 10 years from the reference date',
      },
    ]);
  });

  it('does not invent the yoghurt date when the recorded text has no candidate', () => {
    const result = parseExpiryDate(YOGHURT_BLOCKS, { referenceDate: RECORDED_REFERENCE });

    expect(result.expiry).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('keeps the already-correct snack result stable', () => {
    const result = parseExpiryDate(SNACK_BLOCKS, { referenceDate: RECORDED_REFERENCE });

    expect(result.expiry?.date).toBe('2026-12-16');
    expect(result.rule).toBe('sole-candidate');
  });

  it('keeps a literal space and no separator, while tabs and newlines end a candidate', () => {
    for (const value of ['05 MAR 2027', '31 12 2025', '05MAR27']) {
      expect(parse(value).expiry).not.toBeNull();
    }

    for (const value of ['62H24\n07/2027', '62H24\t07/2027']) {
      const result = parseExpiryDate(textBlocks(value), { referenceDate: RECORDED_REFERENCE });
      expect(result.expiry?.date).toBe('2027-07-31');
      expect(result.expiry?.raw).toBe('07/2027');
    }
  });

  it('uses the full German anchor phrase case-insensitively with geometry', () => {
    const result = parseExpiryDate(
      [
        { text: '15.01.2026', bbox: [10, 500, 120, 30], confidence: null },
        { text: 'MINDESTENS HALTBAR BIS', bbox: [10, 100, 250, 30], confidence: null },
        { text: '16.10.2026', bbox: [250, 100, 120, 30], confidence: null },
      ],
      { referenceDate: RECORDED_REFERENCE },
    );

    expect(result.rule).toBe('anchor-proximity');
    expect(result.expiry?.date).toBe('2026-10-16');
  });
});
