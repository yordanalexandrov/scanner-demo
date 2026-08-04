# scanner-demo

A **benchmark harness**, not a product.

`scanner-demo` exists to answer two questions about real supermarket packaging, with numbers rather than
impressions:

1. How fast is on-device EAN-13 barcode scanning?
2. How do four different expiry-date extraction methods compare in **accuracy, latency and cost**?

| Method | Where it runs |
|---|---|
| On-device | ML Kit Text Recognition v2, on the phone |
| Self-hosted | RapidOCR (PaddleOCR ONNX models) in a sidecar container |
| Google Vision | Cloud Vision `DOCUMENT_TEXT_DETECTION` |
| VLM | OpenAI, behind a swappable provider interface |

Every design decision serves *measurement and fair comparison*. Where polish and comparability conflict,
comparability wins.

## Status

**All ten phases are implemented.** Every record the harness stores is defined once in
`packages/shared`. The server is deployed at `scanner.yo-po.eu`, stores, serves and thumbnails images,
and records barcode decode latencies. The Android app builds as an Expo development build, navigates
its screens, scans EAN-13 with the decode latency measured on the phone's monotonic clock, and
photographs an expiry date, stores it in two variants, reads both with on-device ML Kit and extracts
the date with the one shared parser. The image library browses everything the server holds and re-runs
any method over any stored image, so an engine is measured against packaging already collected rather
than re-shot for it.

**All four methods are wired** — on-device ML Kit, the self-hosted RapidOCR sidecar, Google Cloud
Vision and a VLM behind a swappable provider interface — all returning the same `OcrResponse` and
parsed by the same code. History puts them side by side per source image, with a per-method summary and
a JSON export of the full rows behind it.

