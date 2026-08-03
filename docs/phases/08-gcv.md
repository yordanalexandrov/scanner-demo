# Phase 08 — Google Cloud Vision engine

**Status:** built, awaiting the acceptance run · **Depends on:** 06, 07 · **Source:** spec milestone 8

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

## Where this stands, 2026-08-03

Everything in **Scope** is implemented and every criterion that can be checked without a Google
credential is checked. **Criteria 1–7, 9 and 10 need a service-account key and a run against the real
API**, which is the owner's to provide — the repository deliberately holds none, and inventing the
numbers would defeat the point of the phase.

| Criterion | State |
|---|---|
| 1 · `OcrResponse` validates, non-empty `blocks` | schema-validated against fixtures in `server/src/engines/gcv.test.ts`; **real image pending** |
| 2 · boxes land on the right text | **pending** — needs the visual check against a real response |
| 3 · `engineMsScope` is `"inference+network"` | asserted in the adapter tests |
| 4 · `costEstimateUsd` non-zero, `pricingVersion` recorded | asserted: `$0.0015`, `2026-08-03` |
| 5 · price entry carries source and retrieval date | in `packages/shared/src/pricing.ts` |
| 6 · bad credentials become a recorded error | asserted at both layers: engine names it, route answers 502 |
| 7 · forced timeout is a recorded failure | asserted: `DEADLINE_EXCEEDED` → `timedOut` → 504 |
| 8 · no Google credential or SDK in the app | verified by the grep in the criterion; `@google-cloud/vision` is in `server/package.json` only |
| 9 · run over Library images, Cyrillic included | **pending** |
| 10 · two runs, two attempt rows | inherited from the additive rule the Library already enforces; **pending on this method** |

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
