# Claude Code prompt — `scanner-demo`

> **Decisions already made — do not revisit these.**
>
> - **Everything I maintain is TypeScript.** I don't read Python. The one permitted exception is the OCR container described below, which is a pre-built third-party image I treat as a black box and never open. Do not write Python anywhere else, and do not write Python *inside* that container either without asking me first.
> - **Target platform: Android only** for now.
> - **VLM provider: OpenAI**, behind a swappable interface.
> - **Hetzner box: CPU-only**, no GPU. Never install CUDA builds.

---

## Context

I'm building a proof-of-concept mobile app called `scanner-demo`. It is **not a product** — it is a **benchmark harness**. Its whole purpose is to let me measure and compare, on real supermarket packaging:

1. How fast EAN-13 barcode scanning is on-device.
2. How four different expiry-date extraction methods compare in **accuracy, latency and cost**.

Every design decision should serve *measurement and fair comparison*, not polish. Optimise for "I can trust these numbers", not for "this looks nice".

The repo will be **public on GitHub**. All code, comments, commit messages and docs in **English**.

## Repository layout

pnpm workspace monorepo:

```
scanner-demo/
├── app/                 # React Native (Expo, dev build — NOT Expo Go)
├── server/              # Fastify + TypeScript: image store, OCR engines, benchmark records
├── packages/
│   └── shared/          # Types, zod schemas, and the date parser — used by BOTH app and server
├── docs/
├── docker-compose.yml
└── README.md
```

The `shared` package is important and not decorative. The `OcrResponse` shape, the zod validation schemas and the date parser must exist **once** and be imported by both sides. That gives end-to-end type safety and — more importantly for this project — guarantees that on-device and server results are parsed by literally the same code.

## Stack (decided — don't re-litigate)

**App — Android only**
- React Native via Expo with a **development build** (`expo prebuild` + EAS). Expo Go cannot load the native modules we need — do not attempt it.
- Build and test **Android only**. Don't add iOS-specific code paths, don't configure the iOS project, don't debug iOS build issues. Equally: don't hardcode anything that would make adding iOS later painful — keep platform-specific bits behind the normal `Platform` checks and leave it at that. If you find yourself writing Swift, stop.
- `react-native-vision-camera` v4 — use the built-in `useCodeScanner` hook. **Do not write frame processors or worklets.**
- `@react-native-ml-kit/text-recognition` for the on-device OCR path.
- `react-native-haptic-feedback`, React Navigation, TypeScript strict mode.

**Server — Node 22 LTS + TypeScript**
- **Fastify**, TypeScript strict mode, zod for request/response validation.
- **Self-hosted OCR engine: a pre-built OCR container running as a sidecar.** Use `rapidocr_api` (RapidOCR — PaddleOCR models converted to ONNX, actively maintained) as the default. `jarvis1tube/paddleocr-server:cpu` is an acceptable alternative. Do **not** use `paddlecloud/paddleocr` — it has not been updated in about three years and is not an API server. Pin whichever image you use **by digest**, never `:latest`.
- The TS server and the OCR container **share the image directory through a Docker volume.** The TS server already writes every uploaded image to disk, so the OCR sidecar mounts that same directory **read-only** and reads the file directly. Where the container supports being given a path, pass a path; where it only accepts an HTTP upload, upload — but the shared volume must exist either way, because it removes a pointless read-and-re-encode cycle when we can use it.
- **The control channel stays HTTP.** Filesystem sharing replaces the image payload, not the RPC. Do not build a file-drop-and-poll pattern — polling adds latency, hides errors and races on partial writes. A normal request/response call with an explicit timeout is what we want.
- The OCR container sits on an **internal-only Docker network with no published ports.** It is never reachable from outside.
- **The TS server constructs the file path from the image ID itself. A path must never arrive from the client and reach a filesystem read.** Validate that the resolved path stays inside the image directory before use.
- Align the container UIDs or make the volume group-readable, so the sidecar can actually read what the TS server wrote.
- `sharp` for all image decoding, resizing and normalisation. It's native and fast — do not use pure-JS image libraries like jimp for the preprocessing path, they will dominate your latency measurements.
- `@google-cloud/vision` for the GCV engine.
- `openai` for the VLM engine — but implemented against a `VlmProvider` interface (`extract(image: Buffer): Promise<VlmResult>`), with `OpenAiProvider` as the only implementation for now and the provider selected by an env var. I will want to benchmark other providers on the same harness later, so swapping one in must mean adding one file and changing one environment variable — nothing else.
- SQLite via `better-sqlite3` with Drizzle ORM. This is a POC, don't reach for Postgres.
- Caddy in front for automatic TLS on `scanner.yo-po.eu`.
- Docker Compose, `node:22-slim` base image.

