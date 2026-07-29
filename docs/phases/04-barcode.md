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
6. 720p analysis stream.
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

> **Amended during phase 04, for review.** The original wording was `t_callback - t_screenReady` with a
> single fixed origin. That cannot hold together with scope items 5 and 12 and acceptance criteria 4 and
> 7: the camera is never restarted between reads, so against a fixed origin the second scan of a session
> would report the first scan's latency plus everything since, the tenth would report the length of the
> whole session, and the median would describe how long the screen had been open rather than how fast it
> decodes. Re-arming is the smallest change that keeps every other requirement of this phase intact.
>
> The consequence is deliberate and has to be read alongside the numbers: the **first** reading of a
> session is exactly the figure originally specified, camera warm-up included, while every later reading
> also contains the time the user spent moving the phone to the next package. The screen therefore flags
> the first reading of each session, which is the data the risk note below asks the review to judge.

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

## Review checkpoint

Show: scanning real packaging with the camera already live on arrival, ten consecutive scans on one
camera session, the dedupe window working, the recorded rows on the server, and the median.