Read [How to read these numbers](#how-to-read-these-numbers) before drawing a conclusion from any
figure here. See [`docs/phases/README.md`](docs/phases/README.md) for the build order.

## The self-hosted engine

RapidOCR — PaddleOCR's models converted to ONNX — in a sidecar container next to the server, reached
over HTTP on an internal Docker network with no published ports. `POST /api/v1/ocr/local` takes an
image ID; the server builds the path, reads the bytes and posts them.

**Models.** The image's own defaults, restated explicitly in
[`deploy/rapidocr/config.yaml`](deploy/rapidocr/config.yaml) so a future image that quietly ships
something else shows up as a difference rather than as noise:

| Stage | Model | Variant |
|---|---|---|
| Detection | `ch_PP-OCRv4_det_infer.onnx` | mobile |
| Classification | `ch_ppocr_mobile_v2.0_cls_infer.onnx` | mobile |
| Recognition | `ch_PP-OCRv4_rec_infer.onnx` | mobile |

The mobile variants are chosen over the server ones deliberately. The server models were measured on
hardware that could hold them and are **30–150× slower for no accuracy gain on dates**; they also do
not fit the box. The Cyrillic recognition model is reachable by configuration alone but is
*measurably worse at this job* — 1 of 10 images against 7 of 10, and the one is wrong — so
`onnx-paddleocr-cyrillic` is deferred rather than built ([ADR-12](docs/decisions.md)). The full
measurement is in [the stage A spike](docs/spikes/07-ocr-sidecar.md).

**What `engineMs` means on this path, and what it does not.** The container reports no duration of
its own — the library measures detection, classification and recognition separately and the API
wrapper discards all three — and no alternative image reports one either. So `engineMs` here is the
Fastify handler's own measurement of **the whole HTTP call to the sidecar**, and every response says
so in `engineMsScope: "inference+network"`.

The consequence has to be read carefully: **`serverTotalMs - engineMs` is not the process boundary.**
The boundary is *inside* `engineMs` and cannot be separated from it. What the difference measures is
the handler's own work outside the call — the row read, the file read, the response. The result view
labels it that way rather than as a boundary cost. Comparing `engineMs` against ML Kit's, which is
`"inference"` and excludes any transport, is comparing two different quantities unless the scope is
shown alongside — which is why every chart of it must ([ADR-10](docs/decisions.md)).

**Latency.** Cold start is reported separately because the server warms the engine with one dummy
image at boot, so no real measurement pays it:

| Figure | Deployment box (2 cores, shared) | Workstation (32 cores, `cpus: 1.5`) |
|---|---|---|
| Cold start, first real request | **3.516 s** | 769 ms |
| Warm median | **1.879 s** | 506 ms |
| Spread, IQR ÷ median | **9.4 % (n=20)** | 12.5 % (n=20) |

The box figures are the phase 07 stage B run of 2026-08-03, on `94530004`, under the co-tenancy
[ADR-18](docs/decisions.md) describes — two cores shared with a live Supabase stack and two
production sites, both answering 200 throughout. They land within 1.4 % of the stage A spike's
independent 1.854 s, measured three days earlier by a different harness. The cold figure is the
startup warm-up's own first inference, which is where it is meant to be paid.

The workstation figures are the same code on a 32-core machine with the same `cpus: 1.5` and
`mem_limit: 1g`, over a synthetic dated image. They are quoted to show the shape holds on other
hardware. **Only the box figures are the benchmark**, and moving the engine elsewhere would also
break `costEstimateUsd: 0`, which ADR-11 justifies as sunk VPS capacity.

Under load — the ten library images back to back — the sidecar peaked at **149.9 % CPU against its
150 % cap** and **648 MiB against its 1 GiB limit**, and all eight production containers stayed as
they were.

**Accuracy on the deployed path: 7 of 10 images parse to a date**, all by `sole-candidate`, which is
the same seven, the same dates and the same three misses the stage A spike recorded under
`parser-v2`. Read that figure with the three qualifications below — it is 2 of 5 by distinct
product, and 0 of 3 on dot-matrix dates.

**The warm-up only warms the size it used.** Cold start is per input size as well as per process, so
the dummy image is the 1200×1600 upload variant the app actually produces. A Library re-run over an
archived full-resolution original still pays a one-off cost that no warm-up removes.

**Calls to the engine are serialised, one at a time.** Two simultaneous requests were measured at
4.5 s and 4.1 s against 1.9 s solo — worse than queueing, because both inferences then fight over
the same 1.5 CPUs. An `engineMs` inflated by contention is indistinguishable in the data from a slow
engine, so the server queues instead. Time spent waiting for the queue lands in `serverTotalMs`,
never in `engineMs`, and a request whose phone hangs up is cancelled rather than left running.

**A sidecar restart bypasses the warm-up, and nothing detects it.** Warm-up runs when the *server*
starts. If the sidecar restarts on its own — `docker compose restart ocr`, or an OOM kill after a
large original — the next real request pays the model load and records 3–4× the steady-state figure
as though it were steady state. The container exposes no uptime or readiness signal that would let
the server notice, so this is documented rather than defended against: **after restarting the
sidecar alone, restart the server too**, or discard the first measurement that follows.

**Memory has less headroom than the upload path suggests.** Peak resident memory, measured per input
size with a restart between:

| Input | Peak (`VmHWM`) | Against `mem_limit: 1g` |
|---|---|---|
| 1200×1600 upload variant, 33 KB | 615 MiB | 60 % |
| 6000×4500 original, 16 MB | **929 MiB** | **91 %** |

`MAX_UPLOAD_BYTES` allows 32 MB, so an original larger than the one measured could exceed the limit
and have the container OOM-killed mid-benchmark. RapidOCR clamps the long side to 2000 px internally,
so the *inference* is bounded; the spike is the full-size decode ahead of it. Re-running the
`original` variant through this engine is safe for the images collected so far and is not safe by
construction.

## Google Cloud Vision

`DOCUMENT_TEXT_DETECTION`, called from the server and only from the server. `POST /api/v1/ocr/gcv`
takes an image ID; the server builds the path, reads the bytes and sends them. **The app holds no
Google credential**, which is the whole reason the engine lives on that side — this repository is
public and a key compiled into an APK comes back out with `strings`.

**The model is pinned.** Vision accepts `builtin/stable`, `builtin/latest` and, for text detection,
`builtin/weekly`. This harness pins `builtin/stable` and records it in the engine string as
`gcv:builtin/stable`, for the same reason the VLM path records its model: a stored record that says
only "GCV" stops being interpretable the moment Google moves its default on. The pin lives in code
rather than in an environment variable, because it is also half of the price-table key — changing it
has to be a change that brings the matching price with it ([ADR-11](docs/decisions.md)).

**Latency**, measured from the deployment box on 2026-08-03, twenty consecutive calls on image
`94530004` — the same image and the same method phase 07 used, so the two are comparable:

| Figure | Cloud Vision | Self-hosted sidecar |
|---|---|---|
| Cold, first call of a process | **1.870 s** | 3.516 s |
| Warm median | **266.5 ms** | 1.879 s |
| Spread, IQR ÷ median | **12.9 % (n=20)** | 9.4 % (n=20) |

Across 29 *different* Library images the median was 270.9 ms (p25 236.7, p75 301.7, min 85.1 on an
image with no text at all, max 411.9). `serverTotalMs` ran 7.4 ms above `engineMs` at the median —
that is the handler's own work, not a process boundary, for the reason stated below.

**Cloud Vision has a cold start too, and nothing warms it.** The first call of a server process pays
an OAuth token fetch and a TLS handshake — 1.870 s against a 266.5 ms warm median, measured
immediately after a restart, with the second and third calls at 338 ms and 288 ms. It lands inside
`engineMs`, because `engineMs` is the whole call. Unlike the sidecar, which the server warms at boot
with a dummy inference, **the first Vision measurement after every deploy is roughly seven times the
truth** and has to be discarded or attributed. A warm-up that only fetched the token would cost
nothing and is not implemented.

**Cost.** $1.50 per 1000 images, so `costEstimateUsd` is **$0.0015** per attempt, read from the
shared price table at `pricingVersion: 2026-08-03` from
[Google's pricing page](https://cloud.google.com/vision/pricing) on that date.

> **The displayed cost will not match the billing console at benchmark volumes, and that is
> deliberate.** The first 1000 units a month are free; the estimate ignores free tiers because it
> answers "what would this cost at scale", which is the decision this benchmark informs
> ([ADR-11](docs/decisions.md)). At 24 images a run the console reads $0.00 and this column does not.

**What `engineMs` means on this path.** The SDK exposes no way to separate Google's inference from
the round trip to it, so `engineMs` is the whole call and every response says so in
`engineMsScope: "inference+network"` — the same scope the sidecar reports, for a different reason.
**Network latency from the Hetzner box to Google's endpoint is inside that figure and cannot be
taken out of it.** Any chart placing this bar next to the sidecar's is comparing a transatlantic
round trip against a container on the same host unless it says so; against ML Kit's `"inference"`,
which excludes transport entirely, it is not comparable at all ([ADR-10](docs/decisions.md)).

A retry counts as one call. The SDK retries `UNAVAILABLE` and `DEADLINE_EXCEEDED` internally, and
`GCV_TIMEOUT_MS` is passed as the total deadline across those attempts — so a retried call takes
longer and is recorded as a single `engineMs`, backoff included. Failures are recorded rather than
hidden: a missing or rejected credential produces an attempt row with `error` set, never an empty
success, and a call that outlives the deadline is recorded as a timeout rather than as a slow read.

**The key file is checked before the SDK is reached, and it is the only credential source.**
`@google-cloud/vision` 5.3.7 answers a missing key file, or an absent Application Default
Credential, by rejecting the call *and* leaving a floating promise rejection behind — which Node 22
turns into an uncaught exception, so the server would answer the request and then exit. The engine
therefore requires `GOOGLE_APPLICATION_CREDENTIALS` and reads the file itself first, which is what
makes "a bad credential is a recorded attempt, not an outage" true rather than hoped for. The cost
is that credentials from a metadata server or a `gcloud` login are not supported; this deployment
mounts a key file and has neither.

**Confidence is read at block level and only at block level.** Vision reports one at block,
paragraph, word and symbol granularity; mixing them between images would produce a column that
cannot be compared with itself. Its blocks are the granularity ML Kit's wrapper reports, so the
parser sees the same shape from both.

**Accuracy: 21 of 29 Library images parse to a date**, scored with the shared parser and each
image's own `capturedAt` as `referenceDate`. The interesting part is not the count but the route:
**17 of the 21 arrive by `anchor-proximity`**, against 3 by `sole-candidate` and 1 by
`latest-of-pair`. This is the first engine in the harness that reads the Bulgarian anchor —
`Годен до: 07/2027` came back verbatim at confidence 0.984 — so the parser reaches the date by
recognising what the package says rather than by finding the only date-shaped string on it. On the
same packaging ML Kit reads `fogeH A0:` and the sidecar's Chinese/English models do no better.

On the **10 images all three methods have run**, however, the counts are identical — **6 of 10
each** — and reading them as a tie would be a mistake in the other direction:

- Cloud Vision and the sidecar agree on 4, each reads 2 the other cannot, and they never disagree on
  a date they both read.
- One of ML Kit's six is *wrong*: on `deb27c57` it reports `2026-09-30` where both server engines
  report `2025-06-30` — the upside-down `30.06.25` recorded under Known limitations below. A count
  of extractions is not a count of correct extractions.

Boxes were checked by eye against the source image on the same date: 16 blocks over a 1200×1600
capture, each landing on its text, including the rotated and inverted labels around the packaging
graphic, whose axis-aligned boxes are correspondingly larger than the glyphs they contain. Vision's
reported page size matched the stored file exactly, so the EXIF-rotation case the adapter guards
against did not arise on this image.

## How to read these numbers

The History screen and the JSON export are where the four methods finally sit side by side. Everything
below is a caveat that **actually applies to these figures**, not a general disclaimer. A reader who
skips it will draw conclusions the data does not support.

**`engineMs` is not one quantity across the four methods.** Every response declares
`engineMsScope`, and the export carries it on every row, because the figure means different things:

| Method | `engineMsScope` | What is inside the number |
|---|---|---|
| ML Kit, on-device | `inference` | Recognition only. No transport of any kind. |
| Self-hosted sidecar | `inference+network` | The whole HTTP call to a container on the same host. The process boundary is inside it and cannot be separated out. |
| Cloud Vision | `inference+network` | The whole call, **including the round trip from Hetzner to Google**. |
| VLM | `inference+network` | The whole call, including the round trip to OpenAI. |

Placing the sidecar's bar next to Cloud Vision's compares a container on the same machine against a
transatlantic request. Placing either next to ML Kit's compares a network-inclusive figure against one
that excludes transport entirely. Both comparisons are legitimate — they are what a deployment would
actually pay — but only if the scope is shown ([ADR-10](docs/decisions.md)).

**Gallery imports have no capture latency, and `null` is not `0`.** A gallery image was not shot under
conditions this harness set: there is no `captureMs`, and `downscaleMs`/`uploadMs` describe an import
rather than a capture. History therefore **refuses to show a capture-cost figure until `source` is
filtered to Camera or Gallery**, and says so instead of averaging the two. Any figure computed from the
export has to do the same. Every absent measurement in the export is `null`, never `0`, for exactly
this reason: a zero would enter an average and drag it.

**Capture cost sits outside every method total.** `totalMs` starts at the method invocation, not at the
shutter ([ADR-22](docs/decisions.md)). The capture is paid once per photograph and read by all four
methods, so charging it to each of them would make the only local method look like the slowest. Its
segments are stored and reported beside the total, never summed into it.

**A median below about five runs is not a distribution.** History prints the run count next to every
median and flags cohorts under five. Medians rather than means throughout: a thermally throttled decode
or a single retry is a long tail on one side, and a mean reports that tail as the typical case.

**Cold start is reported separately, and one engine has no warm-up at all.** The sidecar is warmed with
a dummy inference when the *server* boots, so no real measurement pays the model load — but restarting
the sidecar alone bypasses that, and nothing detects it. Cloud Vision pays an OAuth fetch and a TLS
handshake on the first call of a process, about seven times its warm median, and nothing warms it. **The
first Vision measurement after every deploy is not a measurement.**

**The server figures come from a two-core box shared with a live application.** Absolute latencies from
this harness are not portable to other hardware. What stays valid is the comparison between the four
methods, since all four were measured under the same conditions — with one asymmetry that has to be
named: **local contention affects the self-hosted sidecar and not the cloud engines, which slightly
flatters GCV and the VLM against it** ([ADR-18](docs/decisions.md),
[`docs/deployment-target.md`](docs/deployment-target.md)).

**No median may span a `timingVersion`, a `parserVersion`, an engine or a prompt.** These are four
independent axes and each one changes what a number means:

- `timingVersion` — where `totalMs` starts. `shutter-v1` rows include the operator staring at the
  screen; `method-v2` rows do not ([ADR-22](docs/decisions.md)).
- `parserVersion` — the extraction rules. An accuracy figure is a statement about an engine *and* a
  parser together ([ADR-21](docs/decisions.md), [ADR-23](docs/decisions.md)).
- The engine string, which carries the model. One `method` can be several models, and the VLM's differ
  by more than 4× in latency ([ADR-24](docs/decisions.md)).
- `promptVersion`, on the VLM, which changes results the way a model change does.

History splits into labelled cohorts on all four rather than combining them, and the export carries all
four on every row so the same split is reproducible outside the app.

**Extraction rate counts an expired date as a success.** The engine read the date correctly and the
product is old; scoring that as a failure would penalise whichever engine reads best on a dataset shot
from real packaging ([ADR-7](docs/decisions.md)). It is also **not** an accuracy rate: it counts dates
extracted, not dates extracted *correctly*. On the ten images all three methods had run in phase 08, one
of ML Kit's six extractions was wrong. Scoring correctness needs a hand-made key against the export.

**Costs ignore free tiers, and an unknown cost is `unpriced`, never `$0.00`.** The estimate answers "what
would this cost at scale", which is the decision this benchmark informs, so the billing console will read
$0.00 at benchmark volumes while the cost column does not. A price the table has no figure for shows as
unpriced and is counted separately rather than folded in as free ([ADR-11](docs/decisions.md)).

**There is no leaderboard, on screen or here.** The caveats above are not comparable enough for a single
ranking to be honest. The figures are reported with their conditions and the reader draws the conclusion.

### The JSON export

History's export button writes the **full rows** for the current filters — raw OCR text verbatim, every
candidate the parser considered and why it was rejected, `engineMsScope`, `referenceDate`, and the
pricing, parser and timing versions on every row. A summary can be recomputed from the rows; the rows
cannot be recovered from a summary. Barcode scans travel in their own `barcodeScans` array and never in
`attempts` ([ADR-1](docs/decisions.md)); they are always the whole recorded set, because none of the
attempt filters applies to them.

The export always writes a copy inside the app's own storage and offers to copy it to a folder of your
choosing through Android's Storage Access Framework. Both are optional to use and neither needs a
rebuilt development client.

Re-validate a file and recompute its headline figures from it:

```bash
pnpm --filter @scanner-demo/server verify:export ~/Downloads/scanner-demo-2026-08-04T09-12-33.json
```

That parses the file against the shared zod schemas, checks every row carries the fields that make it
interpretable later, checks the barcode separation, and prints the median latency per method, variant
and semantics. **It computes each median twice** — once through the shared `groupAttempts` the screen
calls, once through a longhand implementation that owes it nothing — and fails on a disagreement.
Running only the first would prove that the shared function agrees with itself.

## Layout

```
scanner-demo/
├── app/                 # React Native (Expo dev build, Android only)
├── server/              # Fastify + TypeScript: image store, OCR engines, benchmark records
├── packages/
│   └── shared/          # Types, zod schemas, and the date parser — used by BOTH app and server
├── docs/
├── docker-compose.yml
└── README.md
```

`packages/shared` is load-bearing, not decorative. The `OcrResponse` shape, the zod validation schemas and
the date parser exist **once** and are imported by both sides, so on-device and server results are parsed
by literally the same code. Any accuracy difference between methods is therefore attributable to the OCR,
not to parsing.

## Development

Node 22 (see [`.nvmrc`](.nvmrc)) and pnpm, pinned by `packageManager` in the root `package.json`.

```bash
pnpm install
pnpm -r build       # packages/shared → ESM + CJS + .d.ts
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

`pnpm -r build` runs before typechecking `app/` or `server/`: both resolve the shared package through its
`dist` output, so it has to exist first. CI orders the steps the same way.

Copy `app/.env.example` → `app/.env` and `server/.env.example` → `server/.env` and fill them in. Both
`.env` files are gitignored.

The pre-commit hook scans staged changes with [gitleaks](https://github.com/gitleaks/gitleaks) and
**fails if gitleaks is not installed**, rather than passing quietly — a scanner that silently does nothing
is worse than no scanner. Version 8.19 or newer is required; it introduced `gitleaks git`, which replaced
`gitleaks protect`:

```bash
curl -sL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  | tar -xz -C /tmp gitleaks && install -m 0755 /tmp/gitleaks ~/.local/bin/gitleaks
```

Coding agents: start with [`AGENTS.md`](AGENTS.md).

## Documentation

| Document | What it is |
|---|---|
| [`docs/scanner-demo-claude-code-prompt.md`](docs/scanner-demo-claude-code-prompt.md) | The original specification. Source of truth. |
| [`docs/phases/README.md`](docs/phases/README.md) | Phase index, dependency graph, requirement coverage matrix. |
| [`docs/phases/NN-*.md`](docs/phases/) | One document per phase: scope, deliverables, acceptance criteria. |
| [`docs/decisions.md`](docs/decisions.md) | Architecture decision records — every judgement call the spec left open. |
| [`docs/deployment-target.md`](docs/deployment-target.md) | The server this runs on, and what its constraints mean for the numbers. |
| [`AGENTS.md`](AGENTS.md) | Working instructions for coding agents. `CLAUDE.md` is a symlink to it. |

## Known limitations

These are properties of the methods being measured, not bugs. They are recorded here because they affect
how the benchmark numbers should be read.

- **ML Kit Text Recognition v2 does not support Cyrillic.** It handles Latin, Chinese, Devanagari,
  Japanese and Korean. The digits of a date read fine, but Bulgarian anchor words
  (`Годен до`, `Срок на годност`) will never be recognised on the on-device path. The server-side
  engines all handle Cyrillic. **Confirmed on real packaging in phase 05:** `Годен до:` came back as
  `fogeH A0:`, `ogeH Ao:` and `T ogeH 0:` across three captures, with the digits after it intact every
  time. The consequence is not a failure to extract but a change of decision path — the parser reaches
  the date through `sole-candidate` rather than `anchor-proximity`, because the anchor is unreadable.
  Any accuracy comparison involving the on-device path on Bulgarian packaging has to split by `rule`,
  or it is comparing two different rules and calling the difference OCR.
- **The self-hosted engine's default models are Chinese + English.** Cyrillic recognition is
  reachable by configuration alone — three environment variables and a mounted `.onnx` — and was
  measured to be *worse*: 1 of 10 images against 7 of 10 for the stock models, and the one it read
  was wrong. It mangles digits, and digits are the entire measurement. So the Bulgarian anchor words
  are unreadable on this path too, exactly as on the on-device one, and for the same practical
  consequence: the parser reaches the date by `sole-candidate` rather than `anchor-proximity`. See
  [ADR-12](docs/decisions.md) and [the spike](docs/spikes/07-ocr-sidecar.md).
- **No CPU OCR engine tested reads dot-matrix dates.** RapidOCR mobile, RapidOCR server, PaddleOCR
  server and Tesseract with Bulgarian language data all read **0 of 3** inkjet dot-matrix date codes,
  while reading continuous-glyph prints cleanly. Dot-matrix is how expiry dates are actually applied
  to food packaging — stamped on the line, not printed with the artwork — so the figure that predicts
  real-world behaviour is that 0 of 3, not the 7 of 10 headline. Hardware does not move it; a GPU
  might, and the engine that reads dot-matrix by context is a VLM, which phase 09 measures.
- **The accuracy figures rest on too small a dataset.** Widened on 2026-08-03 from ten photographs of
  five products to twenty-four; still small enough that it compares engines on identical inputs
  rather than supporting an accuracy rate.
- **Packaging that prints a day and a month but no year yields no date at all** — on every method,
  since [ADR-23](docs/decisions.md). The parser used to supply the year, and the rule was removed
  after it turned a misread stamp into a confident wrong answer: ML Kit read an upside-down `30.06.25`
  as `30.09`, and the parser reported `2026-09-30` as a `day`-precision, `valid` date for a product
  that had expired the previous year. A guessed year was indistinguishable in the record from a read
  one. The loss of coverage is real and accepted: such a package does not state an expiry year.
- **Two engines can disagree on the same pixels, and the disagreement is structural.** On that stamp
  the self-hosted engine was right and ML Kit was wrong, because RapidOCR's pipeline includes a
  180-degree text-angle classifier and an upside-down `6` is a `9` without one. Dot-matrix dates are
  frequently stamped at whatever orientation the packaging line applies them.
- **Gallery imports have no controlled capture conditions.** Their results are valid for comparing OCR
  accuracy and meaningless for comparing capture latency. The History and Library screens filter on
  this so the two never land in the same average silently.
- **Only the first barcode decode of a session is a decode latency.** Every later one is measured from
  the previous decode, which bounds it below by the 800 ms dedupe window and above by how fast a person
  moves the phone to the next package. In the phase 04 run, 54 such readings had a median of 832.3 ms —
  that is the dedupe window, not the scanner. The screen flags the first reading of each session; a
  figure taken from the export has to be attributed by session before it means anything. See
  [phase 04](docs/phases/04-barcode.md).
- **Barcode decode latency is not recorded with its ambient conditions.** Lighting, the angle the phone
  is held at and the handset's thermal state dominate it, and none of the three is captured. `device` is
  stored on every row so that runs on different handsets are never averaged together, but two runs on the
  same phone under different lighting are not distinguishable in the data. Quote these figures with the
  conditions they were taken under.
- **The barcode scanner produced silent misreads at 5.4% in the one run measured.** Three of 56 scans
  returned a corrupted version of the barcode in front of the lens, each differing only in the leading
  digits and each carrying a **valid EAN-13 check digit** — so no validation downstream can reject them.
  The analysis stream runs at 640×480 rather than the specified 720p, because vision-camera 4.7.3 does
  not pass the camera format to the code scanner's image analysis; whether that, or focus, or motion blur
  is the cause is an open question recorded in [phase 04](docs/phases/04-barcode.md). Barcode *values*
  from this harness should not be treated as reliable identifiers. Goal 1 measures decode speed, which
  this does not invalidate.
- **A background upload can make the next measured upload look faster.** Phase 05 archives the
  full-resolution original after the measured upload finishes. Switching that archive off made the
  following capture's `uploadMs` about 10% *slower*, reproducibly, across a three-run A-B-A on Wi-Fi —
  most likely because the large transfer keeps the radio awake and its rate adaptation high. Nothing
  overlaps the measured window; the effect lands on the capture after it. Any latency figure that
  spans the network carries this, so runs being compared have to share the same background-traffic
  pattern. See [phase 05](docs/phases/05-capture-mlkit.md).
- **The server runs on two cores shared with a live application.** Absolute latencies are therefore not
  portable to other hardware. What stays valid is the comparison between the four methods, since all four
  are measured under the same conditions — and local contention slightly flatters the cloud engines
  against the self-hosted one. See [`docs/deployment-target.md`](docs/deployment-target.md).

## Security

The repository is public and API keys compiled into an APK are extractable with `strings`. Therefore the
app holds **zero** provider credentials: Google Cloud Vision and the VLM are called only from the server,
which reads keys from environment variables. The app authenticates to the server with a single shared
bearer token from `app/.env` (gitignored; see `.env.example`). A pre-commit hook and a CI job fail if
anything resembling a key is staged.

The bearer token is itself extractable from the APK, for exactly the reason above — it is bundled at build
time. It is deliberately not treated as a secret: it is a coarse gate on a personal benchmark server, it
is rotatable, and it is used nowhere else. The point of the design is that losing it exposes a box of
photographs of yoghurt lids, not a billable API account.

## License

MIT — see [LICENSE](LICENSE).
