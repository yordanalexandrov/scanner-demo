# Phase 05 — Expiry capture, on-device OCR, and the date parser

**Status:** in review — code complete, **nothing run on a device yet** · **Depends on:** 03, 04 ·
**Source:** spec milestone 5

## Goal

Capture or import a photo of packaging, store it on the server as part of the test dataset, read it with
on-device ML Kit, and parse the date with the one shared parser — the first end-to-end measurement, and
the reference implementation every later engine plugs into.

## Scope

### Capture screen — deliberately a different camera configuration from phase 04

1. A **separate screen and separate component tree** from the barcode screen. No shared camera component.
   — *spec § Screens — Expiry date capture*
2. Single `takePhoto()` at **maximum available resolution**.
3. Tap-to-focus with **focus lock** applied before the shutter, so autofocus does not hunt during capture.
4. Torch defaults to **ON** — embossed and laser-etched dates are the hard case.
5. On-screen framing guide.
6. No conversion of camera frames to Bitmap anywhere. — *spec § Gotchas*

### Storage and the dataset

7. Client-side downscale to ~1600px on the long edge, JPEG quality 80, **configurable** so the trade-off
   can be measured. — *spec § Gotchas*
8. The downscaled variant is uploaded immediately; this upload is the measured one. Photos are **not**
   persisted in the phone's gallery or app storage — only a cached thumbnail for the UI.
   — *spec § Screens — Expiry date capture*
9. The full-resolution original is archived in the background **after** the measured path completes,
   behind `EXPO_PUBLIC_ARCHIVE_ORIGINAL` (default on), sharing a `captureGroupId` with the upload.
   — [ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid)
