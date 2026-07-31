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

**Phases 01 to 06 of 10 are complete. Phase 07 is built and verified off the deployment box; its
acceptance run on the box itself is outstanding**, so it is not counted as complete here — see
[`docs/phases/README.md`](docs/phases/README.md) for exactly which criteria are still open. Every
record the harness stores is defined once in `packages/shared`. The server is deployed at
`scanner.yo-po.eu`, stores, serves and thumbnails images, and records barcode decode latencies. The
Android app builds as an Expo development build, navigates its screens, scans EAN-13 with the decode
latency measured on the phone's monotonic clock, and photographs an expiry date, stores it in two
variants, reads both with on-device ML Kit and extracts the date with the one shared parser. The image
library browses everything the server holds and re-runs any method over any stored image, which is what
makes the two remaining engines cheap to add: they are measured against packaging already collected.
**Two of the four methods are now wired**: on-device ML Kit and the self-hosted RapidOCR sidecar.
See [`docs/phases/README.md`](docs/phases/README.md) for the build order and where the work stands.

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
| Cold start, first real request | 3.4–3.9 s | 769 ms |
| Warm median | 1.854 s | 506 ms |
| Spread, IQR ÷ median | 12.0 % (n=25) | 12.5 % (n=20) |

The box figures come from the stage A spike, under the co-tenancy
[ADR-18](docs/decisions.md) describes — two cores shared with a live Supabase stack and two
production sites. The workstation figures are the phase 07 stage B verification run, on the same
`cpus: 1.5` and `mem_limit: 1g` the box uses, over a synthetic dated image; they are quoted to show
the shape holds, not as a benchmark result. **Only the box figures are the benchmark.**

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
- **The accuracy figures rest on too small a dataset.** Ten photographs of five products, six of them
  the same box. That is enough to compare engines against each other on identical inputs and not
  enough to claim an accuracy rate. Widening it is a prerequisite for phases 08–10 meaning anything.
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
