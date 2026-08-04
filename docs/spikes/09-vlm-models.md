# Spike — phase 09: which VLM, and which prompt

**2026-08-04.** Three OpenAI models and three versions of the prompt, measured against two datasets.
The question this answers is what `VLM_MODEL` should default to, and it settles it on evidence rather
than on a price list.

**No attempt rows were written.** The app is the sole author of those —
[ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows) — and a script that
posted them would be fabricating benchmark data. Everything below came from a throwaway harness
calling `createVlmEngine` directly; the numbers here are reconnaissance, and the benchmark proper is
what the phone records. The one thing this spike did change under `server/src` is the prompt, and
that change is a deliverable rather than an artefact of the spike — see "The prompt" below.

The production images were read through `GET /api/v1/images/:id` on `scanner.yo-po.eu` and scored
locally. Nothing was deployed to the box and nothing on it was modified.

---

## Verdict

| Question | Answer |
| --- | --- |
| Which model | **`gpt-5.4-mini`**. Same accuracy as `gpt-5.6-luna`, 3.7× faster, and `gpt-5.6-terra`'s only advantage is one image in fifteen at 5.7× the cost |
| Is the expensive model more accurate | **Marginally, and on one category.** 13/15 against 12/15, and the difference is a photograph taken upside down |
| Is the cheap model cheaper in practice | `luna` is $0.00178/image against `mini`'s $0.00278 — but at 8.0 s against 2.2 s, and with a habit of inventing labels |
| Does the VLM beat the other three methods | **On interpretation, yes. On reading, not reliably.** See findings 1 and 2 |
| Is a prompt change worth a version bump | **Yes, and both bumps changed results.** `prompt-v3` lowered the headline numbers and improved the measurement |

---

## The datasets

**A — local, 16 images.** Two or three distinct packages: one carton with a dot-matrix stamp reading
`24/10/27`, photographed three times as six upload/original rows, and pharmacy boxes. The models
report two different printed dates for the boxes (`Годен до: 07/2027` with lot `62H24`, and
`Годен до: 03/2026` with lot `49C23`) consistently across every model and run, which suggests two
boxes rather than one; the operator recalls two packages in total. **The ambiguity is left standing
rather than resolved by assumption** — it does not affect the conclusion, because the stamp is where
every model's score is decided and its ground truth is certain.

**B — production, 15 distinct products, upload variants only.** The newest 15 capture groups on
`hez.yo-po.eu`, photographed in one session. Ground truth was supplied by the operator per package.
Nine of the fifteen already carried attempts from ML Kit and the sidecar, three of those from Cloud
Vision as well, which cross-checks the ground truth independently.

Dataset A is the weaker measurement and is reported because it motivated B: with three packages
across sixteen images, 30 of 48 runs distinguished nothing between models.

---

## Results — dataset B, `prompt-v3`, 15 products × 3 runs

| | `gpt-5.4-mini` | `gpt-5.6-luna` | `gpt-5.6-terra` |
| --- | --- | --- | --- |
| Correct on all three runs | 12/15 | 12/15 | **13/15** |
| Correct on some runs | 1 | 1 | 0 |
| Never correct | 2 | 2 | 2 |
| Median `engineMs` | **2157** | 7999 | 9212 |
| Output tokens per call | **108** | 1089 | 642 |
| Cost per image | $0.00278 | **$0.00178** | $0.01585 |
| Cost of the 45 calls | $0.1253 | $0.0800 | $0.7134 |

Both failures are shared by all three models: `ff4b108c` (a stamp on a curved bottle cap) and
`b944db35` (out of focus). No model reads either.

## Results — dataset A, `prompt-v3`, 16 images × 3 runs

| | `gpt-5.4-mini` | `gpt-5.6-luna` | `gpt-5.6-terra` |
| --- | --- | --- | --- |
| Overall | 31/48 | 33/47 | **39/48** |
| Printed label (30 runs) | 30/30 | 29/30 | 30/30 |
| Dot-matrix stamp (18 runs) | 1/18 | 4/18 | **9/18** |

The stamp is the whole story: every model is perfect on a printed pharmacy label and none of them
reads a dot-matrix stamp reliably. `luna`'s one failure on a printed label was an HTTP 503, recorded
as a failure rather than retried away.

---

## Findings

