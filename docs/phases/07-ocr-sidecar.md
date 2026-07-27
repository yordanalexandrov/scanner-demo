# Phase 07 — Self-hosted OCR engine (sidecar container)

**Status:** not started · **Depends on:** 02, 06 · **Source:** spec milestone 7

## Goal

A self-hosted OCR engine running as a pre-built sidecar container next to the TypeScript server, reachable
only internally, measured separately from the server that calls it.

**This phase has two stages and a mandatory stop between them.** The spike answers questions that change
how the build-out is written; building first and discovering afterwards is the failure mode this ordering
exists to prevent.

## Scope — stage A: spike (report back before building)

A throwaway investigation whose only deliverable is a written report. Nothing in `server/src` is written
during stage A.

1. Confirm the image and record its **digest**. Default choice: `rapidocr_api` (RapidOCR — PaddleOCR models
   converted to ONNX, actively maintained). `jarvis1tube/paddleocr-server:cpu` is an acceptable
   alternative. `paddlecloud/paddleocr` is **not** an option — roughly three years stale and not an API
   server. — *spec § Stack — Server*
2. **Which input modes does it accept** — a filesystem path, an HTTP upload, or both?
3. **Does it read from the shared volume**, given a path, with the file written by the TS server's UID?
4. **What does one image cost in milliseconds on this box**, CPU-only? Report cold start (first inference,
   models loading) separately from steady state.
