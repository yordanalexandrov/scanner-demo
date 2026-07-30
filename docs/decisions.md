# Architecture decision records

Every judgement call that `docs/scanner-demo-claude-code-prompt.md` left open, or that the phase plan
had to resolve to be executable. One record per decision.

**Status values**

| Status | Meaning |
|---|---|
| `Accepted` | Confirmed by the repository owner. Do not revisit without a new ADR. |
| `Proposed` | My recommendation. Open to challenge in review; becomes `Accepted` on approval. |
| `Provisional` | Deliberately re-opened later, at a named point, when evidence exists. |
| `Deviation` | Departs from the written specification. Called out explicitly, never applied silently. |

**Index**

| # | Decision | Status | Affects |
|---|---|---|---|
| [1](#adr-1--barcode-measurements-are-persisted-server-side) | Barcode measurements persisted in their own table | Accepted | 04 |
| [2](#adr-2--the-on-device-path-runs-against-both-image-variants) | On-device OCR runs against both image variants | Accepted | 05, 06 |
| [3](#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid) | Two-variant image storage with `captureGroupId` | Accepted | 02, 05, 06 |
| [4](#adr-4--bbox-is-nullable-and-the-parser-records-which-rule-decided) | `bbox` nullable; parser records which rule decided | Proposed | 05, 09 |
| [5](#adr-5--bbox-format-and-confidence-nullability) | `bbox` format; `confidence` nullable | Proposed | 01, 05 |
| [6](#adr-6--parser-rule-order-and-referencedate) | Parser rule order and `referenceDate` | Proposed | 05 |
| [7](#adr-7--expired-dates-are-flagged-not-discarded) | Expired dates flagged, not discarded | **Deviation** | 05 |
| [8](#adr-8--month-only-dates-resolve-to-the-last-day-with-a-precision-field) | Month-only dates → last day + `precision` | Proposed | 05 |
| [9](#adr-9--month-name-locales-for-dd-mmm-yyyy) | Month-name locales for `DD MMM YYYY` | Proposed | 05 |
| [10](#adr-10--latency-segments-clocks-and-what-may-be-subtracted) | Latency segments, clocks, valid subtraction | Proposed | 04–10 |
| [11](#adr-11--cost-estimates-come-from-a-versioned-price-table) | Versioned price table with `pricingVersion` | Proposed | 01, 08, 09 |
| [12](#adr-12--the-self-hosted-engine-defaults-to-chineseenglish-models) | Self-hosted engine defaults to ch+en models | Provisional | 07 |
| [13](#adr-13--idea-is-gitignored) | `.idea/` is gitignored | Accepted | 01 |
| [14](#adr-14--shared-package-build-and-thumbnail-authentication) | Shared package build; thumbnail auth | Proposed | 01, 06 |
| [15](#adr-15--the-app-is-the-sole-author-of-attempt-rows) | The app is the sole author of attempt rows | **Deviation** | 05–10 |
| [16](#adr-16--separators-and-year-widths-are-normalised-before-matching) | Separators and year widths normalised before matching | Proposed | 05 |
| [17](#adr-17--nginx-and-certbot-instead-of-caddy) | nginx + certbot instead of Caddy | **Deviation** | 02 |
| [18](#adr-18--the-benchmark-shares-the-box-with-production) | The benchmark shares the box with production | Accepted | 02, 07, 10 |
| [19](#adr-19--vision-camera-is-pinned-to-v4-and-the-android-project-is-generated) | vision-camera pinned to v4; Android project generated, not committed | Accepted | 03, 04, 05 |
| [20](#adr-20--a-capture-group-has-one-anchor-row-and-the-librarys-filters-read-the-group) | One anchor row per capture group; group-scoped Library filters | Proposed | 06, 10 |

**Rule names, not rule numbers.** The specification numbers its disambiguation rules 1–4;
[ADR-6](#adr-6--parser-rule-order-and-referencedate) inserts extraction as a step and renumbers them. To
avoid two numbering schemes in one repository, these documents refer to the rules by the `ParseRule`
names — `anchor-proximity`, `latest-of-pair`, `sole-candidate`, `none` — everywhere outside a direct
quotation of the specification.

---

## ADR-1 — Barcode measurements are persisted server-side

**Context.** Goal 1 of the project is "how fast EAN-13 barcode scanning is on-device". The specification's
barcode screen shows decode latency in a result card, but no endpoint, table or screen persists it, and
History is defined as "grouped by source image" — which a barcode scan has none of. As written, the
numbers answering goal 1 vanish when the screen unmounts.

**Decision.** Barcode scans are persisted in their own table and served by their own endpoints.

```
barcode_scans
  id          text primary key      -- uuid
  value       text not null         -- the decoded EAN-13
  decodeMs    real not null         -- scanner-ready → callback, performance.now()
  device      text not null         -- model + Android version, so runs stay comparable
  scannedAt   integer not null      -- unix ms, wall clock, for ordering only

POST /api/v1/barcode-scans   { value, decodeMs, device } → { id }
GET  /api/v1/barcode-scans   paginated, newest first
```

**Rationale.** A separate table rather than reusing `attempts`: a barcode scan has no image, no OCR engine,
no raw text, no parsed date and no cost. Folding it into `attempts` would make `imageId` and most other
columns nullable across the whole benchmark dataset to accommodate a row type that shares none of its
semantics, and every attempts query would need a method filter to stay correct.

**Consequences.** One extra table, two extra endpoints, and a small list view on the barcode screen showing
recorded scans with the running median. Barcode scans do not appear in History or in the JSON export's
attempts array; the export gains a sibling `barcodeScans` array.

**Amended by phase 04.** `decodeMs` is measured from *scanner*-ready rather than *screen*-ready: the origin
is the camera reporting it is running for the first reading of a session, and the previous recorded scan
for every reading after it. The row deliberately does **not** record which of the two it was, so a reading
lifted out of the export is not self-describing — it has to be attributed by session first. Only the first
reading of a session is a decode latency; the rest are bounded below by the screen's 800 ms dedupe window.
The reasoning, and the measurements that forced it, are in
[phase 04](phases/04-barcode.md#measured-on-device).

**Status.** Accepted.

---

## ADR-2 — The on-device path runs against both image variants

**Context.** The specification downscales the photo on the phone before upload (~1600px long edge, JPEG
q80) and calls this the single largest end-to-end latency win. That leaves an unstated question: which
image does on-device ML Kit read — the full-resolution capture, or the downscaled buffer that the server
engines will see? If they differ, the on-device path is being compared against a different input from the
other three, and the measured accuracy difference is no longer attributable to the OCR alone.

**Decision.** The on-device path runs **twice** per capture — once over the full-resolution original and
once over the downscaled upload buffer — and records **two separate attempts**, distinguished by
`inputVariant: "original" | "upload"`.

**Rationale.** The `upload` run is the fair comparison: identical bytes to what the three server engines
receive. The `original` run measures what the on-device path can actually do at its best, and the
difference between the two is a direct measurement of what downscaling costs in accuracy — which the
specification explicitly wants ("keep it configurable so I can measure the trade-off").

**Consequences.** On-device work per capture doubles. Every attempts view must group by
`(method, inputVariant)`, not by method alone, or the two runs will be averaged together and both numbers
will be wrong. Comparisons against server engines must filter to `inputVariant: "upload"`. This decision
is what forces [ADR-3](#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid).

**Status.** Accepted.

---

## ADR-3 — Images are stored in two variants linked by `captureGroupId`

**Context.** The specification stores only the downscaled upload, and states that the server-side image
store is the test dataset: "I want to be able to re-run every method over old photos later without
re-shooting them." Under [ADR-2](#adr-2--the-on-device-path-runs-against-both-image-variants) the
full-resolution original is an input to a recorded attempt, but it exists only transiently in the phone's
memory. That attempt could therefore never be reproduced, and the full-resolution image could never be
re-benchmarked — contradicting the stated purpose of the store.

**Decision.** The image store holds up to two variants per physical capture, linked by a shared
`captureGroupId`.

```
images
  id              text primary key
  captureGroupId  text not null      -- shared by variants of the same physical capture
  variant         text not null      -- "upload" | "original"
  source          text not null      -- "camera" | "gallery"
  width           integer not null
  height          integer not null
  bytes           integer not null
  mimeType        text not null
  -- capture settings that applied; null where not applicable
  torch            integer            -- null for gallery imports
  captureWidth     integer            -- sensor resolution requested
  captureHeight    integer
  downscaled       integer not null   -- 0/1, whether client-side downscaling ran
  capturedAt       integer not null   -- unix ms; the referenceDate of ADR-6
  capturedAtSource text not null      -- "camera" | "exif" | "import"
  createdAt        integer not null
```

`width`, `height`, `bytes` and `mimeType` are derived server-side with `sharp` from the uploaded bytes,
never taken from the client — otherwise the recorded capture metadata is unverifiable. The client supplies
only what it alone knows: the capture conditions.

The **measured** upload path is unchanged: the downscaled variant is uploaded first and it alone produces
the `uploadMs` figure. Archiving the original starts **after** the measured path has completed, in the
background, behind the `ARCHIVE_ORIGINAL` flag (default on). It never overlaps the measurement window.

For gallery imports the picked file *is* the original; the downscaled variant is derived from it on the
phone exactly as for a camera capture, so both variants exist for gallery images too.

**Rationale.** Without this, half the attempts recorded under ADR-2 are unreproducible, and the "re-run
methods on old photos" workflow silently only ever works on downscaled images. It also lets the server
engines be pointed at the full-resolution variant from the Library, which turns "what does downscaling
cost?" into a question answerable for all four methods rather than only the on-device one.

**Consequences.** Storage per capture roughly doubles; acceptable for a POC dataset of a few hundred
images, and `ARCHIVE_ORIGINAL=false` turns it off. Library filters gain a `variant` dimension. A failed
background archive must not fail the capture — it is logged and the group simply has one variant, which
the Library must render without breaking.

**Status.** Accepted.

---

## ADR-4 — `bbox` is nullable and the parser records which rule decided

**Context.** Disambiguation rule 1 ("prefer the date candidate whose bounding box is nearest an anchor")
requires positional data, and the specification requires every engine adapter to return
`blocks: [{ text, bbox, confidence }]`. But the VLM path returns prose and a structured answer; OpenAI
does not return reliable bounding boxes for text it reads. Synthesising plausible-looking boxes to satisfy
the type would feed fabricated positions into the one rule that is supposed to be the most trustworthy.

**Decision.** `bbox` is `[number, number, number, number] | null`. When a candidate has no usable box, the
parser skips `anchor-proximity` and falls through to the positional-free rules. The parse result records
**which rule decided**:

```ts
type ParseRule = "anchor-proximity" | "latest-of-pair" | "sole-candidate" | "none";
```

`ParseResult` carries `rule`, so any accuracy comparison can be split by decision path.

**Rationale.** Fabricated positional data is worse than absent positional data, because absent data is
visible in the results and fabricated data is not. Recording the rule also answers a question the
specification implies but does not ask: how often does the anchor rule actually get to fire? If the answer
is "rarely", the anchor list matters much less than it appears to.

**Consequences.** The parser must be correct with zero boxes, which is also the case for any engine whose
adapter degrades. Comparing VLM raw-text parsing against GCV raw-text parsing is not purely an OCR
comparison — the VLM's candidates were chosen by a weaker rule — and the results view must show the rule
so this is visible rather than buried.

**Status.** Proposed.

---

## ADR-5 — `bbox` format and `confidence` nullability

**Context.** The specification fixes the field names but not their units or coordinate space, and assumes
every engine reports a confidence. ML Kit's React Native wrapper surfaces text and a frame per block but,
as far as I can establish, no confidence value.

**Decision.**

- `bbox` is `[x, y, width, height]` in **pixels of the image the engine actually processed**, origin
  top-left. Each `OcrResponse` also carries `imageWidth` / `imageHeight` for that processed image, so
  boxes can be normalised after the fact and compared across engines that saw different variants.
- `confidence` is `number | null`, range 0–1 where present. A missing confidence is recorded as `null`,
  never as `1.0`.

**Rationale.** Pixels plus explicit dimensions is lossless and lets any consumer normalise; normalised
coordinates alone would discard the scale information needed to relate a box on the `upload` variant to
one on the `original`. Substituting `1.0` for an absent confidence would make the on-device path look
maximally certain on every block it ever emitted, which would corrupt every confidence comparison.

**Consequences.** The parser's confidence score must treat `null` as "no signal" rather than as a number.
The results view shows "not reported" rather than a value for the on-device path. Verify against the
wrapper during phase 05: if confidence turns out to be available, this ADR is superseded and no consumer
needs changing, because `null` was already handled.

**Status.** Proposed.

---

## ADR-6 — Parser rule order and `referenceDate`

**Context.** The specification lists four disambiguation rules "in order" but they are not disjoint, and
rule 3 ("discard dates in the past") interacts badly with rule 2 ("the earlier date is production") — see
[ADR-7](#adr-7--expired-dates-are-flagged-not-discarded). Separately, "in the past" is undefined relative
to what: parse time or capture time. Re-running a method a year later would then change the verdict on an
image whose pixels never changed, which breaks the re-run workflow the Library exists for.

**Decision.** The parser is a pure function of its inputs:

```ts
parseExpiryDate(blocks: Block[], opts: { referenceDate: Date }): ParseResult
```

`referenceDate` defaults to the image's `capturedAt` and is **stored on every attempt row**. Rule order:

1. **Extract candidates.** Scan every block for the supported formats. Each candidate keeps its source
   block, its bbox if present, and the raw matched substring.
2. **Anchor proximity.** Find anchor tokens (case-insensitive). If at least one anchor and one candidate
   both have boxes, pick the candidate whose box centre is nearest an anchor box centre, subject to a
   maximum distance; beyond it, treat as no anchor. → `rule: "anchor-proximity"`.
3. **Two or more candidates, no usable anchor.** The later date is the expiry, the earlier is the
   production date. Both are returned — the production date is reported, not thrown away.
   → `rule: "latest-of-pair"`.
4. **One candidate.** → `rule: "sole-candidate"`.
5. **Numeric ambiguity in two-component dates.** The specification's rule — "for ambiguous `MM/YY` vs
   `DD/MM`, if either number exceeds 12 it is the day" — is applied **positionally**, because the literal
   reading gets the common case wrong: in `03/25` the `25` is a year, not a day.
   - First component > 12 → it cannot be a month, so the string is `DD/MM` and the year is the next
     occurrence after `referenceDate`.
   - Second component > 12 → it cannot be a month, so the string is `MM/YY`.
   - Both ≤ 12 → genuinely ambiguous. Prefer whichever reading falls inside the sanity window; if both
     do, default to `MM/YY`, which is the listed format. Either way set `ambiguous: true` and lower the
     confidence.

   Three-component dates are never subject to this rule: `MM/DD/YY` is not in the specification's format
   list, so `01/03/27` is unambiguously `DD/MM/YY`.
6. **Sanity window,** applied last and only to the chosen expiry candidate: discard if more than 10 years
   after or more than 10 years before `referenceDate`. See ADR-7 for what happens to dates merely in the
   past.

`referenceDate` needs a defined source for images that were not captured by this app.
`ImageRecord.capturedAtSource` records it: `camera` for a capture, `exif` when a gallery import carries
`DateTimeOriginal`, and `import` when it does not. An import falling back to `import` time is visibly
weaker evidence, which matters because the reference date decides `valid` versus `expired`.

The confidence score is composed from named signals rather than being a single opaque number:

```ts
{ score: number, signals: ("anchor-matched" | "ambiguous-numeric" | "month-precision-only"
                          | "no-bbox" | "engine-confidence-missing" | "multiple-candidates")[] }
```

**Rationale.** Making `referenceDate` an explicit input rather than an implicit `new Date()` is what makes
re-runs reproducible, which is the whole premise of the Library. Reporting the signals rather than only
the score satisfies "never silently guess" in a way a bare number cannot.

**Consequences.** Unit tests can pin `referenceDate` and stay deterministic forever. Attempt rows carry
one extra column. Any attempt recorded before this column existed cannot be re-verified — irrelevant, as
none exist yet.

**Status.** Proposed.

---

## ADR-7 — Expired dates are flagged, not discarded

**Context.** Rule 3 of the specification says "discard dates in the past or more than 10 years out". But
a production date is in the past by definition — rule 2 depends on that — and a test dataset photographed
from real packaging will contain items that have already expired. Discarding those dates makes the parser
return "no date found" for an image where the date was read perfectly.

**Decision. This departs from the written specification.** Dates in the past are **not** discarded. The
parse result carries:

```ts
status: "valid" | "expired"
```

`expired` means the date parsed cleanly and lies before `referenceDate`. Only dates more than 10 years
away in **either** direction are discarded as implausible OCR noise.

**Rationale.** The harness measures OCR accuracy. Conflating "the engine failed to read the date" with
"the engine read the date correctly and the yoghurt is old" would systematically penalise every engine on
every expired item, and the penalty would fall hardest on whichever engine reads best. It also silently
shrinks the usable test dataset to items still in date — a constraint that would quietly worsen as the
dataset ages.

**Consequences.** Downstream consumers must handle `status: "expired"` rather than assuming a returned
date is in the future. Accuracy scoring counts an `expired` result as a successful extraction. The UI
labels it visibly so a real expired product is never mistaken for a valid one. If the intent behind rule 3
was in fact "an expiry date in the past is evidence of a misread", say so and this ADR is withdrawn — but
then the sanity window should be argued from evidence in the dataset rather than assumed.

**Status.** Deviation — requires explicit approval.

---

## ADR-8 — Month-only dates resolve to the last day, with a `precision` field

**Context.** `MM.YYYY` and `MM/YY` are in the supported format list. Both name a month, not a day, and the
specification does not say which day they become.

**Decision.** A month-only date resolves to the **last day of that month**, and the result carries
`precision: "day" | "month"`.

**Rationale.** "Best before 03/2027" means the product is good through March, so the last day is the
semantically correct expiry. The `precision` field keeps this from being mistaken for a day-accurate
reading in scoring: an engine that returned `31.03.2027` from a package printed `03/2027` should not be
counted as more precise than the packaging was.

**Consequences.** Accuracy comparison against ground truth must compare at the recorded precision.
Month-precision results carry the `month-precision-only` confidence signal from ADR-6.

**Status.** Proposed.

---

## ADR-9 — Month-name locales for `DD MMM YYYY`

**Context.** The format list includes `DD MMM YYYY` without saying which language's month names are
recognised, while the anchor list spans English (`BEST BEFORE`, `USE BY`), German (`MHD`), French (`DLC`)
and Bulgarian (`Годен до`).

**Decision.** Month names are recognised in **English, Bulgarian, German and French**, full and
abbreviated, case- and diacritic-insensitive. The set lives in one table in `packages/shared` next to the
anchor list, so adding a language means adding a row.

**Rationale.** The anchor list already commits to those four languages; recognising `MHD` but not `MÄRZ`
would be inconsistent in a way that shows up as a fake accuracy difference between packages.

**Consequences.** More false-positive surface for short abbreviations that collide across languages
(`MAI`, `MAR`) — harmless, since all collisions resolve to the same month number. The on-device path
cannot benefit from the Bulgarian entries at all, because ML Kit does not read Cyrillic; that is a
property of the method and is recorded in the README.

**Status.** Proposed.

---

## ADR-10 — Latency segments, clocks, and what may be subtracted

**Context.** The result view wants "capture → upload → OCR → parse → total". Several of those segments do
not exist on every path: a gallery import has no capture, a Library re-run has neither capture nor upload.
Worse, the segments are measured on two different machines whose clocks are unrelated, and the
specification also asks for the sidecar's process boundary to be measured separately.

**Decision.**

- All segments are `number | null`. `null` means "not applicable on this path", and is never rendered as
  `0`.
- All durations use `performance.now()` on the phone and `process.hrtime.bigint()` on the server.
  `Date.now()` is used only for wall-clock timestamps that are ordered, never subtracted.
- **`totalMs` is measured entirely on the phone**, from the start of the user-visible action to the
  parsed result. It is a single-clock measurement.
- The server reports two figures inside every `OcrResponse`:
  - `engineMs` — time inside the recognition engine itself.
  - `serverTotalMs` — wall time inside the Fastify handler.
  The sidecar's process-boundary cost is `serverTotalMs - engineMs`. Both come from the same clock, so
  that subtraction is valid; it is computed for display and not stored.
- **No value measured on the phone is ever subtracted from a value measured on the server.** The one
  quantity that spans both is network time, and it is reported as an estimate derived from two stored
  fields — `timing.requestMs` (the phone's round trip) minus `ocr.serverTotalMs` — labelled as such and
  never presented as a precise figure. Both operands are persisted, so the estimate can be recomputed
  from the export rather than existing only on screen.
- Every segment the phone can observe is a stored field, so `totalMs` has no unexplained remainder:
  `captureMs`, `downscaleMs`, `uploadMs`, `downloadMs` (re-runs only), `requestMs` and `parseMs`.
- `engineMs` is not equally meaningful across engines, so every `OcrResponse` declares its scope:
  `engineMsScope: "inference" | "inference+network"`. The sidecar and ML Kit report `inference`; GCV and
  the VLM report `inference+network`, because their SDKs expose no way to separate the two. Any chart
  comparing `engineMs` across engines must show this, or it is comparing different things.

**Rationale.** The stated purpose is trustworthy numbers. Cross-clock subtraction produces figures that
look precise and are not, and an unlabelled `engineMs` invites a comparison between a local inference time
and a transatlantic round trip.

**Consequences.** Some cells in the results table read "n/a" — deliberately. GCV and VLM `engineMs` values
are not comparable with the sidecar's without that caveat, and the History export carries `engineMsScope`
so the caveat survives export.

**Status.** Proposed.

---

## ADR-11 — Cost estimates come from a versioned price table

**Context.** `costEstimateUsd` is required on every `OcrResponse`, but the specification says nothing about
where the prices come from. Provider prices change, and old benchmark records must stay interpretable —
the same concern that made the model name part of `engine`.

**Decision.** Prices live in one table in `packages/shared`:

**The table is keyed by the `engine` string itself**, so a stored attempt looks its own price up with no
mapping layer:

```ts
export const PRICING_VERSION = "unset";     // bumped to the retrieval date by whichever phase fills a price

export const pricing: Record<string, PriceEntry> = {
  "mlkit":                       { unit: "on-device",     usd: 0 },
  "onnx-paddleocr":              { unit: "self-hosted",   usd: 0, notes: "marginal cost only; VPS is a sunk cost" },
  "onnx-paddleocr-cyrillic":     { unit: "self-hosted",   usd: 0, notes: "as above" },
  "gcv:builtin/stable":          { unit: "per-1000-images", usd: null,
                                   source: null, retrieved: null, notes: "free tier ignored — phase 08" },
  // one entry per model actually used, added by phase 09 under the exact engine string:
  // "vlm:openai/<model>":        { unit: "per-1M-tokens", inputUsd: null, outputUsd: null, … },
};
```

Every attempt records `pricingVersion`, and a price that is still `null` yields `costEstimateUsd: null`
rather than `0` — an unknown cost must not render as a free one. Numbers are filled in at implementation
time from the provider's public pricing page, and each entry records the source URL and retrieval date;
they are not written from memory. **Filling in a price bumps `PRICING_VERSION`**, because a version that
covers two different price sets identifies nothing.

**Rationale.** A cost column that silently changes meaning when a provider reprices is worse than no cost
column. Recording the version makes old records interpretable and makes "these two runs were priced
differently" visible instead of invisible.

**Consequences.** Free tiers are deliberately ignored: the estimate answers "what would this cost at
scale", which is the decision the benchmark informs. Self-hosted shows `0` with a note that VPS capacity
is a sunk cost, not a claim that the method is free.

**Status.** Proposed.

---

## ADR-12 — The self-hosted engine defaults to Chinese/English models

**Context.** RapidOCR ships PP-OCR models trained on Chinese and English. The specification notes that
Cyrillic recognition requires selecting a different model explicitly, and separately forbids opening the
OCR container or writing Python inside it. Whether the model can be swapped through configuration or a
volume mount — without touching the container's code — is not something to settle from memory.

**Decision.** The default configuration is the stock Chinese/English mobile models. The phase 07 spike
answers, as a named deliverable, whether the recognition model and character dictionary can be replaced
through environment variables or a mounted path. If they can, a Cyrillic-capable configuration is added as
a second, separately labelled engine (`onnx-paddleocr-cyrillic`) rather than replacing the default, so the
two remain comparable. If they cannot, the self-hosted path is documented as digit-only for Bulgarian
packaging.

**Rationale.** Which anchor words the parser can ever match on this path depends entirely on the answer,
so it belongs to the spike rather than to a guess. Adding a Cyrillic engine alongside rather than instead
of the default keeps the existing dataset's results valid.

**Consequences.** Until the spike reports, the self-hosted engine is expected to match no Bulgarian anchor
words, and its parse results will lean on `latest-of-pair` and `sole-candidate`. Mobile/lightweight
detection and recognition models are preferred over the server variants regardless, per the
specification. `"onnx-paddleocr-cyrillic"` is present in the `method` enum and the price table from phase
01 onward, so a positive spike result needs no schema change.

**Status.** Provisional — revisited at the phase 07 spike checkpoint.

---

## ADR-13 — `.idea/` is gitignored

**Context.** The IntelliJ project directory was staged in the working tree before the first commit, and
the repository is public.

**Decision.** `.idea/` is gitignored and removed from the index with `git rm --cached` (files stay on
disk).

**Rationale.** It carries machine-local paths and editor state, and `workspace.xml` in particular records
local file history. Nothing in it is useful to a reader of a public benchmark harness.

**Consequences.** None for the owner's local setup.

**Status.** Accepted.

---

## ADR-14 — Shared package build and thumbnail authentication

**Context.** Two mechanical questions the specification does not cover: how `packages/shared` is consumed
by a Metro bundler and by Node, and how an authenticated `<Image>` request works when every endpoint
except `/health` requires a bearer token.

**Decision.**

- `packages/shared` is built with `tsup` to ESM + CJS with type declarations. The app additionally needs
  Metro configured for the monorepo (`watchFolders` covering the workspace root, plus `nodeModulesPaths`)
  so pnpm's symlinked layout resolves.
- Image and thumbnail requests from the app pass the bearer token in a request header via React Native's
  `source.headers`, rather than introducing signed URLs.

**Rationale.** Dual output avoids interop friction between Metro and Node without either side special-casing
the other. Signed URLs would add a token-minting endpoint and an expiry policy to a POC whose entire threat
model is "the repository is public"; a header on an already-authenticated client is sufficient.

**Consequences.** `pnpm build` in `packages/shared` must run before typechecking the app and server, so CI
orders it first. If header-authenticated images prove unreliable in the RN image pipeline, the fallback is
a short-lived signed URL — a change confined to one server route and one client helper.

**Status.** Proposed.

---

## ADR-15 — The app is the sole author of attempt rows

**Context.** The API has both `POST /api/v1/ocr/*` (which returns an `OcrResponse`) and
`POST /api/v1/attempts` (which "stores a benchmark record, incl. on-device results"). It is not stated who
writes the attempt row for a server engine — the server, at the end of its own OCR handler, or the app,
after it receives the response. Nor is it stated where the shared date parser runs for server engines.

**Decision. This departs from the written specification.** The OCR endpoints are stateless: they recognise
text and return it, and write nothing. The app orchestrates every method, runs the shared parser on the
phone for all four paths, and posts exactly one attempt row per run.

The departure is narrow but real: the specification says the parser is "imported by both the app and the
server". Under this decision the server does not call it. The *reason* the specification gives — "so there
is exactly one implementation" — is fully preserved: there is exactly one implementation, it lives in
`packages/shared`, and every method's raw text goes through it.

**Rationale.** It gives one orchestration path instead of two, and it makes `parseMs` a comparable number:
parse time for all four methods is then measured on the same CPU with the same code. If the server parsed
for three engines and the phone parsed for the fourth, the parse column would silently compare a VPS core
against a phone core. It also keeps the four methods genuinely independent — an engine cannot influence
what gets recorded about it.

**Consequences.** A measurement is lost if the phone fails to post the attempt after a successful OCR call.
For a POC operated by hand this is acceptable; the failure is surfaced in the UI rather than swallowed, so
a lost record is visible and the run can be repeated. The server never fabricates attempt rows, so
`GET /api/v1/images/:id/attempts` reflects exactly what the app recorded. The VLM endpoint still returns
its own structured `parsedDate` alongside the raw text, per the specification, and the app additionally
records the shared parser's reading of that same raw text — both land on the one attempt row.

If the literal requirement matters more than the reason behind it, the alternative is for the server to
also parse and return its own reading on each `/ocr/*` response, for cross-checking. That is a small
addition and it does not conflict with anything here; it was left out only because a second parse result
measured on a different CPU adds a column nobody would trust more than the first.

**Status.** Deviation — requires explicit approval.

---

## ADR-16 — Separators and year widths are normalised before matching

**Context.** The specification lists eight formats: `DD.MM.YYYY`, `DD/MM/YY`, `DD-MM-YYYY`, `MM.YYYY`,
`MM/YY`, `DDMMYY`, `YYYY-MM-DD`, `DD MMM YYYY`. Read literally, that is eight exact strings — which means
`31.12.2027` parses and `31/12/2027` does not, because only the dotted form appears with a four-digit
year. Real packaging mixes separators and year widths freely.

**Decision.** The list is read as a set of **component patterns**, not eight literal strings. Before
matching, the parser normalises:

- **Separators** `.`, `/`, `-` and a single space are equivalent.
- **Year width** is either two or four digits in any pattern that has a year. A two-digit year resolves
  into the century that places it within the sanity window of ADR-6.
- The unseparated `DDMMYY` form stays a distinct pattern, since it has no separator to normalise.

The recognised **component orders** remain exactly those the specification lists — `DD MM YYYY`,
`MM YYYY`, `YYYY MM DD` and `DD MMM YYYY`. `MM DD YYYY` is deliberately absent, which is what makes a
three-component date unambiguous under ADR-6.

**Rationale.** Without this, a legibly printed date fails to parse because of the character between its
numbers, and that failure would be recorded against the OCR engine that read it perfectly. The harness
exists to attribute differences to the engines; a parser artefact that hits engines unevenly, depending on
what packaging each happened to photograph, is exactly the confound it must not have.

**Consequences.** More false-positive surface: any three numbers separated by dots become a candidate. The
sanity window and the recorded `candidates` list with `rejectedFor` reasons are what keep this inspectable
rather than silent. The parser's tests cover the cross-product deliberately — `31.12.25` and `31/12/2025`
must both parse to the same date.

**Status.** Proposed.

---

## ADR-17 — nginx and certbot instead of Caddy

**Context.** The specification chose Caddy in front for automatic TLS on `scanner.yo-po.eu`. Surveying the
target box on 2026-07-28 showed that choice is not available: nginx 1.24 already owns ports 80 and 443,
serving two production sites (`emerald`, `garden`) with Let's Encrypt certificates managed by `certbot`,
in front of an eight-container Supabase stack. See [deployment-target.md](deployment-target.md).

**Decision. This departs from the written specification.** TLS for `scanner.yo-po.eu` is terminated by a
new nginx virtual host with a certbot certificate, proxying to the scanner server on `127.0.0.1:3002`.
Caddy is dropped from the stack entirely — there is no Caddy container and no `Caddyfile`.

The vhost follows the pattern already in use on the box, with one addition: `client_max_body_size` is
raised on the upload route, because the existing sites cap it at 8 MB and a full-resolution phone photo
exceeds that.

**Rationale.** The three options were: add an nginx vhost; run Caddy behind nginx on a local port; or
migrate the two production sites to Caddy and retire nginx. The second keeps Caddy's name in the stack
while removing everything Caddy is for — it would terminate no TLS, obtain no certificate, and cost a
container's memory on a box with 2.2 GB free. The third risks two live sites and a production Supabase
stack for a proof-of-concept's convenience. The first is the only one that changes nothing that currently
works.

The specification's decision was made without visibility of the box. It is a departure from the letter of
a settled choice, not from its purpose: `scanner.yo-po.eu` still gets automatic, renewing TLS.

**Consequences.** Phase 02 delivers an nginx vhost file and a certbot invocation instead of a `Caddyfile`,
and the Compose stack publishes only to loopback. Certificate renewal rides on the box's existing certbot
timer rather than being self-contained in the project's stack — meaning this project's TLS now depends on
host configuration outside the repository, which the phase 02 documentation must state. If the harness
ever moves to a dedicated box, Caddy becomes available again and this ADR should be revisited.

**Status.** Deviation — accepted by the repository owner on 2026-07-28.

---

## ADR-18 — The benchmark shares the box with production

**Context.** The specification anticipated a small shared VPS and required the sidecar's CPU and threads
to be bounded for that reason. The survey showed the sharing is heavier than that phrasing suggests:
**2 cores and 3.7 GB RAM total, ~2.2 GB available, no swap**, alongside a live Postgres and two production
sites. The harness exists to produce latency numbers that can be trusted, and it will produce them on a
machine whose load it does not control.

**Decision.** The co-tenancy is treated as a measurement condition, recorded rather than wished away:

- The OCR sidecar gets **both** a CPU cap (`cpus:`) and a hard **`mem_limit`**. With no swap, an
  unbounded container that grows would trigger the OOM killer, and the largest resident process on the
  box is production Postgres. A benchmark must not be able to take down the thing it is a guest of.
- **Lightweight PP-OCR models are a constraint, not a preference.** The specification prefers them for
  latency; here the memory budget makes the server-sized models impractical anyway.
- Latency figures are gathered as **distributions over at least twenty runs**, never single measurements,
  and the phase 07 acceptance criteria set an explicit spread threshold. A single number from this box
  means nothing.
- The README states, next to the figures, that they come from a two-core box shared with a live
  application. A reader comparing them against a dedicated machine's numbers needs to know that.

**Rationale.** The alternative — treating the box as if it were idle — produces numbers that look precise
and are not, which is the specific failure this project is built to avoid. Naming the condition costs a
paragraph; discovering it after drawing conclusions costs the conclusions.

**Consequences.** Absolute latencies from this harness are not portable to other hardware. What remains
valid is the **comparison between the four methods**, since all four are measured under the same
conditions — and that comparison is what the project is for. Cloud engines (GCV, VLM) are less affected by
local contention than the sidecar is, which slightly flatters them; that asymmetry belongs in the README's
"how to read these numbers" section.

**Status.** Accepted — it follows from observed facts, not from a preference.

---

## ADR-19 — vision-camera is pinned to v4, and the Android project is generated

**Context.** Phase 03 installs `react-native-vision-camera` against a fixed Expo SDK so that phase 04
does not open with a native upgrade. At the time of writing that meant Expo SDK 57 (React Native 0.86)
and vision-camera 5.2.0, which is what `expo install` resolves to.

Vision-camera 5 is a rewrite on top of Nitro modules, and it **removed `useCodeScanner`**. Its
replacement, `useObjectOutput` / `CameraObjectOutput`, is annotated `@platform iOS` throughout, and the
Android implementation is a stub:

```kotlin
// node_modules/react-native-vision-camera/android/.../HybridCameraFactory.kt:112
override fun createObjectOutput(options: ObjectOutputOptions): HybridCameraObjectOutputSpec {
  throw Error("CameraObjectOutput is not available on Android!")
}
```

On an Android-only project, vision-camera 5 therefore cannot scan a barcode at all. That is not a
detail: goal 1 of the whole harness is "how fast on-device EAN-13 barcode scanning is", and the
specification names `useCodeScanner` as the mechanism precisely so that no frame processor or worklet
is involved.

**Decision.**

- `react-native-vision-camera` is pinned to **4.7.3**, exactly, not a caret range. It exposes
  `useCodeScanner`, and `CodeType` includes `'ean-13'`. On Android it is backed by ML Kit's barcode
  scanner, which runs natively — no frame processors, no worklets, no Bitmap conversion.
- The Expo config plugin is configured with **`enableFrameProcessors: false`**. The constraint forbids
  frame processors, so the C++ runtime that supports them is not compiled into the app either. This is
  visible after a prebuild as `VisionCamera_enableFrameProcessors=false` in `android/gradle.properties`.
- The plugin is configured with **`enableCodeScanner: true`**, which bundles the ML Kit barcode model
  (~2.4 MB) into the APK. This is a measurement decision, not a size one: left at `false`, the model is
  fetched on demand from Google Play Services, and the first scan on a fresh install would time a model
  download as if it were decode latency. Bundling it makes the first scan comparable with the hundredth.
- `app/android/` is **generated by `expo prebuild` and gitignored**, not committed. `app.json` plus the
  config plugins are the single source of truth for the native project; a committed copy is a second
  one, and the two drift the first time a plugin option changes.

**Rationale.** The alternative orderings were considered and rejected. Taking vision-camera 5 and
scanning barcodes some other way abandons `useCodeScanner`, and every remaining option on Android is a
frame processor — which the constraints forbid, and which would make decode latency measure our own
JavaScript rather than the platform's scanner. Waiting for v5 to gain Android support blocks phase 04 on
someone else's release schedule. Pinning v4.7.3 keeps the measured path exactly the one the
specification describes.

**Consequences.** The app tracks the current Expo SDK while holding a camera library one major version
behind it, so this pairing is a standing compatibility risk that phase 03 verifies by building rather
than by assuming — the acceptance criteria include a Gradle build for that reason. Vision-camera 4.7.3
(November 2025) receives no further releases, so a future SDK bump may force the migration this ADR
defers; the trigger for revisiting is v5 shipping Android object output, and the record to update is
this one. The pin is exact so that a routine `pnpm update` cannot quietly cross the major boundary and
delete the barcode path.

**Status.** Accepted 2026-07-29. The compatibility risk in the paragraph above was weighed and taken
knowingly, against the alternatives: a frame processor is forbidden outright, `expo-camera`'s
`onBarcodeScanned` would abandon the mechanism the specification names, and waiting on v5 would block
phase 04 on another project's schedule. `expo-camera` remains the fallback if v4 ever stops building.

---

## ADR-20 — A capture group has one anchor row, and the Library's filters read the group

**Context.** Phase 05 records the two on-device runs of one capture against the **uploaded** row, with
`inputVariant` naming which pixels were read — the original is archived in the background and does not
always exist, so it cannot be the row an attempt hangs off
([ADR-2](#adr-2--the-on-device-path-runs-against-both-image-variants),
[ADR-3](#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid)).

Phase 06 has to re-run methods over stored images, and that raises two questions the specification does
not cover. Which row does a Library re-run record against? And when the Library filters on "has any
method been run against this", is "this" a row or a capture?

**Decision.**

- Every capture group has one **anchor row**: its `upload` variant, or the only row present if the
  archive never ran. Every attempt for the group is recorded against the anchor, whichever variant's
  pixels were read, exactly as phase 05 already does.
- `hasAttempts` and `hasDate` are evaluated **per capture group**, by joining `attempts.captureGroupId`
  rather than `attempts.imageId`.

**Rationale.** Recording a re-run against whichever row it happened to read would scatter one
`(method, inputVariant)` group across two rows: half the `mlkit`/`original` runs would sit on the
uploaded row because phase 05 put them there, and half on the original row because a re-run read it. The
detail view would then show a median over half the runs, on two different screens, with nothing saying
either figure was partial. The grouping is the comparison this harness exists to make, and it has to be
one group.

The filters follow from that. Attempts do not hang off the original row, so a per-row reading of "has
been run" would answer *no* for every archived original — and `hasAttempts=false`, the filter whose
whole purpose is finding packaging still to benchmark, would return mostly rows that have already been
benchmarked twice.

**Consequences.** The Library's detail view is per capture group rather than per row: it shows the
variant that was tapped, offers both as run targets, and reads and writes attempts against the anchor.
It says so on screen when the two differ, so the row an attempt landed on is never a surprise in the
export.

**This narrows acceptance criterion 3 of [phase 06](phases/06-library.md) as written.** The document
says `hasAttempts=false` returns "exactly the images with zero attempt rows"; under this decision it
returns exactly the images whose **capture group** has zero attempt rows, which differs precisely for an
archived original whose group has been run. The phase document has been updated to match, and the
server test asserting it names this ADR. If the per-row reading is what was wanted, this decision is
withdrawn — but then the `variant=original` view of the Library has no usable "not yet run" filter, and
`attempts.captureGroupId` loses the reason it was denormalised in the first place.

**Status.** Proposed.