10. **Import from gallery** via `expo-image-picker`. Imported photos go through the same upload-and-store
    path with `source: "gallery"`, `torch: null` and no capture-latency figures. `capturedAt` comes from
    the file's EXIF `DateTimeOriginal` where present and from the import time otherwise, recorded in
    `capturedAtSource` — it is the parser's `referenceDate` and therefore decides `valid` versus
    `expired`. — *spec § Screens — Expiry date capture*,
    [ADR-6](../decisions.md#adr-6--parser-rule-order-and-referencedate)

### On-device OCR

11. `@react-native-ml-kit/text-recognition` for the on-device path.
12. It runs **twice** per capture — over the full-resolution original and over the downscaled upload
    buffer — recorded as two attempts distinguished by `inputVariant`.
    — [ADR-2](../decisions.md#adr-2--the-on-device-path-runs-against-both-image-variants)
13. Its adapter produces a standard `OcrResponse`: blocks with boxes, `confidence: null` if the wrapper
    does not report one, `engineMsScope: "inference"`, `costEstimateUsd: 0`.
    — [ADR-5](../decisions.md#adr-5--bbox-format-and-confidence-nullability)

### The shared date parser

14. `packages/shared/src/dateParser.ts` with unit tests, imported by both app and server so exactly one
    implementation exists. — *spec § Date parsing*
15. Anchors, formats, rule order, `referenceDate`, expired handling, month precision, month-name locales
    and separator normalisation per
    [ADR-6](../decisions.md#adr-6--parser-rule-order-and-referencedate),
    [ADR-7](../decisions.md#adr-7--expired-dates-are-flagged-not-discarded),
    [ADR-8](../decisions.md#adr-8--month-only-dates-resolve-to-the-last-day-with-a-precision-field),
    [ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy),
    [ADR-16](../decisions.md#adr-16--separators-and-year-widths-are-normalised-before-matching).
16. The parser always runs on the phone, for every method.
    — [ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows)

### Recording and viewing

17. `attempts` table, migration, `POST /api/v1/attempts`, `GET /api/v1/images/:id/attempts`.
18. **Four separate buttons**, run one at a time, each showing its own result. The three server buttons
    are present but disabled with a note naming the phase that enables them. **No "run all" button** on
    this screen. — *spec § Screens — Expiry date capture*
19. Result view (spec screen 5): method, the latency breakdown, raw OCR text verbatim and scrollable, the
    parsed date or an explicit failure, confidence where reported, estimated cost.

## Out of scope

- The three server engines themselves. Phases 07, 08, 09.
- The Library and re-runs. Phase 06.
- History and export. Phase 10.
- "Run all methods" — deliberately withheld until the methods have been evaluated separately. It appears
  once, in the Library, in phase 06.

## Deliverables

```
packages/shared/src/
├── dateParser.ts
└── dateParser.test.ts
app/src/
├── screens/CaptureScreen.tsx           # replaces the phase 03 placeholder
├── screens/ResultScreen.tsx
├── components/FramingGuide.tsx
├── components/MethodButtons.tsx
├── components/LatencyBreakdown.tsx
├── lib/
│   ├── downscale.ts                    # configurable long edge + quality, timed
│   ├── mlkit.ts                        # ML Kit → OcrResponse adapter
│   └── runMethod.ts                    # orchestrates: OCR → parse → post attempt
└── api/{images,attempts}.ts
server/src/routes/attempts.ts
server/src/db/schema.ts                 # + attempts
```

## Key decisions

[ADR-2](../decisions.md#adr-2--the-on-device-path-runs-against-both-image-variants) ·
[ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid) ·
[ADR-4](../decisions.md#adr-4--bbox-is-nullable-and-the-parser-records-which-rule-decided) ·
[ADR-5](../decisions.md#adr-5--bbox-format-and-confidence-nullability) ·
[ADR-6](../decisions.md#adr-6--parser-rule-order-and-referencedate) ·
[ADR-7](../decisions.md#adr-7--expired-dates-are-flagged-not-discarded) ·
[ADR-8](../decisions.md#adr-8--month-only-dates-resolve-to-the-last-day-with-a-precision-field) ·
[ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy) ·
[ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows) ·
[ADR-16](../decisions.md#adr-16--separators-and-year-widths-are-normalised-before-matching)

## Interfaces

```ts
// packages/shared/src/dateParser.ts — the single implementation, used by both sides
export function parseExpiryDate(
  blocks: Block[],
  opts: { referenceDate: Date }
): ParseResult;
```

```
POST /api/v1/attempts                 Attempt (minus id/createdAt) → 201 { id }
GET  /api/v1/images/:id/attempts      → 200 { items: Attempt[] }
```

`attemptSchema` is deeply nested, and phase 06 needs to filter on fields inside it. The table is therefore
**hybrid**: the columns that get filtered, sorted or aggregated are flattened and indexed, and the full
payload is kept as JSON so nothing is lost.

```
attempts
  id               text primary key
  imageId          text not null references images(id)
  captureGroupId   text not null
  method           text not null      -- indexed
  inputVariant     text not null      -- indexed; (method, inputVariant) is the grouping key
  engine           text not null      -- full string incl. model
  device           text not null
  expiryDate       text               -- null when nothing parsed; indexed for the hasDate filter
  expiryStatus     text               -- "valid" | "expired"
  expiryPrecision  text               -- "day" | "month"
  parseRule        text not null
  totalMs          real not null      -- indexed for median queries
  engineMs         real
  costEstimateUsd  real               -- null while the price is unfilled
  referenceDate    text not null
  pricingVersion   text not null
  promptVersion    text
  error            text
  ocrJson          text not null      -- the full OcrResponse
  parseJson        text               -- the full ParseResult
  vlmJson          text               -- model answer + reasoning
  timingJson       text not null      -- the full Timing
  createdAt        integer not null   -- indexed
```

Flattened columns are **derived from the JSON on write**, never edited independently — the JSON is the
record, the columns are its index.

Environment added to `app/.env.example`: `EXPO_PUBLIC_DOWNSCALE_LONG_EDGE` (default 1600),
`EXPO_PUBLIC_DOWNSCALE_QUALITY` (default 80), `EXPO_PUBLIC_ARCHIVE_ORIGINAL` (default true).

## Acceptance criteria

### Capture

1. Torch is on when the screen opens, without interaction.
2. Tapping to focus locks focus; the subsequent `takePhoto()` shows no visible focus hunt. Verify by
   capturing a close-up embossed date ten times and confirming no frame-to-frame refocus.
3. The captured image's dimensions equal the device's maximum photo resolution, recorded in
   `captureWidth`/`captureHeight`.
4. Once the capture flow has settled, no full-size photo remains in the phone's gallery or in the app's
   document and cache directories — only the cached thumbnail. The temporary file `takePhoto()` writes is
   deleted after the upload, and after the background archive when that is enabled. Verify by listing the
   media store and both app directories after the flow completes, not during it.
5. A gallery import produces a stored image with `source: "gallery"`, `torch: null`, and null capture
   latency — and is visibly labelled as such in the UI.
6. Two images with one `captureGroupId` exist on the server after a camera capture with
   `ARCHIVE_ORIGINAL=true`; with it false, exactly one.
7. The archive never overlaps the measured window. Two checks: in the server access log, the archive
   request's start is after the measured upload's response was sent; and over ten captures each way, the
   median `uploadMs` with `ARCHIVE_ORIGINAL` on differs from the median with it off by **less than 5%**.

### Parser

8. `pnpm --filter @scanner-demo/shared test` passes with at least these cases, all pinned to
   `referenceDate = 2025-06-01`:

   | Input text | Expected |
   |---|---|
   | `EXP 12.03.2027` | `2027-03-12`, precision `day`, status `valid` |
   | `BEST BEFORE 05 MAR 2027` | `2027-03-05` |
   | `MHD 31.12.25` | `2025-12-31` — two-digit year, dotted separator ([ADR-16](../decisions.md#adr-16--separators-and-year-widths-are-normalised-before-matching)) |
   | `MHD 31/12/2025` | the same date as the row above — separator and year width must not change the result |
   | `DLC 01/03/27` | `2027-03-01` — three components are always `DD/MM/YY`, `ambiguous: false` |
   | `Годен до 03/2027` | `2027-03-31`, precision `month`, signal `month-precision-only` |
   | `EXP 03/27` | `2027-03-31` — the second component exceeds 12, so it is the year: `MM/YY` |
   | `EXP 25/03` | `2026-03-25` — the first component exceeds 12, so it is the day; the year is the next occurrence after `referenceDate` |
   | `EXP 05/12` | both components ≤ 12 → `2025-12-05` as `DD/MM`, `ambiguous: true`, confidence lowered — the `MM/YY` reading (May 2012) falls outside the sanity window |
   | `L4471 15.01.2024 20.01.2026` (no anchor) | expiry `2026-01-20`, production `2024-01-15`, rule `latest-of-pair` |
   | `311225` | `2025-12-31` from `DDMMYY` |
   | `EXP 01.06.2024` | status `expired`, date still returned ([ADR-7](../decisions.md#adr-7--expired-dates-are-flagged-not-discarded)) |
   | `EXP 01.06.2045` | discarded, listed in `candidates` with `rejectedFor` |
   | text with no date | `expiry: null`, `rule: "none"` — an explicit failure, not a guess |

9. With boxes present and an anchor nearby, `rule` is `anchor-proximity`; with `bbox: null` on every
   block, the same text still parses via `latest-of-pair` or `sole-candidate` and `rule` reflects it.
10. Exactly one date-parsing implementation exists:
    `grep -rn 'function parseExpiryDate' packages/shared/src app/src server/src` returns exactly one line,
    and it is in `packages/shared/src/dateParser.ts`.

### On-device and recording

11. One capture produces **two** on-device attempts, `inputVariant` `original` and `upload`, both
    retrievable from `GET /api/v1/images/:id/attempts`.
12. The result view shows the raw text verbatim (including line breaks), the latency breakdown with
    `null` segments rendered as "n/a" rather than `0`, and cost `0.00` for the on-device method.
13. A method that fails records an attempt with `error` set and `ocr: null` — a failure is data, not a
    silent gap.
14. There is no "run all" control on this screen.

## Risks / unknowns

- Whether the ML Kit wrapper exposes a per-block confidence.
  **Answered: it does not.** `@react-native-ml-kit/text-recognition@2.0.0` gives every `TextBlock` a
  `text`, an optional `frame`, its `lines` and its `recognizedLanguages`, and nothing else. Every block
  therefore carries `confidence: null`, and the result view shows "not reported" rather than a number —
  ADR-5 stands as written and no consumer needs changing, because `null` was already handled.
- **`focus()` is not a focus lock.** vision-camera 4.7.3 builds its `FocusMeteringAction` without
  `disableAutoCancel()` (`CameraSession+Focus.kt:14`), so CameraX cancels the action after five seconds
  and returns to continuous autofocus. Acceptance criterion 2 asks for a lock. What is implemented
  instead: the shutter re-focuses at the last tapped point and awaits it whenever that window has
  lapsed, so the capture never begins mid-hunt. That satisfies "no visible focus hunt" without being
  the lock the wording implies, and the difference is only observable if a tap is followed by a wait of
  more than five seconds.
- **`expo-audio`'s config plugin adds `RECORD_AUDIO` by default**, for a recording API this app never
  touches. It is blocked in `app.json`; the merged manifest of a debug build was checked to confirm the
  permission is absent. Worth re-checking whenever a dependency that ships a config plugin is added.
- ML Kit does not read Cyrillic, so the `Годен до` parser case is exercised only by unit tests and, later,
  by the server engines. This is a property of the method; the README already records it.
- The full-resolution ML Kit run may be slow enough on older devices to be worth its own note in the
  README. That is a finding, not a problem.
- Bulgarian packaging frequently prints the date with no anchor at all, which means rule 2 will carry more
  weight than the specification's ordering implies. Worth checking against the first fifty real images.
- **Untested on hardware.** `@react-native-ml-kit/text-recognition@2.0.0` is an old-architecture
  `NativeModules` package, and this app runs on the New Architecture in bridgeless mode. The debug APK
  compiles and links it, but whether the interop layer resolves it at runtime is only answerable on a
  device. If it does not, the options are an Expo-compatible fork or a small native module of our own —
  neither of which is visible from here.
- Two columns of the `attempts` table are nullable where the table above writes them `not null`:
  `engine` and `parseRule` are derived from `ocr` and `parse`, both of which are null on a failed run.
  Acceptance criterion 13 requires that run to be recorded, so a `not null` column would make a failure
  unstorable. A failure is data.

## Review checkpoint

Show: a capture with torch on and focus locked; the two stored variants; two on-device attempts from one
capture; the parser's test suite green with the table above; the result view with a real raw-text dump;
and a gallery import correctly labelled and excluded from capture-latency figures.
