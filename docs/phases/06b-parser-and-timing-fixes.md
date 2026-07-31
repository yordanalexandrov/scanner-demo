# Phase 06b — Parser and timing corrections

**Status:** in progress · **Depends on:** 06 · **Blocks:** 07 ·
**Source:** defects found in the phase 05/06 dataset collected on 2026-07-30

## Goal

Remove two defects that make the harness misreport its own results — a parser that turns correctly
recognised dates into failures, and a `totalMs` that measures the operator rather than the machine — so
that the numbers phases 07–09 produce are attributable to the engines being compared.

**This phase is inserted before 07 on purpose.** Both defects live in code that all four methods share:
`packages/shared/src/dateParser.ts` is the single parser by design, and `timing.totalMs` is the single
latency figure. Adding three more engines on top of them would multiply the error by four and make every
comparison the project exists to draw unsound. Fixing shared code after the dataset has grown also means
re-running more images.

## Evidence

Collected on an SM-S928B (Android 16) against `scanner.yo-po.eu`, 2026-07-30. The pesto, oil, yoghurt
and snack blocks can be re-read through `GET /api/v1/images/:id/attempts`. The original Nurofen row
`f4f5efb9` was no longer present when implementation began on 2026-07-31, so its exact recorded block
is preserved in this document and in the regression fixture rather than being reconstructed.

| Capture group | Package | Printed | ML Kit read | Recorded result |
|---|---|---|---|---|
| `06dce108` | Pesto Genovese, jar lid | `01/12/2026` | `"L6152 21:05:18\n01/12/2026"` — **correct** | no date |
| `f4f5efb9` | Nurofen carton | `Годен до: 07/2027` | `"62H24\n07/2027"` — correct | **2027-07-24** — wrong |
| `200b516a` | dm rapeseed oil | `16.10.26` | not read at all | no date — genuine OCR failure |
| `30ff8b61` | Verea yoghurt lid | `21.08.2026` | not read at all | no date — genuine OCR failure |
| `99cb7df3` | snack bag | `16.12.2026` | correct | 2026-12-16 — correct |

Two of the four failures in that session belong to the parser, not to ML Kit. The remaining two are
properties of the method — dot-matrix print on foil — and are exactly what phases 07–09 exist to compare
against; they are **not** in this phase's scope.

The same session recorded these totals, on the same capture, with `engineMs` of 93–249 ms:

| Attempt | `totalMs` | Cause |
|---|---|---|
| `06dce108` upload, first run | 7 418 ms | 5 569 ms of it is the operator not yet having pressed a button |
| `06dce108` upload, second run | 70 186 ms | same `startedAt` reused; the phone slept between the two presses |
| `f4f5efb9` upload (gallery) | 39 424 ms | the timer started before the image picker opened |

## Scope

