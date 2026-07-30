# Phase 06 — Image library

**Status:** not started · **Depends on:** 05 · **Source:** spec milestone 6

## Goal

Browse every image on the server and re-run any method against any of them — so that the three engines
built in phases 07–09 can be tested immediately against images already collected, instead of packaging
being re-shot for each one.

**This phase is deliberately built before the remaining engines.** It is what makes the later phases cheap.

## Scope

1. Thumbnail grid, newest first, paginated. Thumbnails come from `GET /api/v1/images/:id/thumb`; the grid
   never downloads full-resolution images. — *spec § Screens — Image library*
2. Filters: by `source` (camera/gallery), by date, by whether any method has been run, by whether a date
   was successfully extracted, and by `variant` (upload/original). "Has been run" and "extracted a date"
   are answered per **capture group**, not per row — [ADR-20](../decisions.md#adr-20--a-capture-group-has-one-anchor-row-and-the-librarys-filters-read-the-group).
   — *spec § Screens — Image library*, [ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid)
3. Detail view: the full image, its capture metadata, **every attempt ever run against it**, and the same
   four method buttons.
4. **Re-running is always additive.** A new run creates a new attempt row and never overwrites an earlier
   one. — *spec § Screens — Image library*
5. Attempts in the detail view are **grouped by `(method, inputVariant)`**, showing every individual run
   plus the **median** latency per group — not collapsed into one "current result" per method.
   — *spec § Screens — Image library*, [ADR-2](../decisions.md#adr-2--the-on-device-path-runs-against-both-image-variants)
6. **"Re-run all methods on this image"** — the one place a batch action belongs, because it operates on a
   fixed stored image rather than a live capture. It is still four independent calls recorded as four
   separate attempts, merely triggered together.
7. On-device re-runs download the selected variant from the server first. That download is recorded in
   its own `timing.downloadMs` segment — never folded into `uploadMs` — and `captureMs`, `downscaleMs`
   and `uploadMs` are all `null` on a re-run, so `totalMs` still has no unexplained remainder.
   — [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
8. Server side: the `GET /api/v1/images` filters listed above, backed by indexes rather than by fetching
   and filtering in the app.

## Out of scope

- The three server engines. Their buttons appear here disabled until phases 07–09 land; the Library is
  built first precisely so they have somewhere to be tested.
- History and JSON export. Phase 10 — History is the cross-image view, the Library is the per-image one.
- Deleting or editing images and attempts. The dataset is append-only.

## Deliverables

```
app/src/screens/LibraryScreen.tsx        # replaces the phase 03 placeholder
app/src/screens/ImageDetailScreen.tsx
app/src/components/
├── ImageGrid.tsx
├── LibraryFilters.tsx
├── AttemptGroupList.tsx                 # grouped by (method, inputVariant), with medians
└── RerunAllButton.tsx
app/src/lib/rerun.ts                     # downloads the variant, then reuses runMethod.ts from phase 05
app/src/lib/captureGroup.ts              # the anchor row and variant order — ADR-20
packages/shared/src/attemptGroups.ts     # the grouping and the medians, with tests
server/src/routes/images.ts              # + filters, indexes
server/src/lib/imageQuery.ts             # the list query, shared with the plan check in the tests
server/drizzle/                          # + indexes migration
```

## Key decisions

[ADR-2](../decisions.md#adr-2--the-on-device-path-runs-against-both-image-variants) ·
[ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows) ·
[ADR-20](../decisions.md#adr-20--a-capture-group-has-one-anchor-row-and-the-librarys-filters-read-the-group)

## Interfaces

```
GET /api/v1/images
  ?limit&cursor
  &source=camera|gallery
  &variant=upload|original
  &captureGroupId           every variant of one capture — the detail view needs the group
  &from&to                  capturedAt range
  &hasAttempts=true|false
  &hasDate=true|false       any attempt whose parse.expiry is non-null
  → { items: ImageRecord[], nextCursor: string | null }
```

`hasDate` counts an `expired` result as a successful extraction, per
[ADR-7](../decisions.md#adr-7--expired-dates-are-flagged-not-discarded). Both booleans are evaluated
over the row's whole capture group, per
[ADR-20](../decisions.md#adr-20--a-capture-group-has-one-anchor-row-and-the-librarys-filters-read-the-group).

`captureGroupId` is an addition to this list, made while implementing it: the detail view has to offer
both variants as run targets, and the API has no other way to ask for them. There is no endpoint
returning one image's metadata as JSON — `/api/v1/images/:id` answers with bytes — so the grid passes the
record it already holds to the detail screen as a navigation parameter, and the screen fetches the rest
of the group by this filter.

The date filter offers periods (24 h / 7 d / 30 d / any) rather than a calendar, because a date picker is
a native dependency and the question being asked while collecting a dataset is "the ones I shot today".
The server takes an arbitrary `from`/`to` range regardless, so a picker is a UI change later, not an API
one.

Re-run reuses `runMethod.ts` from phase 05 unchanged; only the image source differs (downloaded rather
than freshly captured). No second orchestration path exists.

## Acceptance criteria

1. The grid renders 100+ images without downloading a single full-resolution file. Verify from the
   server's access log: only `/thumb` requests during a scroll.
2. Each filter narrows the set correctly, and combinations compose. Verify each against a direct SQL
   count on the server database.
3. `hasAttempts=false` returns exactly the images whose **capture group** has zero attempt rows. This
   narrows what this document said before implementation — "the images with zero attempt rows" — and the
   two differ precisely for an archived original whose group has been benchmarked, because attempts hang
   off the group's uploaded row: [ADR-20](../decisions.md#adr-20--a-capture-group-has-one-anchor-row-and-the-librarys-filters-read-the-group).
4. Tapping an image opens the detail view with the full image, all capture metadata, and every attempt.
5. Running the on-device method twice on the same image produces **two** attempt rows; neither replaces
   the other, and both appear under the same group with a median across them.
6. Attempts are grouped by method **and** input variant — an on-device `original` run and an on-device
   `upload` run are never averaged together.
7. "Re-run all methods" produces one attempt per available method, each with its own timing; a failure in
   one does not prevent the others from being recorded.
8. On a re-run, `captureMs`, `downscaleMs` and `uploadMs` are `null` and render as "n/a", `downloadMs` is
   populated, and the recorded segments account for `totalMs` to within a few milliseconds.
9. Thumbnail requests carry the bearer token and succeed; removing the token yields 401.
   — [ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication)
10. Filter queries are index-backed: `EXPLAIN QUERY PLAN` shows no full table scan on `images` for the
    default listing or for any single filter.

## Risks / unknowns

- Median over a small number of runs is noisy by definition. The UI shows the run count next to the
  median so a median-of-two is never mistaken for a stable figure.
- Grid memory pressure with a few hundred thumbnails — use a windowed list from the start rather than
  discovering it at 300 images.
- Downloading the `original` variant for an on-device re-run may be large over mobile data. Show the size
  before downloading; do not silently pull 8 MB.

## Review checkpoint

Show: the grid over the images collected in phase 05, each filter narrowing correctly, a detail view with
several attempts grouped and median-summarised, the same method run twice producing two rows, and a
re-run with `captureMs`/`uploadMs` correctly absent.