5. **What does its response contain** — per-block boxes and confidences, or only flat text? This decides
   whether disambiguation rule 1 can ever fire on this engine.
   — [ADR-4](../decisions.md#adr-4--bbox-is-nullable-and-the-parser-records-which-rule-decided)
6. **Can the recognition model and character dictionary be replaced** through environment variables or a
   mounted path, without opening the container or writing Python inside it? This determines whether the
   self-hosted engine can ever match Bulgarian anchor words.
   — [ADR-12](../decisions.md#adr-12--the-self-hosted-engine-defaults-to-chineseenglish-models)
7. **Which thread/concurrency environment variables does it expose**, so CPU use can be bounded?
8. Whether mobile/lightweight PP-OCR detection and recognition models can be selected over the server
   ones. — *spec § Gotchas*

**Stop here. Report, then continue.**

## Scope — stage B: build-out

9. Compose service for the sidecar, **pinned by digest**, never `:latest`. — *spec § Stack — Server*
10. **Internal-only Docker network with no published ports.** The container is never reachable from
    outside. — *spec § Stack — Server*
11. The image directory is mounted into the sidecar **read-only**, sharing the named volume created in
    phase 02. Where the container accepts a path, pass a path; where it only accepts an upload, upload —
    but the shared volume exists either way, because it removes a pointless read-and-re-encode cycle when
    it can be used. — *spec § Stack — Server*
12. **The control channel stays HTTP.** Filesystem sharing replaces the image payload, not the RPC. No
    file-drop-and-poll pattern: polling adds latency, hides errors and races on partial writes. A normal
    request/response call with an **explicit timeout**. — *spec § Stack — Server*
13. UIDs aligned or the volume made group-readable, so the sidecar can actually read what the TS server
    wrote. — *spec § Stack — Server*
14. CPU and thread use constrained explicitly: `cpus:` in Compose plus whatever thread variable the image
    exposes. Unbounded threading on a small shared VPS makes latency measurements noisy and
    non-reproducible. — *spec § Gotchas*
15. **Warm-up at startup** with a dummy image, so the first real request is not a model load. The
    cold-start figure is reported separately in the README and `engineMs` reflects steady state.
    — *spec § Gotchas*
16. Engine adapter in the TS server behind a clean interface, producing a standard `OcrResponse` with
    `engine: "onnx-paddleocr"` (or `onnx-paddleocr-cyrillic`), `engineMsScope: "inference"`,
    `costEstimateUsd: 0`.
17. `POST /api/v1/ocr/local` — `{ imageId }` → `OcrResponse`. The path is constructed from the image ID by
    the server; a client-supplied path never reaches a filesystem read.
    — *spec § Stack — Server*
18. **The sidecar boundary is measured separately:** `engineMs` is time inside the container as it reports
    it; `serverTotalMs` is wall time inside the Fastify handler. The difference is the process boundary.
    — *spec § Gotchas*, [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
19. **Mobile/lightweight PP-OCR detection and recognition models are selected explicitly**, not left to
    the image's default, wherever the spike showed the choice is available. On printed dates the accuracy
    difference is small and the latency difference is large. The selected model names go in the README.
    — *spec § Gotchas*
20. The "Self-hosted" method button in the app is enabled and wired to this endpoint.

## Out of scope

- Moving OCR in-process with a TypeScript ONNX wrapper (`@gutenye/ocr-node` and similar). Explicitly a
  **possible later optimisation, not now**. The engine stays behind a clean interface so that migration
  would be a one-file change, and because RapidOCR uses the same underlying ONNX models the results would
  stay comparable across it. — *spec § Stack — Server*
- Writing Python anywhere, including inside the container. The image is a black box.
- Any CUDA build. The box is CPU-only.

## Deliverables

```
docs/spikes/07-ocr-sidecar.md       # stage A report — the gate to stage B
docker-compose.yml                  # + sidecar service, internal network, cpus, digest pin
server/src/engines/
├── types.ts                        # OcrEngine interface, shared by phases 07-09
└── localOcr.ts                     # sidecar adapter, explicit timeout
server/src/routes/ocr.ts            # POST /api/v1/ocr/local
server/src/lib/warmup.ts            # dummy-image inference at startup
app/src/components/MethodButtons.tsx  # Self-hosted button enabled
README.md                           # + cold-start figure, model choice and its consequences
```

## Key decisions

[ADR-4](../decisions.md#adr-4--bbox-is-nullable-and-the-parser-records-which-rule-decided) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) ·
[ADR-12](../decisions.md#adr-12--the-self-hosted-engine-defaults-to-chineseenglish-models)

## Interfaces

```ts
// server/src/engines/types.ts — phases 08 and 09 implement this same interface
export interface OcrEngine {
  readonly name: string;
  recognise(input: { imageId: string; path: string }): Promise<OcrResponse>;
}
```

```
POST /api/v1/ocr/local   { imageId } → OcrResponse
```

## Acceptance criteria

### Stage A

1. `docs/spikes/07-ocr-sidecar.md` exists and answers all eight questions above with observed evidence —
   commands run and their output — not with expectations.
2. The report states the image digest, the chosen input mode, and the measured cold and warm timings.
3. It states plainly whether Cyrillic recognition is reachable through configuration alone.

### Stage B

4. `docker compose ps` shows the sidecar with **no published ports**; `curl` to it from the host fails,
   while the TS server reaches it over the internal network.
5. `docker compose config` shows the sidecar pinned by `@sha256:…`, and `grep -n ':latest' docker-compose.yml`
   finds nothing.
6. The sidecar's mount of the image volume is `:ro`; a write attempt from inside the container fails.
7. The sidecar can read a file the TS server just wrote — the UID/permission alignment actually works,
   verified with a real upload rather than a manually placed file.
8. `POST /api/v1/ocr/local` with a valid `imageId` returns a well-formed `OcrResponse` that validates
   against the zod schema.
9. `POST /api/v1/ocr/local` with `{ imageId: "../../etc/passwd" }` returns 400 and touches nothing.
10. A hung sidecar produces a timeout error from the endpoint within the configured limit, not a hanging
    request. Verify by pausing the container (`docker pause`) mid-request.
11. There is no polling loop: `grep -rniE 'setInterval|poll|watch' server/src/engines` finds nothing on
    this path.
12. `engineMs` and `serverTotalMs` are both present and `serverTotalMs > engineMs`; the boundary cost is
    displayed in the result view.
13. Steady state is actually steady: over twenty consecutive requests after warm-up on the same image, the
    interquartile range of `engineMs` is **within 20% of the median**. The first request after a cold
    start is recorded separately and is expected to be several times the warm median; both figures, and
    the run count, go in the README.
14. The selected detection and recognition model names appear in the README, and they are the
    mobile/lightweight variants wherever the spike found that choice available.
15. CPU is bounded: under load, `docker stats` shows the sidecar at or below its `cpus:` limit.
16. The "Self-hosted" button in the app is enabled and produces a recorded attempt.
17. Run against images already in the Library from phases 05–06 — no packaging is re-shot for this phase.

## Risks / unknowns

- Everything the spike exists to resolve. The largest is whether Cyrillic is reachable by configuration;
  if it is not, the self-hosted path is digit-only for Bulgarian packaging and ADR-12 is confirmed as the
  final answer rather than a provisional one.
- The image may report no per-block confidence, in which case ADR-5's `null` applies here too.
- Container clock and the TS server's clock are different processes but the same machine; `engineMs` as
  reported by the container is trusted as a duration, not correlated with server timestamps.

## Review checkpoint

**Two checkpoints.** After stage A: the spike report, and a decision on the model configuration. After
stage B: a working `/api/v1/ocr/local` measured over the existing Library images, the container
unreachable from outside, the boundary cost visible, and the cold-start figure in the README.