**Possible later optimisation, not now:** there are maintained TypeScript wrappers around PaddleOCR ONNX models for Node (`@gutenye/ocr-node` and similar). If the benchmark eventually shows the sidecar's transport or process boundary costs real time, we may move OCR in-process and drop the container. Because RapidOCR uses the same underlying ONNX models, results would stay comparable across that migration. Keep the engine behind a clean interface so this stays a one-file change — but do not attempt it now.

## Hard constraint: no secrets in the app

The repo is public and API keys compiled into an APK are extractable with `strings`. Therefore:

- The app holds **zero** provider credentials.
- Google Cloud Vision and the VLM are called **only from the server**, which reads keys from environment variables.
- The app authenticates to the server with a single shared bearer token from `app/.env` (which is gitignored). Ship a `.env.example`.
- Add a pre-commit hook or CI check that fails if anything resembling a key is staged.

## Screens

### 1. Home
Navigation to the two scan screens plus History. Show the configured server URL and a health-check indicator so I can tell instantly whether the backend is reachable.

### 2. Barcode scan
- `useCodeScanner` restricted to **EAN-13 only** — no other formats.
- **The camera session opens on screen mount, not on a button press.** This is the single biggest latency factor; do not regress it.
- Continuous scanning: never unmount or restart the camera between reads. Freeze the preview visually on a hit if needed, but keep the pipeline running.
- 720p analysis stream is enough here.
- Torch toggle. Haptic + short beep the instant a code is decoded.
- Dedupe: ignore the same value for 800 ms.
- Result card shows: the code, and **decode latency in ms** measured from screen-ready to callback.

### 3. Expiry date capture

Deliberately a **different camera configuration** from screen 2 — do not share a component or try to make one screen serve both. The requirements conflict.

- Single `takePhoto()`, **maximum available resolution**.
- Tap-to-focus with **focus lock** before the shutter; do not let autofocus hunt during capture.
- Torch defaults to ON (embossed and laser-etched dates are the hard case).
- On-screen framing guide.

After capture, the photo is **uploaded to the server immediately and stored there**. Photos are **not** persisted in the phone's gallery or app storage — only a cached thumbnail for the UI. The server-side image store is my test dataset; I want to be able to re-run every method over old photos later without re-shooting them.

Also provide an **"Import from gallery"** button on this screen, using `expo-image-picker`, so I can pull in photos I already took with the normal camera app. Imported photos go through the exact same upload-and-store path and become part of the dataset like any other.

**Record how each image entered the system.** Every stored image needs `source: "camera" | "gallery"` plus the capture settings that applied (resolution, torch on/off, whether client-side downscaling ran, and the resulting dimensions and byte size). Gallery imports have no controlled capture conditions, so their results are valid for comparing *OCR accuracy* but meaningless for comparing *capture latency*. The History and Library screens must let me filter on this — I do not want the two mixed silently in the same average.

Then show **four separate buttons**, each running independently against that same stored image:

