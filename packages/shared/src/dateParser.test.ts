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
    ['EXP 25/03', '2026-03-25', 'day', 'valid'],
    ['EXP 05/12', '2025-12-05', 'day', 'valid'],
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

  it('resolves two-component dates by position, not by "either number over 12"', () => {
    // Second component out of month range → it is the year.
    expect(parse('EXP 03/27').expiry?.date).toBe('2027-03-31');
    // First component out of month range → it is the day, and the year is the next occurrence.
    expect(parse('EXP 25/03').expiry?.date).toBe('2026-03-25');
  });

  it('flags a genuinely ambiguous two-component date and lowers its score', () => {
    // Both components are plausible months. The `MM/YY` reading is May 2012, which the sanity
    // window rejects, so the `DD/MM` reading wins - but the guess is recorded either way.
    const result = parse('EXP 05/12');
    expect(result.expiry?.date).toBe('2025-12-05');
    expect(result.ambiguous).toBe(true);
    expect(result.confidence.signals).toContain('ambiguous-numeric');
    expect(result.confidence.score).toBeLessThan(parse('EXP 12.03.2027').confidence.score);
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
