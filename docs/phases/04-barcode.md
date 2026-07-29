# Phase 04 — Barcode scan screen

**Status:** in review · **Depends on:** 03 · **Source:** spec milestone 4

## Goal

Answer goal 1 of the project with a recorded number: how many milliseconds pass between the scan screen
being ready and an EAN-13 being decoded, on real packaging, measured repeatedly.

## Scope

1. `react-native-vision-camera` v4 with the built-in `useCodeScanner` hook, restricted to **EAN-13 only**.
   No other formats. — *spec § Screens — Barcode scan*
2. **No frame processors and no worklets.** — *spec § Stack — App*
3. No conversion of camera frames to Bitmap anywhere on this screen either — the constraint applies to
   every camera path, not only to the capture screen. — *spec § Gotchas*
4. **The camera session opens on screen mount, not on a button press.** This is the single biggest
   latency factor and must not regress; it is an explicit acceptance criterion below.
   — *spec § Screens — Barcode scan*
5. Continuous scanning: the camera is never unmounted or restarted between reads. A hit may freeze the
   preview visually, but the pipeline keeps running. — *spec § Screens — Barcode scan*
6. 720p analysis stream. **Not achieved — see _Measured on device_ below.** `useCameraFormat` is applied
   and the format is passed to `<Camera>`, but vision-camera 4.7.3 builds the code scanner's
   `ImageAnalysis` with no resolution selector at all
   (`CameraSession+Configuration.kt:223`, `val analyzer = ImageAnalysis.Builder().build()`), unlike the
   neighbouring path a dozen lines above it. CameraX therefore picks its own default and the stream runs
   at 640×480. The screen reports the resolution the scanner itself hands back, so the figure on the
   device is the measured one, not the one that was asked for.
7. Torch toggle.
8. Haptic feedback (`react-native-haptic-feedback`) and a short beep (`expo-audio`) the instant a code is
   decoded — fired before any rendering work, so neither is delayed by a re-render.