| Button | Path |
|---|---|
| **On-device** | ML Kit Text Recognition v2, locally on the phone |
| **Self-hosted** | `POST /api/v1/ocr/local` → OCR sidecar container on my server |
| **Google Vision** | `POST /api/v1/ocr/gcv` → `DOCUMENT_TEXT_DETECTION` |
| **VLM** | `POST /api/v1/ocr/vlm` |

I want to trigger them **one at a time and see each result on its own**. Do not add a "run all" button yet — I'll ask for that later once I've evaluated them separately.

### 4. Image library

A browser over every image stored on the server. This is how I re-run methods without re-shooting anything, and it matters as much as the capture screen does.

- Thumbnail grid, newest first, paginated. Thumbnails are generated server-side — do not download full-resolution images to render a grid.
- Filters: by `source`, by date, by whether any method has been run yet, and by whether a date was successfully extracted.
- Tapping an image opens a detail view showing the full image, its capture metadata, **every attempt ever run against it**, and the same four method buttons so I can run any method again.

**Re-running is always additive.** A new run creates a new attempt row; it never overwrites or replaces an earlier one. This is deliberate and I care about it:

- The VLM is non-deterministic. Running it five times on the same image tells me how stable its answer is, which is something I need to know before trusting it.
- `engineMs` varies with server load. A single measurement is not a latency figure; a distribution is.

So the detail view should group attempts by method and show each individual run plus the median latency per method, rather than collapsing them into one "current result" per method.

Add a **"re-run all methods on this image"** action here — this is the one place a batch action makes sense, because it operates on a fixed stored image rather than on a live capture. It's still four independent calls recorded as four separate attempts, just triggered together.

### 5. Result view
For a single attempt, show:
- Method name
- **Latency, broken down**: capture → upload → OCR → parse → total (ms, monotonic clock)
- Raw OCR text, verbatim, scrollable
- The parsed date, or an explicit failure
- Confidence, where the engine provides one
- Estimated cost of that call

### 6. History
All attempts, **grouped by source image**, so I can see the same photo processed by all four methods side by side. Filter by method. Export everything as JSON. This screen is the actual deliverable of the POC — treat it as such.

## Date parsing — critical for fair comparison

Lives in `packages/shared/src/dateParser.ts`, with unit tests. Imported by both the app and the server so there is exactly one implementation.

Methods 1–3 return raw text and **must all be parsed by this one module**, so any accuracy difference is attributable to the OCR, not to parsing.

The VLM path is different: it returns *both* its own structured answer *and* the raw text it read. **Record both**, and also run the shared parser over its raw text. That tells me how much of the VLM's advantage is better reading versus better interpretation — which is exactly the thing I need to know.

Parser spec:

**Anchors** (case-insensitive): `EXP`, `EXP.`, `BB`, `BBE`, `BEST BEFORE`, `USE BY`, `MHD`, `DLC`, `Годен до`, `Срок на годност`, `Използвай преди`

**Formats:** `DD.MM.YYYY`, `DD/MM/YY`, `DD-MM-YYYY`, `MM.YYYY`, `MM/YY`, `DDMMYY`, `YYYY-MM-DD`, `DD MMM YYYY`

**Disambiguation, in order:**
1. Prefer the date candidate whose bounding box is nearest an anchor. This requires positional data — every engine adapter must return `blocks: [{ text, bbox, confidence }]`, not just a flat string.
2. With no anchor and two candidates: the later date is the expiry, the earlier is production.
3. Discard dates in the past or more than 10 years out.
4. For ambiguous `MM/YY` vs `DD/MM`: if either number exceeds 12 it is the day.

Return a confidence score and always surface it. Never silently guess.

## Server API

```
POST /api/v1/images              multipart → { imageId }
POST /api/v1/ocr/local           { imageId } → OcrResponse
POST /api/v1/ocr/gcv             { imageId } → OcrResponse
POST /api/v1/ocr/vlm             { imageId } → OcrResponse + parsedDate + modelReasoning
GET  /api/v1/images              list stored images, paginated + filterable
GET  /api/v1/images/:id          serve stored image
GET  /api/v1/images/:id/thumb    serve generated thumbnail
GET  /api/v1/images/:id/attempts all attempts recorded against this image
POST /api/v1/attempts            store a benchmark record (incl. on-device results)
GET  /api/v1/attempts            list, filterable by method
GET  /api/v1/health
```