**1. The self-hosted sidecar beats every VLM on the rotated stamp, for free.** `deb27c57` is the
package from [ADR-23](../decisions.md#adr-23--a-date-with-no-year-is-not-a-date): `30.06.25` printed
upside down. The sidecar reads it correctly (2025-06-30) because its pipeline includes a text-angle
classifier; ML Kit reads `30.09` and reports 2026-09-30. Of the VLMs only `terra` matches the sidecar,
3/3, at $0.016 an image. **This is the finding the whole harness exists to produce**: on the category
where the on-device method fails, the cheapest server method already wins, and the most expensive one
merely ties it.

**2. The VLM wins where two dates are printed.** `52b85b76` carries `PRO/P 03.10.2025` and
`EXP/BB 03.10.2027`. All three models answered 2027-10-03 correctly. The sidecar recorded 2025-10-03 —
the production date — and ML Kit 2025-10-31. This is interpretation rather than reading, and it is the
first clean advantage of the VLM path in either dataset. `2278f109` is the same shape of case and all
three models again chose the expiry date.

**3. A controlled pair isolates focus from capability.** `fee401aa` and `b944db35` are the same
product, one photograph sharp and one blurred. All three models read the sharp one correctly
(2028-10-14) and all three fail the blurred one. The only variable is focus. This is the most useful
pair in either dataset and worth keeping deliberately.

**4. `prompt-v3` holds on an unreadable image.** `c5961068` is blurred past legibility. All three
models returned `null` on all three runs. Under `prompt-v2` `gpt-5.4-mini` fabricated dates in this
situation; the "never guess" rule now holds.

**5. Model/parser agreement measures self-consistency, not accuracy.** Before ground truth existed,
`terra` scored 48/48 on "the model's answer equals the shared parser's answer over the same raw text"
on dataset A. Its actual accuracy on that dataset is 9/18 on the stamp. A model that guesses a
character produces a clean string, the parser accepts it, the two columns agree, and a fabricated
reading is recorded as a success. **The agreement column is a diagnostic, never a score.**

---

## The prompt

Three versions, each bumped because a prompt change alters results exactly as a model change does.

| Version | Change | Effect |
| --- | --- | --- |
| `prompt-v1` | The original | Model argued with itself about whether a two-digit year counted; answered `null` on two runs and `2021-10-24` on a third **from the same transcription** |
| `prompt-v2` | Says a two-digit year is a year, expanded into the century nearest the present — what [ADR-16](../decisions.md#adr-16--separators-and-year-widths-are-normalised-before-matching) already makes the parser do | Agreement on the ambiguous image went from 1/3 to 4/4; the self-argument disappeared |
| `prompt-v3` | Replaces "write your best reading of an unclear character" with "write `?`"; names label invention explicitly | Headline numbers **fell** for two of three models, and the measurement improved |

`prompt-v2` was fixing an omission: the prompt did not say what ADR-16 says, and the model filled the
gap by reasoning aloud.

`prompt-v3` was fixing an instruction that invited fabrication. `gpt-5.6-luna` had been returning
`EXP:`, `MFG:` and `EXPIRY:` where the packaging prints a bare `24/07`, and `gpt-5.6-terra` returned
`ÜRETİM SAATİ` for a lot code. All three models emit `?` unprompted when left to themselves, so v3
asks for something they already do. **The numbers got worse because v2 was inflating them**: a guessed
character yields a clean string that the parser accepts, and marking uncertainty exposes it.

Three conventions in the prompt are aligned with the parser deliberately — last-day-of-month
([ADR-8](../decisions.md#adr-8--month-only-dates-resolve-to-the-last-day-with-a-precision-field)),
no-year-is-not-a-date ([ADR-23](../decisions.md#adr-23--a-date-with-no-year-is-not-a-date)),
two-digit-year expansion (ADR-16) — so the two columns differ on judgement rather than on output
format. **One convention is deliberately not aligned**: the parser's `sole-candidate` rule takes a
single unlabelled date and the model is not told to. A lone `24/10/21` read in 2026 may well be a
production date, and a model that declines it is exercising the judgement this method exists to
price. Handing it the parser's rule ladder would delete the interpretation half of the comparison.

---

## Why three models are in the price table

[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) says one entry per
model actually used. All three were used, here, and their prices were read from
`https://developers.openai.com/api/docs/pricing` on 2026-08-03. The entries stay so that anyone
re-reading this document can recompute its cost figures, and so that switching `VLM_MODEL` to one of
the two rejected models does not silently produce attempts with an unknown cost.

A model with no entry records `costEstimateUsd: null` — an honest "not priced", never a number
borrowed from a different model.

---

## What this does not measure

- **Original variants.** Only upload variants were run on dataset B. Dataset A hints at nothing:
  `terra` did better on uploads (6/9 against 3/9 on the stamp) and `luna` better on originals (3/9
  against 1/9). Whether resolution helps or hurts deserves its own measurement at a fixed model.
- **`reasoning.effort`.** Not sent, so each model's own default applies. If a provider moves that
  default, these numbers become harder to interpret — the same exposure the model pin exists to close,
  left open because the parameter is provider-specific and the interface is meant to be portable.
- **Latency on the deployment box.** Inference happens at the provider, so the box's two shared cores
  do not slow it — but `requestMs` from a handset over mobile data is not what a laptop on a wired
  connection measured here.
- **Repeat count.** Three runs per image. A median of three is noisy by definition; the run counts are
  quoted everywhere above for that reason.
- **Anything about accuracy at scale.** Fifteen products is a reconnaissance sample, not a benchmark.
  The benchmark is what the phone records.
