import { z } from 'zod';

/**
 * One prompt, for every image and every provider - phase 09, § Out of scope.
 *
 * No few-shot gallery, no per-image tweaking, no language hint. Every image gets exactly this text,
 * because a prompt tuned per image measures the tuning rather than the model, and a prompt tuned per
 * provider turns the provider column into a prompt column.
 *
 * **The prompt is versioned alongside the model** and stored on every attempt, because a prompt
 * change alters results exactly as a model change does. It is its own field rather than a suffix on
 * the engine string: the engine string is the price-table key, and overloading it would break the
 * cost lookup - phase 09 item 10, ADR-11, ADR-24.
 */

/**
 * Bumped by **any** change to {@link PROMPT} or to {@link MODEL_ANSWER_JSON_SCHEMA}, including one
 * that looks cosmetic.
 *
 * Attempts recorded before and after must be distinguishable in the export without consulting the
 * git history - phase 09 criterion 10 - and a reader of the export has no way to tell a reworded
 * sentence from a reworded rule. The schema counts too: it is half of what the model was asked for.
 *
 * - `prompt-v1` - the original.
 * - `prompt-v2` - says that a two-digit year is a year. Under v1 the model read `24/10/21` off a
 *   dot-matrix stamp and then argued with itself in the reasoning field about whether `21` counted,
 *   answering `null` on two runs and `2021-10-24` on a third **from the same transcription**. That
 *   is the prompt being ambiguous, not the model interpreting: ADR-16 settled the question for the
 *   parser and v1 simply failed to say it here.
 * - `prompt-v3` - stops inviting the model to guess. v2 said "write your best reading of an unclear
 *   character", which is an instruction to fabricate: `gpt-5.6-luna` returned `EXP:` and `MFG:`
 *   where the packaging prints a bare `24/07`, and `gpt-5.6-terra` returned `ÜRETİM SAATİ` for a
 *   lot code. v3 asks for `?` in place of an unreadable character and names label invention
 *   explicitly. All three models already emit `?` unprompted when left to themselves, so this asks
 *   for something they do rather than something they must learn.
 */
export const PROMPT_VERSION = 'prompt-v3';

/**
 * Three conventions in here exist to make the model's answer **comparable with the shared parser's
 * answer on the same raw text**, which is the measurement this whole method exists to produce.
 * Without them the two columns would differ mostly on output format, and the interesting difference
 * - reading versus interpretation - would be buried under it:
 *
 * - a month-only date resolves to the **last day** of that month, which is what ADR-8 makes the
 *   parser do;
 * - a date with no year is **not a date**, which is what ADR-23 makes the parser do;
 * - a **two-digit year is a year**, expanded into the century nearest the present, which is what
 *   ADR-16 makes the parser do;
 * - where a production date and an expiry date are both printed, the **expiry** one is the answer,
 *   which is what the parser's `latest-of-pair` rule does.
 *
 * That is alignment of conventions, not tuning: it does not tell the model what to read or where to
 * look, and every image gets it identically.
 *
 * **What is deliberately left unstated: what to do with a single unlabelled date.** The parser takes
 * it - that is the `sole-candidate` rule - and the model is not told to. The two therefore disagree
 * on packaging that prints one bare stamp, and that disagreement is a measurement rather than a
 * defect: a lone `24/10/21` read in 2026 may well be a production date, and a model that declines it
 * is exercising exactly the judgement this method exists to price against an engine that cannot.
 * Handing the model the parser's rule ladder would delete the interpretation half of item 4 and
 * leave the two columns differing only on reading.
 *
 * The instruction to transcribe *everything* rather than only the date is what makes the raw text
 * worth having. It is the text the shared parser is then run over, on the phone, exactly as it is
 * run over ML Kit's and Vision's - so an accuracy difference is attributable to the reading.
 */
export const PROMPT = `You are reading a photograph of supermarket product packaging for a benchmark.

Return two separate things.

1. Every piece of printed text you can make out in the image, as separate lines, in reading order
   and verbatim. Include text that has nothing to do with dates. Do not correct spelling, do not
   translate, do not reformat dates.
   - Transcribe only characters that are physically printed. Do not add a label such as EXP, MFG,
     BEST BEFORE, LOT or a date prefix unless those exact characters appear on the packaging.
   - If a character is unclear, write ? in its place. Do not guess which character it is and do not
     drop the line: 61?3?F004 is a useful reading and an invented one is not.

2. The expiry date printed on the packaging, following these rules exactly:
   - Use the expiry, best-before or use-by date. If a production or packaging date is also printed,
     it is not the answer.
   - Answer in ISO format, YYYY-MM-DD.
   - If only a month and a year are printed, answer with the LAST day of that month.
   - A two-digit year IS a year. Expand it into the century that puts the date nearest to the
     present: in 24/10/21 the year is 2021, not 1921 and not missing. Do not reject a date because
     its year is printed with two digits, and do not change the date to make it a future one.
   - Only a date with no year component at all - 24/10, or 24/07 - is answered null. A date without
     a year is not a date.
   - If you cannot find an expiry date, answer null. Never guess a plausible date.

Also give at most two short sentences saying which printed text you used and why.`;

/**
 * The JSON Schema the provider hands to the model's structured-output mode.
 *
 * **One field for the text, not two.** The phase asks for the model's own answer and the raw text it
 * read; asking separately for a joined `rawText` and a `lines` array would let one model return two
 * transcriptions that disagree, and there would be no principled way to pick between them. The lines
 * are the transcription: `rawText` is them joined, and the blocks are them split, so the two views
 * of the same reading cannot drift.
 *
 * Written as a literal rather than generated from the zod schema below. A generator would be a third
 * thing to keep correct, and what the model is asked for is part of the prompt version - it should
 * be readable here, in full, next to the sentences it belongs to.
 */
export const MODEL_ANSWER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    textLines: {
      type: 'array',
      items: { type: 'string' },
      description: 'Every printed line, verbatim, in reading order.',
    },
    expiryDate: {
      // Nullable, and it must stay nullable: a model forced to produce a string would produce a
      // date, and a fabricated date is the single worst thing this benchmark could record.
      type: ['string', 'null'],
      description: 'The expiry date as YYYY-MM-DD, or null.',
    },
    reasoning: {
      type: 'string',
      description: 'At most two sentences on which printed text was used.',
    },
  },
  // Both required by OpenAI's strict mode, and both wanted anyway: a response missing a field is a
  // response this adapter would have to invent a value for.
  required: ['textLines', 'expiryDate', 'reasoning'],
  additionalProperties: false,
} as const;

/** `2027-12-31`, and nothing that merely looks like it. Checked for real existence below. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A calendar date, not a well-shaped string.
 *
 * `2027-02-30` matches the pattern and is not a day. `Date.UTC` would happily roll it into March,
 * so the round trip is what actually rejects it: a date the harness cannot verify is a malformed
 * answer, and a malformed answer is a recorded failure rather than a coerced one - item 6.
 */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);

  return (
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value
  );
}

/**
 * What the model returned, parsed rather than trusted - phase 09 item 6.
 *
 * Structured output makes conformance likely, not certain: a refusal, a truncation, or a provider
 * that silently downgrades to free text all produce something else. Everything that does not parse
 * here becomes a recorded failure carrying the raw response, never a best-effort read of prose.
 */
export const modelAnswerSchema = z.object({
  textLines: z.array(z.string()),
  expiryDate: z.string().refine(isRealDate, 'Not a calendar date in YYYY-MM-DD form').nullable(),
  reasoning: z.string(),
});

export type ModelAnswer = z.infer<typeof modelAnswerSchema>;