`OcrResponse` is **identical in shape across all engines** — this is what makes the comparison valid. Define it once as a zod schema in `packages/shared` and infer the TS type from it:

```ts
{
  engine: string;          // "onnx-paddleocr" | "gcv" | "vlm:openai/<model>"
  rawText: string;
  blocks: { text: string; bbox: [number, number, number, number]; confidence: number }[];
  engineMs: number;
  costEstimateUsd: number;
}
```

For the VLM path, `engine` must record the **provider and model name**, not just `vlm`. Model versions change and I need old benchmark records to stay interpretable.

Bearer-token auth on everything except `/health`.

## Gotchas — please internalise these, they are not obvious

- **ML Kit Text Recognition v2 does not support Cyrillic.** Latin, Chinese, Devanagari, Japanese and Korean only. The digits of a date will read fine, but Bulgarian anchor words will not be recognised on the on-device path. Do not pretend otherwise in code or docs — note it in the README as a known limitation of that method. The server-side engines all handle Cyrillic.
- Don't convert camera frames to Bitmap anywhere.
- Camera permission handling must be explicit, with a recoverable denied state.
- **Warm the OCR sidecar at startup** with a dummy image. First inference loads the models and is much slower; report the cold-start figure separately in the README and make sure `engineMs` reflects steady state.
- Constrain the sidecar's CPU and thread usage explicitly (`cpus:` in Compose, plus whatever thread env var the image exposes) rather than letting it grab every core. On a small shared VPS, unbounded threading makes latency measurements noisy and non-reproducible.
- Prefer the **mobile/lightweight** PP-OCR detection and recognition models over the server ones where the image lets you choose. On printed dates the accuracy difference is small and the latency difference is large.
- The default models are Chinese + English. If you want Cyrillic recognition, the model has to be selected explicitly — decide this deliberately and note the choice in the README, because it changes which anchor words the parser can ever match.
- **Measure the sidecar boundary separately.** Record the time spent inside the OCR container distinctly from the time the TS server spends calling it, so I can see whether the process boundary costs anything worth removing later.
- Latency must use `process.hrtime.bigint()` / `performance.now()`, never `Date.now()`.
- Downscale and re-encode the image **on the phone before upload** (target roughly 1600px on the long edge, JPEG quality 80). This is the single largest end-to-end latency win available and it barely affects date legibility. Keep it configurable so I can measure the trade-off.

## Build order

Please work through these as separate commits, and stop after each milestone so I can review:

1. Repo scaffold, pnpm workspaces, `packages/shared` with types + zod schemas, README, `.env.example`, CI lint.
2. Server: image upload/store + `/health` + Docker Compose + Caddy for `scanner.yo-po.eu`.
3. App: Expo dev build, navigation, Home screen with health check.
4. Barcode screen, fully working, with latency measurement.
5. Date capture screen + gallery import + upload + on-device ML Kit path + `dateParser.ts` with tests.
6. Image library screen: grid, filters, detail view, re-run. Build this **before** the remaining engines — once it exists, every engine you add afterwards can be tested immediately against the images already collected, instead of you re-shooting packaging for each one.
7. Server: self-hosted OCR engine — OCR sidecar container, shared image volume, internal network, engine adapter in the TS server. **Spike the container first and report back before building it out**: confirm which input modes it accepts (path vs upload), that it reads from the shared volume, and roughly what a single image costs in ms on this box.
8. Server: Google Cloud Vision engine.
9. Server: VLM engine.
10. History screen + JSON export.

Start with milestone 1 and check with me before moving on. If anything above is ambiguous or you think a decision is wrong, say so before writing code rather than picking silently.