9. Dedupe: the same value is ignored for 800 ms.
10. Result card showing the decoded value and **decode latency in ms**, measured from screen-ready to the
    scanner callback with the shared timing helpers.
    — [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
11. Each scan is posted to the server and persisted.
    — [ADR-1](../decisions.md#adr-1--barcode-measurements-are-persisted-server-side)
12. A list on the screen of scans recorded in **this session**, plus that session's running median, so a
    single outlier is visibly an outlier rather than "the number".
13. Server side: `barcode_scans` table, migration, and the two endpoints.

## Out of scope

- Any relationship between a barcode and a stored image. They are separate measurements; a scanned EAN-13
  is not attached to a photo.
- Product lookup of any kind. The harness measures decode speed, not catalogue data.
- Sharing any component with the capture screen of phase 05. The two camera configurations conflict, and
  merging them is explicitly forbidden by the specification.

## Deliverables

```
app/src/screens/BarcodeScreen.tsx        # replaces the phase 03 placeholder
app/src/components/BarcodeResultCard.tsx
app/src/hooks/useScreenReadyClock.ts     # marks t0 the moment the camera reports ready
app/src/hooks/useIsForeground.ts         # the other half of isActive, alongside screen focus
app/src/api/barcodeScans.ts
app/src/device.ts                        # model + Android version, recorded on every row
app/src/format.ts                        # a duration for reading; null renders "n/a", never "0 ms"
app/src/assets.d.ts                      # typing for the asset import below
app/assets/beep.wav                      # 70 ms generated tone, 1800 Hz, mono 16-bit PCM
packages/shared/src/stats.ts             # median, so History and the export agree with this screen
packages/shared/src/schemas/api.ts       # + the barcode-scan request and listing contracts
server/src/routes/barcodeScans.ts
server/src/db/schema.ts                  # + barcode_scans
server/drizzle/                          # + migration
```

`median` lives in `packages/shared` rather than in the screen that first needed it, for the reason the
rest of that package exists: History and the JSON export in phase 10 report the same statistic, and two
implementations of "the middle value" would disagree on even-length sets.

## Key decisions

[ADR-1](../decisions.md#adr-1--barcode-measurements-are-persisted-server-side) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)

## Interfaces

```
POST /api/v1/barcode-scans   { value, decodeMs, device } → 201 { id }
GET  /api/v1/barcode-scans?limit&cursor → 200 { items: BarcodeScan[], nextCursor: string | null }
```

`decodeMs` is defined precisely: `t_callback - t_scannerReady`, both from `performance.now()` on the
phone. It is **not** measured from navigation start, because that would fold navigation animation into a
camera number.

`t_scannerReady` is the moment the camera reports it is running for the **first** reading of a session,
and the instant the previous scan was recorded for every reading after it.

> **Amended during phase 04, accepted at the review.** The original wording was
> `t_callback - t_screenReady` with a single fixed origin. That cannot hold together with scope items 5
> and 12 and acceptance criteria 4 and 7: the camera is never restarted between reads, so against a fixed
> origin the second scan of a session would report the first scan's latency plus everything since, the
> tenth would report the length of the whole session, and the median would describe how long the screen
> had been open rather than how fast it decodes. Re-arming is the smallest change that keeps every other
> requirement of this phase intact.
>
> **Only the first reading of a session is quotable as a decode latency.** Every later one is bounded
> below by the 800 ms dedupe window and above by how fast a person moves the phone to the next package;
> the measurements below show both effects clearly. The behaviour is left as built and carried as a
> documented property rather than redesigned, so the readings that answer acceptance criterion 4 keep
> existing. The screen flags the first reading of each session; the stored row does not, so a figure
> pulled from the export has to be attributed by session before it means anything.

## Measured on device

One run on an `SM-S928B (Android 16)`, 56 recorded scans of three physical products, against a local
server. These are the numbers the review was held on; they belong here because every claim below is a
property of the metric rather than of that particular handset.

| | |
|---|---|
| Camera sessions logged | 3 (`onStarted`); one bout of **38 consecutive scans** ran inside a single session |
| `onStopped` | **never fired** — 0 occurrences across all three sessions |
| Analysis stream | **640×480**, not 720p |
| First reading of a session | 1415.2 ms · 6293.8 ms |
| All later readings (n=54) | median 832.3 ms, min 86.5, max 4944.7; only 9 of 54 below 800 ms |
| Silent misreads | **3 of 56 (5.4%)** |

Where each acceptance criterion stands after that run:

| # | Verified by |
|---|---|
| 1 | On device — value, haptic, beep and a latency figure, on real packaging |
| 2 | **Structurally only.** `codeTypes: ['ean-13']` reaches ML Kit as `setBarcodeFormats(FORMAT_EAN_13)` (`CodeScannerPipeline.kt:25`, `CodeType.kt:29`), so a QR or Code 128 is never decoded rather than decoded and discarded — which is what the criterion asks. Presenting a non-EAN-13 symbol has not been tried on device |
| 3 | On device — the screen showed `live · session 1` with zero scans on arrival, and `isActive` is `isFocused && isForeground` |
| 4 | On device — 38 consecutive scans inside one logged camera session |
| 5 | On device — repeats of one value land at `+0.8 s` intervals throughout the log |
| 6 | On device — 56 rows served by `GET`, having survived a force-stop and relaunch mid-run |
| 7 | On device — the on-screen median matched the listed session scans. See the caveat above on what that number means |
| 8, 9 | `grep`, both empty |

The dedupe window is visible in the raw data as a hard floor: a code held in front of the lens records
at `+0.8 s`, `+0.8 s`, `+0.8 s`, and the median of 832.3 ms is that window rather than a decode time.
Removing the code from frame between scans did not fix it — it moved the median up to 1281.8 ms by adding
the hand movement. Acceptance criterion 4 is satisfied and acceptance criterion 7 is satisfied
arithmetically; the number the median reports is nonetheless not a decode latency.

**The misreads are the more serious finding.** Three of the 56 rows are corrupted reads of
`3800222850028` that differ from it only in the leading three or four digits and match the last eight or
nine exactly — `6260222840028`, `9860022850028`, `8864222850018`. All three carry a **valid EAN-13 check
digit**, so nothing downstream can catch them: the check digit catches every single-digit error but only
about nine in ten multi-digit corruptions. The damage sits in the left half of the symbol, which is where
EAN-13 encodes its first digit as a parity pattern.

## Open questions

Deliberately not answered in this phase, and not blocking it.

- **Does 720p reduce the misread rate?** The resolution and the misreads have not been shown to be
  connected. Patching vision-camera to pass the format to the code scanner's `ImageAnalysis` — the
  neighbouring path already does it — would let the same code be scanned at both resolutions and the
  error rates compared. That comparison is itself worth having.
- **Or is the cause focus rather than resolution?** A barcode read at the wrong focal distance or through
  motion blur fails in the same place, and this screen neither locks focus nor reports focus state. The
  three failures came from one product in one bout, which is equally consistent with one bad angle.
- **Would corroboration make a read trustworthy?** Requiring the same value from three or four
  consecutive reads before accepting it would suppress a corruption that passes its check digit, at the
  cost of a slower and differently-shaped measurement. Recorded here as a candidate, not built.

## Acceptance criteria

1. Scanning a real EAN-13 on supermarket packaging produces a value, a haptic, a beep and a latency
   figure.
2. A non-EAN-13 code (QR, EAN-8, Code 128) is not decoded — the scanner is genuinely format-restricted,
   not filtered after the fact.
3. **The camera is running before any interaction:** navigating to the screen and immediately presenting
   a barcode yields a decode with no button press. Verify structurally too — `<Camera isActive>` is
   derived from screen focus and mount state only, never from a press handler or a piece of state a
   button sets.
4. Scanning ten codes in a row never unmounts or restarts the camera. Verify by logging camera lifecycle
   events and confirming exactly one session for the whole sequence.
5. Presenting the same code twice within 800 ms records one scan; after 800 ms it records two.
6. `GET /api/v1/barcode-scans` returns the scans; they survive an app restart because they live on the
   server.
7. The on-screen median is labelled as covering **this session's** scans and matches the median of exactly
   those scans — not of the full paginated history, which spans sessions and devices.
8. `grep -rn 'Date.now()' app/src/screens/BarcodeScreen.tsx` finds no subtraction.
9. `grep -rniE 'frameProcessor|worklet|Bitmap' app/src` finds nothing.

## Risks / unknowns

- Beep latency: audio playback may add perceptible delay after the callback. It must be fired **after**
  `t_callback` is captured, never before, or it contaminates the measurement.
- Device thermal state and lighting dominate decode latency. `device` is recorded on every row for this
  reason; ambient conditions are not recorded and should be noted in the README when reporting figures.
- The first scan after screen mount includes camera warm-up. Decide during review whether to record it
  separately or discard the first scan of a session — the data will show whether it matters.
  **Answered:** it matters, and the opposite way round to the one the note expected. The first reading is
  the only usable one; see _Measured on device_.
- `onStopped` is never delivered by vision-camera 4.7.3 on Android, so `clock.disarm()` does not run in
  practice and the paired log line never appears. Harmless — `arm()` overwrites the origin on every start
  — but it means camera sessions have to be counted from the `started` log alone.

## Review checkpoint

Show: scanning real packaging with the camera already live on arrival, ten consecutive scans on one
camera session, the dedupe window working, the recorded rows on the server, and the median.