1. **A line break is not a date separator.** `SEP` in `dateParser.ts` is `[./\-\s]`, and `\s` matches
   `\n`. OCR engines join the lines of one block with `\n`, so the tail of a neighbouring token is glued
   onto the date: `"62H24\n07/2027"` parses as `2027-07-24` and `"L6152 21:05:18\n01/12/2026"` as
   `2012-01-18`. Separators become `.`, `/`, `-` and a single space **only** — which is what
   [ADR-16](../decisions.md#adr-16--separators-and-year-widths-are-normalised-before-matching) already
   says in prose. Line breaks, tabs and other whitespace end a candidate.
   — [ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window)

2. **The sanity window filters candidates before the deciding rule, not after.**
   [ADR-6](../decisions.md#adr-6--parser-rule-order-and-referencedate) step 6 applies it last and only to
   the chosen candidate, so one implausible candidate can win `latest-of-pair` and then be discarded,
   taking a perfectly good date with it. On `06dce108` the noise string `8.54` became `2054-08-31`, beat
   the real `2026-12-01`, and was then rejected — result: no date, from an image whose date was read
   correctly. Implausible candidates are removed before any rule runs, and still appear in
   `parse.candidates` with a `rejectedFor` reason so nothing becomes invisible.
   — [ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window)

3. **`totalMs` measures the method, not the operator.** It currently starts at the shutter (or, for a
   gallery import, before the picker even opens) and ends at the parsed result, while the method itself is
   only invoked when a button is pressed. Every camera capture therefore carries 1.5–2.9 s of think time
   inside the figure, a gallery import carries however long the library was browsed, and a second run on
   the same stored capture reuses the first `startedAt` and accumulates everything since. `totalMs` starts
   at the first work attributable to **each independently recorded attempt** and ends at its parsed result.
   The ML Kit button produces an `upload` attempt and then an `original` attempt, so each variant gets a
   fresh start immediately before its own run; the second attempt must not contain the first one's engine
   time. `captureMs`, `downscaleMs` and `uploadMs` stay stored but sit outside `totalMs` as the capture
   cost, shown once for the capture rather than repeated as though every method paid it. Their sum with an
   applicable method's `totalMs` is a useful **machine-path cost**, not literal shutter-to-result elapsed
   time: the operator interval is deliberately absent.
   — [ADR-22](../decisions.md#adr-22--totalms-starts-at-the-method-invocation)

4. **`parserVersion` on every attempt row.** The parser's output is part of the measurement, and this
   phase changes it. Without a recorded version the dataset silently mixes two parsers and no later
   comparison can tell a pre-fix row from a post-fix one. It follows the `pricingVersion` principle — a
   literal in `packages/shared`, bumped when a parsing rule changes, stored on the row, carried into the
   export.
   The migration backfills every existing row with a stable legacy value and new attempts carry the new
   value; neither is nullable. Existing `parseJson` stays byte-for-byte unchanged — assigning its parser
   version is metadata, not re-parsing.
   — [ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) for the pattern,
   [ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window) for why it
   is needed now.

5. **`timingVersion` on every attempt row.** `parserVersion` cannot stand in for an unrelated timing
   protocol. The existing rows mean "`totalMs` starts at the shutter/picker"; new rows mean "`totalMs`
   starts at the attempt". Both need stable, non-null identifiers, with the legacy value backfilled by the
   same migration. Any median of `totalMs` is taken within one `timingVersion`, never across the boundary.
   — [ADR-22](../decisions.md#adr-22--totalms-starts-at-the-method-invocation)

6. **The German anchor phrase as it is actually printed.** `ANCHOR_PHRASES` carries `MHD` for German but
   not `Mindestens haltbar bis`, which is the form on the dm bottle in `200b516a` and the one ML Kit read
   perfectly. Data only: no rule changes, no new locale — German is already one of the four languages
   [ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy) commits to.

7. **Regression fixtures from all five recorded capture groups.** The blocks stay verbatim as ML Kit
   returned them. The pesto and Nurofen fixtures assert the corrected dates, and the snack fixture asserts
   that the already-correct result stays correct. The oil and yoghurt fixtures assert `expiry: null`:
   their printed dates are ground truth, but those digits are absent from ML Kit's text and the shared
   parser must never invent what its engine did not read. A fixture taken from real engine output is the
   only kind that would have caught either parser defect.

8. **Version-aware summaries without changing the visual grouping.** Attempts remain grouped by
   `(method, inputVariant)` as the specification and ADR-2 require, and every individual run remains
   visible. Within that group, summary cohorts are split by `(parserVersion, timingVersion)`. Extraction
   counts never mix parser versions, latency medians never mix timing versions, and the UI labels the
   cohort beside its run count. In particular, a legacy 70-second row and a corrected 200-millisecond row
   must not produce a plausible-looking 35-second median.

9. **A data-preserving migration and an explicit rollout boundary.** The SQLite migration runs against a
   database that already contains attempts, preserves their row count and JSON payloads, and backfills
   both version columns. The server is deployed before the new APK: after the server migration an old
   payload missing either version fails loudly rather than writing an unversioned row, while deploying
   the APK first would let the old non-strict server silently discard its new fields. No benchmark runs
   are recorded between those two deployment steps.

## Out of scope

- **Anything about what ML Kit can and cannot read.** Dot-matrix print on foil and the absence of
  Cyrillic are properties of the method, recorded in the README and in
  [ADR-12](../decisions.md#adr-12--the-self-hosted-engine-defaults-to-chineseenglish-models). Phases
  07–09 measure against them; this phase must not try to compensate for them.
- **New anchor or month-name locales.** The snack bag in `99cb7df3` carries Estonian, Latvian, Lithuanian
  and Hungarian. [ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy) commits to four
  languages deliberately; widening that set is its own decision with its own evidence.
- **Re-parsing or re-timing stored attempt rows.** The dataset is append-only. Old rows keep their old
  parse and timing payloads, and their version fields say which semantics produced them; a corrected
  result comes from a re-run, which phase 06 already supports.
- **Using the full-resolution ML Kit result as a fallback for the upload result.** They remain separate
  attempts. Substituting one for the other would improve only the on-device method and destroy the fair
  comparison with server engines, which all read the upload variant.
- **Accuracy scoring and ground truth.** Phase 10. This phase asserts individual dates in tests, not a
  scoring table.
- **The confidence score's calibration.** The wrong Nurofen date scored 0.95 against the correct one's
  0.85, which is alarming, but it is a consequence of the day-precision signal and disappears with
  scope item 1. Re-weighting the signals is not attempted here.

## Deliverables

```
packages/shared/src/dateParser.ts             # separator class, candidate filtering order
packages/shared/src/dateParser.test.ts        # + the five recorded-block fixtures
packages/shared/src/data/anchors.ts           # + Mindestens haltbar bis
packages/shared/src/parserVersion.ts          # current and legacy parser identifiers
packages/shared/src/timingVersion.ts          # current and legacy timing identifiers
packages/shared/src/schemas/attempt.ts        # + parserVersion, timingVersion
packages/shared/src/attemptGroups.ts          # version-aware summary cohorts
packages/shared/src/attemptGroups.test.ts
packages/shared/src/index.ts                  # exports both version constants
app/src/lib/runMethod.ts                      # per-attempt start, both versions
app/src/lib/capture.ts                        # StoredCapture.startedAt no longer feeds totalMs
app/src/screens/CaptureScreen.tsx             # picker timing, per-run start
app/src/lib/rerun.ts                          # same start rule on the re-run path
app/src/components/LatencyBreakdown.tsx       # capture cost shown outside totalMs
app/src/components/AttemptGroupList.tsx       # labelled, version-separated summaries
app/src/screens/ResultScreen.tsx              # versions visible on individual rows
server/src/routes/attempts.ts                 # round-trips both versions
server/src/db/schema.ts                       # both version columns
server/src/db/migrations.test.ts              # upgrades a populated pre-06b database
server/drizzle/                               # data-preserving version-column migration
docs/decisions.md                             # ADR-21, ADR-22
docs/phases/10-history.md                     # version-aware filters, summaries and export
```

## Key decisions

[ADR-6](../decisions.md#adr-6--parser-rule-order-and-referencedate) ·
[ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) ·
[ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows) ·
[ADR-16](../decisions.md#adr-16--separators-and-year-widths-are-normalised-before-matching) ·
[ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window) ·
[ADR-22](../decisions.md#adr-22--totalms-starts-at-the-method-invocation)

ADR-21 amends ADR-6 step 6 and tightens ADR-16. ADR-22 amends ADR-10's definition of `totalMs`. Both were
accepted by the owner when implementation of this phase was authorised on 2026-07-31.

## Interfaces

```ts
// packages/shared — unchanged signature, changed behaviour
parseExpiryDate(blocks: Block[], opts: { referenceDate: Date }): ParseResult

// Stable values used by the migration, app and summary cohorts
LEGACY_PARSER_VERSION = "parser-v1"
PARSER_VERSION = "parser-v2"
LEGACY_TIMING_VERSION = "shutter-v1"
TIMING_VERSION = "method-v2"

// AttemptCreate gains two fields, both required and inferred from these exact-value schemas
parserVersionSchema = z.enum([LEGACY_PARSER_VERSION, PARSER_VERSION])
timingVersionSchema = z.enum([LEGACY_TIMING_VERSION, TIMING_VERSION])
```

No endpoint paths change. The contract does: `POST /api/v1/attempts` requires both new fields and
`GET /api/v1/images/:id/attempts` returns them. Both columns are `not null`. The migration assigns stable
legacy identifiers to the rows already in production; the app, as the sole author of attempts, supplies
the current identifiers on every new row. The shared schemas accept the declared identifiers rather than
arbitrary strings; a future bump adds its literal to the schema and cannot arrive as an unnoticed typo.

`ParseResult` keeps its shape. A candidate dropped by the sanity window before the deciding rule is still
reported in `candidates` with `rejectedFor` — the string is the existing free-text reason, so no schema
change is needed for it either.

The timing relationships after this phase are:

```text
captureCostMs = sum(applicable capture-side segments)  # outside every method total

fresh ML Kit totalMs ~= engineMs + parseMs + local orchestration
ML Kit re-run totalMs ~= downloadMs + engineMs + parseMs + local orchestration
server method totalMs ~= requestMs + parseMs + local orchestration
```

An inapplicable segment remains `null` on the row and is not rendered as zero; if no capture-side segment
applies, the derived capture cost is `null` too.
`serverTotalMs` and a server engine's `engineMs` are nested inside `requestMs`, not added to it. The
capture cost plus a method total is machine time spent on the path; it excludes the deliberately
unmeasured operator handoff and is not labelled end-to-end latency.

## Acceptance criteria

1. `pnpm -r build && pnpm -r typecheck && pnpm -r test` passes, with the five recorded-block fixtures in
   `dateParser.test.ts`.
2. `[{ text: "62H24\n07/2027" }]` parses to `2027-07-31`, `precision: "month"` — not `2027-07-24`.
3. The `06dce108` `original` block set — `8.54`, `PESTO`, `GENOVE`,
   `"L6152 21:05:18\n01/12/2026"` — parses to `2026-12-01`, `rule: "sole-candidate"`, and `8.54`
   appears in `candidates` with a `rejectedFor` naming the sanity window.
4. The oil fixture keeps `expiry: null`, reports `04-2503` as outside the sanity window, and the yoghurt
   fixture keeps `expiry: null` with no fabricated candidate. The snack fixture remains
   `2026-12-16`.
5. A single space still separates: `05 MAR 2027`, `31 12 2025` and `05MAR27` all still parse, and the
   existing phase 05 parser tests pass unchanged. `multiple-candidates` continues to describe all
   extracted candidates, including implausible ones retained for diagnostics; only the deciding rule is
   restricted to candidates inside the sanity window.
6. `Mindestens haltbar bis` is matched case-insensitively as a German anchor, and a geometry test proves
   that it selects the nearby plausible date rather than an unrelated candidate.
7. Re-running ML Kit from the Library against the stored pesto image and an available Nurofen image
   records new attempts carrying the correct dates and current version identifiers, additively, leaving
   every existing row and its legacy versions untouched. The removed historical Nurofen row
   `f4f5efb9` cannot be recreated as a legacy row; its exact parser failure is covered by criterion 2.
8. Wait at least 30 s after a camera capture before invoking ML Kit, then run both variants. Neither
   attempt's `totalMs` contains the wait, and the `original` attempt does not contain the preceding
   `upload` attempt's engine time. For each, the difference between `totalMs` and its applicable measured
   segments is only the small local orchestration remainder.
9. Browse the gallery for at least 30 s before selecting an image. The picker time is absent from
   `totalMs`; `captureMs` is `null`, while downscale and upload remain in the separate capture cost.
10. On a Library re-run, `totalMs` contains download, local inference and parse exactly once. On every
    path — camera, gallery, re-run — nested server fields are not double-counted and the applicable
    segments account for `totalMs` to within the measured orchestration remainder. The shared capture
    cost is shown once per capture and is absent, not `0 ms`, on a re-run.
   — [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
11. A migration test starts from the pre-06b schema with attempt rows, applies the new migration, and
    proves that the row count, IDs and JSON payloads are unchanged while `parserVersion` and
    `timingVersion` receive the legacy identifiers.
12. A post-migration attempt missing either version is rejected; a current payload round-trips both
    values. Production is deployed server-first, then APK, with no attempt recorded in between.
13. A mixed set of legacy and current attempts remains one visual `(method, inputVariant)` group but
    produces separately labelled summary cohorts. No extraction count spans `parserVersion` and no
    `totalMs` median spans `timingVersion`.
14. `pnpm -r lint` passes; `git grep -n -B 2 'Date\.now()' -- app server packages` returns only the
    documented wall-clock timestamp and filter-bound call sites, each with its eslint-disable rationale.

## Risks / unknowns

- The sanity window becomes a filter rather than a veto, so a genuine date more than 10 years out — rare,
  but sterile medical goods do exist — is now dropped before the rule instead of being surfaced as a
  chosen-then-rejected candidate. It stays in `candidates` with its reason, so the case remains visible in
  the export; it is no longer visible as "the date we would have chosen".
- The 20+ attempt rows already collected were produced by the legacy parser and timing protocol. They
  stay, and the two explicit versions keep them honest. A generated SQLite migration that adds
  `not null` columns without a verified backfill is not acceptable against this database.
- Engine latency naturally varies, so two totals are not required to be numerically equal. The timing
  criteria instead insert a known human delay and prove it is absent, then reconcile each total with its
  own applicable segments.
- Scope item 6 would not have rescued `200b516a`: the printed date was never recognised, and the nearest
  candidate to the anchor would have been the unrelated `04-2503`. The phrase is added because its absence
  is a gap in a language already committed to, not because it fixes that image.

## Review checkpoint

Show: the five fixtures passing; a populated legacy database migrating without losing or rewriting a
row; a re-run of the stored pesto and an available Nurofen image producing current-version attempts with
the correct dates without altering existing rows; Library summaries split into labelled version cohorts;
a delayed camera run and a long gallery browse absent from `totalMs`; each ML Kit variant timed
independently; and the applicable latency segments reconciling on camera, gallery and re-run paths.
