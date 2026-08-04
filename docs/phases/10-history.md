# Phase 10 — History and JSON export

**Status:** awaiting review · **Depends on:** 05, 06, 06b, 07, 08, 09 · **Source:** spec milestone 10

## Goal

The screen that is the actual deliverable of the POC: every attempt, grouped by source image, so the same
photo processed by all four methods can be read side by side — and exported as JSON so the numbers can be
analysed outside the app.

## Scope

1. All attempts, **grouped by source image**, four methods side by side per image.
   — *spec § Screens — History*
2. Filter by method. — *spec § Screens — History*
3. Filter by `source` (camera/gallery) and by `inputVariant` — named distinctly from the Library's image
   `variant` filter, because they mean different things and one wrong filter on this screen would quietly
   corrupt the headline numbers — so controlled captures and gallery imports
   never land in the same average silently, and the on-device `original` and `upload` runs stay separated.
   — *spec § Screens — Expiry date capture*,
   [ADR-2](../decisions.md#adr-2--the-on-device-path-runs-against-both-image-variants)
4. Filter by `parserVersion` and `timingVersion`. With either filter unset and multiple versions present,
   summaries split into labelled version cohorts rather than combining incompatible extraction or latency
   semantics. — [ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window),
   [ADR-22](../decisions.md#adr-22--totalms-starts-at-the-method-invocation)
5. Per-method summary across the filtered set: run count, median latency, extraction rate, total estimated
   cost. Medians rather than means, and the run count always shown next to them.
   — [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
6. **Export everything as JSON.** — *spec § Screens — History*
7. `GET /api/v1/attempts` — the filterable list backing the screen. — *spec § Server API*

## Out of scope

- Ground-truth entry and automatic accuracy scoring. The export exists so accuracy can be computed
  outside the app against a hand-made key; building a labelling UI is a separate piece of work and is not
  in the specification.
- Charts. The export is the analysis surface; the screen is for reading, not plotting.
- Editing or deleting attempts. The dataset stays append-only.

## Deliverables

```
app/src/screens/HistoryScreen.tsx        # replaces the phase 03 placeholder
app/src/components/
├── ImageAttemptRow.tsx                  # one image, four methods across
├── MethodSummary.tsx                    # count, median, extraction rate, cost
└── HistoryFilters.tsx
app/src/lib/exportJson.ts
server/src/routes/attempts.ts            # + GET /api/v1/attempts with filters
README.md                                # + how to read the numbers, and the caveats that apply
```

## Key decisions

[ADR-1](../decisions.md#adr-1--barcode-measurements-are-persisted-server-side) ·
[ADR-2](../decisions.md#adr-2--the-on-device-path-runs-against-both-image-variants) ·
[ADR-7](../decisions.md#adr-7--expired-dates-are-flagged-not-discarded) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) ·
[ADR-18](../decisions.md#adr-18--the-benchmark-shares-the-box-with-production) ·
[ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window) ·
[ADR-22](../decisions.md#adr-22--totalms-starts-at-the-method-invocation)

## Interfaces

```
GET /api/v1/attempts?limit&cursor&method&source&inputVariant&parserVersion&timingVersion&from&to
  → { items: Attempt[], nextCursor: string | null }
```

Export shape — self-describing, so a file found in six months is still readable:

```jsonc
{
  "exportedAt": "2026-08-01T12:00:00.000Z",
  "schemaVersion": "1",
  "pricingVersions": ["2026-07-27"],       // every version present in the data
  "parserVersions": ["parser-v1", "parser-v2"],
  "timingVersions": ["shutter-v1", "method-v2"],
  "filters": {
    "method": null,
    "source": null,
    "inputVariant": null,
    "parserVersion": null,
    "timingVersion": null
  },
  "images": [ /* ImageRecord[] */ ],
  "attempts": [ /* Attempt[] — full rows, including ocr.rawText and parse.candidates */ ],
  "barcodeScans": [ /* BarcodeScan[] — ADR-1 */ ]
}
```

The export carries **full rows, not a summary**: raw OCR text, every candidate the parser considered and
why it was rejected, `engineMsScope`, `referenceDate`, `pricingVersion`, `parserVersion` and
`timingVersion`. A summary can be recomputed from the rows; the rows cannot be recovered from a summary.

## Acceptance criteria

1. History shows images with their attempts grouped, four methods legible side by side on one row.
2. Filtering by method or either semantic version narrows both the rows and the summary figures
   consistently. With version filters unset, legacy and current rows produce separate labelled cohorts.
3. Camera and gallery images are never combined in a capture-latency figure — filtering by `source` is
   required before any capture-latency summary is shown, and the UI says so rather than silently
   averaging.
4. On-device `original` and `upload` attempts are shown as separate methods in the summary, never merged.
5. Extraction rate counts `status: "expired"` as a success, per
   [ADR-7](../decisions.md#adr-7--expired-dates-are-flagged-not-discarded).
6. Export produces a file that parses as JSON and validates against the shared schemas — verify by
   re-validating the export with `zod` in a script.
7. Round trip: exporting, then computing the median latency per method and `timingVersion` from the export
   in a throwaway script, reproduces the figures shown on screen exactly.
8. The export contains raw OCR text verbatim for every attempt, and `pricingVersion`, `parserVersion`,
   `timingVersion` and `engineMsScope` on every row.
9. Barcode scans appear in the export's own array and are absent from `attempts`.
10. The README's "how to read these numbers" section states the caveats that actually apply: GCV and VLM
    `engineMs` include network, gallery imports have no capture latency, medians below ~5 runs are not
    distributions, cold-start figures are reported separately, and **the server figures come from a
    two-core box shared with a live application** — which slightly flatters the cloud engines relative to
    the self-hosted one.
    — [ADR-18](../decisions.md#adr-18--the-benchmark-shares-the-box-with-production)

## Verified on device

SM-S928B (Android 16), release build, 2026-08-04, against `scanner.yo-po.eu` carrying the phase 07–09
dataset: **79 attempts over 18 images, all four methods, three `parserVersion`s and both
`timingVersion`s.**

| Criterion | Evidence |
|---|---|
| 1 | Rows per source image with thumbnail, `source`, dimensions and the `(method, inputVariant)` cells across. The richest row has **7 columns over 12 attempts**. |
| 2 | `source=camera` narrowed 79 → 77 runs and 18 → 17 images, on the rows and in the summary together; the server answers 77 and 2 for the two values, so the split is exact. `mlkit · upload` splits into three labelled cohorts — `parser-v1 · shutter-v1` at **4158.4 ms**, `parser-v2 · method-v2` at 488.3 ms, `parser-v3 · method-v2` at 541.1 ms. One median over all three would be true of none. |
| 3 | With `source` unset every group prints "No capture figure: filter Source to Camera or Gallery first" instead of a number. With it set to Camera, `mlkit · upload` reports **1666.7 ms over 6 capture(s)** — deduplicated by image, because a capture is paid once and read by every method. Groups whose runs are all Library re-runs report `n/a · 0 capture(s)`, never `0 ms`. |
| 4 | `mlkit · upload` (24 runs) and `mlkit · original` (13) are separate rows, as are `gcv · upload`/`gcv · original` and `onnx-paddleocr · upload`/`onnx-paddleocr · original`. |
| 5 | Every extraction rate carries "expired counts as extracted"; `gcv · upload` reads 63% · 5/8 on a set whose dates are mostly in the past. |
| 6–9 | `pnpm --filter @scanner-demo/server verify:export` over the file the phone wrote: validated against `benchmarkExportSchema`, 76 of 77 rows carrying raw OCR text verbatim (the 77th is the recorded VLM failure, which has no `ocr` block by definition), `filters.source: "camera"` recorded, 34 images — both variants of 17 capture groups. |
| 7 | Every median in the file matches the screen exactly, recomputed by an implementation that does not call the shared one: 4158.4 / 488.3 / 541.1 ms for the three `mlkit · upload` cohorts, 499.4 ms for `gcv · upload`, 2505.2 and 8934.8 ms for the two VLM models. Costs likewise: $0.0120 for eight Vision calls, and $0.0159 + $0.0125 = $0.0284 for the VLM with one run unpriced and excluded rather than counted as free. |

Two things the run also produced:

- **A defect, found and fixed.** The row's horizontal `ScrollView` sat inside the `Pressable` that
  opens the capture, so a sideways drag navigated away instead of scrolling and the columns past the
  third were unreachable — criterion 1 failing while looking like it passed. Only the header opens
  the capture now.
- **The barcode array is empty on this server**, so criterion 9 is satisfied vacuously there. It was
  exercised properly against a local database holding 57 scans: all 57 in `barcodeScans`, none in
  `attempts`.

## Risks / unknowns

- Export size: full raw text and candidate lists for a few hundred attempts is large but manageable. If
  it becomes unwieldy, paginate the export into files rather than trimming fields — the fields are the
  point.
- The temptation at this stage is to add a leaderboard that declares a winner. Resist it: the summary
  reports figures with their caveats and lets the reader draw the conclusion, because the caveats
  (network-inclusive timings, unequal Cyrillic support, non-deterministic VLM) are not comparable enough
  for a single ranking to be honest.

## Review checkpoint

Show: History with real data from all four methods on the same images; filters narrowing correctly;
gallery and camera kept apart; the JSON export re-validated and its medians reproduced from the file; and
the README section that tells a future reader how to interpret all of it.
