# Phase 08 — Google Cloud Vision engine

**Status:** complete · **Depends on:** 06, 07 · **Source:** spec milestone 8

## Goal

The third of four methods: Google Cloud Vision `DOCUMENT_TEXT_DETECTION`, called only from the server,
returning the same `OcrResponse` shape as every other engine.

## Scope

1. `@google-cloud/vision` in the server, using `DOCUMENT_TEXT_DETECTION`. — *spec § Screens — Expiry date capture*
2. Credentials from environment variables on the server. The app never holds them; this is the whole
   reason the engine lives here. — *spec § Hard constraint: no secrets in the app*
3. `POST /api/v1/ocr/gcv` — `{ imageId }` → `OcrResponse`, implementing the same `OcrEngine` interface
   introduced in phase 07.
4. Adapter mapping Vision's response to `blocks`: GCV reports bounding polygons per block, paragraph and
   word — normalise to `[x, y, w, h]` in pixels of the processed image, with `imageWidth`/`imageHeight`
   recorded alongside. — [ADR-5](../decisions.md#adr-5--bbox-format-and-confidence-nullability)
5. `engineMsScope: "inference+network"` — the SDK exposes no way to separate Google's inference time from
   the round trip, and pretending otherwise would make this number look comparable with the sidecar's
   when it is not. — [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
6. `costEstimateUsd` from the shared price table, with the GCV entry filled in from Google's published
   pricing page and its source URL and retrieval date recorded.
   — [ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table)
7. Explicit request timeout, and errors surfaced as a recorded attempt with `error` set rather than a
   silent failure.
8. **The model is pinned, not left to the default.** Vision's `Feature.model` accepts `builtin/stable`,
   `builtin/latest` and — for text detection — `builtin/weekly`. Pin `builtin/stable` and record it in the
   engine string as `gcv:builtin/stable`, for the same reason the VLM path records its model: old
   benchmark records must stay interpretable when the provider moves on.

## Out of scope

- Any client-side Google credential, SDK or direct call. Permanently.
- Cropping, region hints or preprocessing tuned for Vision specifically. Every engine sees the same bytes,
  or the comparison is not a comparison.
- Batch or async Vision APIs. One image, one synchronous call, like the other engines.

## Deliverables

```
server/src/engines/gcv.ts
server/src/routes/ocr.ts             # + POST /api/v1/ocr/gcv
server/.env.example                  # + GOOGLE_APPLICATION_CREDENTIALS / GCV_* variables
packages/shared/src/pricing.ts       # + real GCV price, source URL, retrieval date
app/src/components/MethodButtons.tsx # Google Vision button enabled
README.md                            # + note on GCV model versioning
```

## Key decisions

[ADR-5](../decisions.md#adr-5--bbox-format-and-confidence-nullability) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table)

## Interfaces

```
POST /api/v1/ocr/gcv   { imageId } → OcrResponse
```

Implements `OcrEngine` from `server/src/engines/types.ts` — no new abstraction is introduced.

## Acceptance criteria

1. `POST /api/v1/ocr/gcv` returns an `OcrResponse` that validates against the zod schema, with non-empty
   `blocks` on a legible image.
2. Boxes are in pixels of the processed image and land on the right text — verify by drawing two or three
   returned boxes over the source image and checking them by eye.
3. `engineMsScope` is `"inference+network"` in every response.
4. `costEstimateUsd` is non-zero and consistent with the price table; `pricingVersion` is recorded on the
   attempt.
5. The price table entry carries a source URL and a retrieval date, and the figure matches that page on
   that date.
6. Missing or invalid credentials produce a clear server-side error and an attempt row with `error` set —
   never a crash and never an empty success.
7. A forced timeout produces a recorded failure within the configured limit.
8. No Google credential or SDK exists in the app: `grep -rniE 'AIza|service_account|private_key|@google-cloud' app/src app/app.json`
   finds nothing, and `@google-cloud/vision` is absent from `app/package.json`. (The string "Google
   Vision" legitimately appears as a button label, so the check targets credential and SDK shapes rather
   than the word.)
9. Run over images already in the Library — Cyrillic packaging included, since unlike the on-device path
   this engine reads it.
10. The same image run through GCV twice produces two attempt rows, per the additive rule.

## Risks / unknowns

- GCV's free tier makes early ad-hoc calls cost nothing, which can mask a pricing mistake. The estimate
  deliberately ignores free tiers (ADR-11), so the displayed cost will not match the billing console at
  low volume — this is intended and should be stated in the README.
- Network latency from the Hetzner box to Google's endpoint is a fixed component of `engineMs` here and
  will dominate the sidecar comparison. The README must present GCV's figure with that caveat attached.
- Vision returns confidences at several granularities; pick one level (block) and record it consistently,
  rather than mixing levels between images.

## Review checkpoint

Show: GCV run against several existing Library images including Bulgarian packaging, boxes verified
visually, cost and pricing version recorded, a credential failure handled as a recorded error, and the
side-by-side comparison with the on-device and self-hosted attempts on the same image.

## The acceptance run, 2026-08-03

Run against the real API from the deployment box, over the Library as it stood: 29 `upload` images,
plus twenty consecutive calls on `94530004` for the latency figures.

| Criterion | State |
|---|---|
| 1 · `OcrResponse` validates, non-empty `blocks` | **met** — 29 of 29 answered 200, which is the response schema passing the server's own serializer; 28 returned blocks, the 29th is an 8 KB image with no text |
| 2 · boxes land on the right text | **met** — 16 boxes drawn over `94530004` and checked by eye; each on its text, including the rotated and inverted labels, whose axis-aligned boxes are larger than the glyphs as ADR-5 accepts. Vision's page size matched the stored file, so the EXIF case did not arise |
| 3 · `engineMsScope` is `"inference+network"` | **met** on every response |
| 4 · `costEstimateUsd` non-zero, `pricingVersion` recorded | **met** — `0.0015` and `2026-08-03` in the response and on both attempt rows the handset wrote |
| 5 · price entry carries source and retrieval date | **met** — `packages/shared/src/pricing.ts` |
| 6 · bad credentials become a recorded error | **met, twice over.** A missing key file produced `502 engine_failed` naming the path, with the server still serving; billing disabled on the project produced `502` carrying Google's own sentence. Neither killed the process, which is not free — see the departure below |
| 7 · forced timeout is a recorded failure | **met** — `GCV_TIMEOUT_MS=1` produced `504 engine_timeout`, "Cloud Vision did not answer within 1 ms" |
| 8 · no Google credential or SDK in the app | **met** — the criterion's grep finds nothing; `@google-cloud/vision` is in `server/package.json` only |
| 9 · run over Library images, Cyrillic included | **met** — 21 of 29 parse a date, 17 of them by `anchor-proximity` because this is the first engine that reads `Годен до` (confidence 0.984), and the handset run reproduced it on the recorded rows |
| 10 · two runs, two attempt rows | **met** — two runs on `94530004` produced two rows under one `gcv · upload` group with a median across them, nothing overwritten |

**Latency**, twenty calls on `94530004`: warm median **266.5 ms**, IQR ÷ median **12.9 %**, min
228.3, max 333.4. `serverTotalMs` sat 7.4 ms above `engineMs` at the median. The sidecar's figure on
the same image is 1.879 s, so Vision is about seven times faster **with a transatlantic round trip
inside the number** — which is what `inference+network` means and why the README says so next to it.

**Accuracy is not the headline; the decision path is.** On the 10 images all three methods have run,
each extracts 6 — but Vision and the sidecar agree on 4, each reads 2 the other cannot, they never
disagree on a date they both read, and one of ML Kit's six is the known upside-down misread. What
changes with this engine is that 17 of its 21 extractions come through the anchor rather than
through "the only date-shaped string on the package".

**A cold start exists here too, and nothing warms it.** The first call of a server process took
1.870 s against the 266.5 ms warm median, with the second and third at 338 ms and 288 ms — an OAuth
token fetch and a TLS handshake, inside `engineMs` because `engineMs` is the whole call. The sidecar
is warmed at boot for exactly this reason; Vision is not, so the first measurement after every
deploy is roughly 7× the truth. A token-only warm-up would cost no billed unit and is **not**
implemented — recorded here rather than done, because it is a change to how the harness measures and
belongs to a checkpoint of its own.

Production was checked before and after: the eight `garden-prod_supabase-*` containers unchanged,
`emerald`, `garden` and `scanner` all 200.

### The handset half, same day

On an SM-S928B (Android 16) against the deployed box, two Library re-runs of `gcv` on `94530004`:

- **Two rows under one `gcv · upload` group**, `2 of 2 extracted a date`, median method total 551.0 ms
  and median engine 315.7 ms across them. Nothing was overwritten — the additive rule holds on this
  method as it does on the others.
- **The segments nest the way ADR-10 requires**: `engineMs` 298.3 inside `serverTotalMs` 311 inside
  the phone's `requestMs` 536 inside `totalMs` 538.1. The sidecar's equivalent row reads 1836.4 /
  1848.4 / 2106.0, so the ~225 ms the phone spends outside the server is the handset-to-box leg on
  both paths and is not subtracted from anything - it is two stored fields.
- **`captureMs`, `downscaleMs` and `downloadMs` are all `null`, not `0`.** A re-run captured nothing
  and uploaded nothing, and unlike ML Kit this engine needs no pixels on the handset, so no download
  happened either.
- `costEstimateUsd` `0.0015` and `pricingVersion` `2026-08-03` on both rows.
- Both reached `2027-07-31 valid · month` **by `anchor-proximity`**, confidence 0.9 with signals
  `anchor-matched` and `month-precision-only`. The same screen shows ML Kit reaching the same date on
  the same image by `sole-candidate`, which is the side-by-side this checkpoint asks for: identical
  answer, different route, because only one of the two can read the words next to the date.

Deliberate departures from the phase document, both recorded in the code that makes them:

- **`@google-cloud/vision`'s `annotateImage` helper is bypassed for `batchAnnotateImages` with one
  request** — which is precisely what the helper does internally. Its type signature accepts no call
  options, and item 7's explicit timeout is not worth giving up for a tidier call. This is not the
  batch API the **Out of scope** list excludes: one image, one synchronous call.
- **The model pin is a constant, not an environment variable.** It is half of the engine string and
  therefore of the price-table key, so changing it has to be a code change that brings the matching
  price with it — otherwise a deployment can silently produce attempts whose cost is unknown.
- **`GOOGLE_APPLICATION_CREDENTIALS` is the only credential source, and it is checked before the SDK
  is touched.** Criterion 6 asks for "never a crash", and the SDK does not give that for free:
  measured against `@google-cloud/vision` 5.3.7 on Node 22, a missing key file and an absent default
  credential each reject the call **and leave a second, floating rejection**, which Node's default
  turns into an uncaught exception — the server would answer the request and then die. A key file
  whose *contents* are wrong rejects once, normally, and is left to the SDK. The cost is that
  Application Default Credentials from a metadata server or a `gcloud` login are not supported;
  this deployment mounts a key file and has neither.
