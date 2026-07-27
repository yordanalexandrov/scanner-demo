# Phase 02 — Server: image store, health, deployment

**Status:** not started · **Depends on:** 01 · **Source:** spec milestone 2

## Goal

A deployed Fastify server that accepts an image with its capture metadata, stores it durably, serves it
and a generated thumbnail back — the dataset that every later engine phase measures against.

## Scope

1. Fastify + TypeScript strict; zod validation on every request and response, using the schemas from
   `packages/shared`. — *spec § Stack — Server*
2. SQLite via `better-sqlite3` with Drizzle ORM and checked-in migrations. Tables: `images`.
   — *spec § Stack — Server*
3. `POST /api/v1/images` — multipart: the file plus the capture metadata **only the client knows**
   (`variant`, `source`, `captureGroupId`, `torch`, `captureWidth/Height`, `downscaled`, `capturedAt`,
   `capturedAtSource`). `width`, `height`, `bytes` and `mimeType` are derived server-side from the bytes
   with `sharp` and never accepted from the client, so the recorded metadata stays verifiable. Returns
   `{ imageId }`.
   — *spec § Server API*, [ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid)
4. `GET /api/v1/images` — paginated, newest first, filterable by `source`, `variant`, date range.
5. `GET /api/v1/images/:id` — serve the stored image.
6. `GET /api/v1/images/:id/thumb` — serve a thumbnail generated server-side with `sharp` on first request
   and cached on disk. — *spec § Image library*
7. `GET /api/v1/health` — the only unauthenticated route.
8. Bearer-token auth as a Fastify plugin applied globally, with `/health` explicitly exempt. The token
   comes from the server's environment. — *spec § Hard constraint: no secrets in the app*
9. **Path safety.** The file path is constructed from the image ID by the server; a client-supplied path
   never reaches a filesystem call. The resolved path is verified to stay inside the image directory
   before any read. — *spec § Stack — Server*
10. `sharp` for all decoding, resizing and normalisation. No pure-JS image libraries anywhere on this
    path. — *spec § Stack — Server*
11. Docker Compose with `node:22-slim`, a named volume for the image directory, and Caddy in front for
    automatic TLS on `scanner.yo-po.eu`. — *spec § Stack — Server*
12. Timings use the shared helpers from `packages/shared/src/timing.ts`, which wrap
    `process.hrtime.bigint()` on this side. `Date.now()` appears only in stored wall-clock timestamps.
    — [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)

## Out of scope

- Any OCR. The `/api/v1/ocr/*` routes do not exist yet. Phases 07–09.
- The OCR sidecar container, the internal network and the shared read-only volume mount. Phase 07 — but
  the image directory is created here as a **named volume** so phase 07 can mount it without moving data.
- `attempts` table and endpoints. Phase 05.
- `barcode_scans` table and endpoints. Phase 04.
- Deleting images. There is no delete endpoint: the dataset is append-only, matching the "re-running is
  always additive" principle.

## Deliverables

```
server/
├── package.json
├── Dockerfile                     # node:22-slim
├── drizzle.config.ts
├── drizzle/                       # generated migrations, committed
└── src/
    ├── index.ts                   # server bootstrap, graceful shutdown
    ├── env.ts                     # zod-validated environment
    ├── db/
    │   ├── client.ts
    │   └── schema.ts              # Drizzle tables mirroring packages/shared
    ├── plugins/
    │   ├── auth.ts                # bearer, /health exempt
    │   └── multipart.ts
    ├── routes/
    │   ├── health.ts
    │   └── images.ts
    └── lib/
        ├── imagePaths.ts          # id → path, with containment check
        └── thumbnails.ts          # sharp, cached
docker-compose.yml
Caddyfile
```

## Key decisions

[ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication)

## Interfaces

```
POST /api/v1/images
  multipart/form-data: file=<binary>, meta=<json: the client-known subset of imageRecordSchema —
    variant, source, captureGroupId, torch, captureWidth, captureHeight, downscaled,
    capturedAt, capturedAtSource>
  → 201 { imageId: string }

GET  /api/v1/images?limit&cursor&source&variant&from&to
  → 200 { items: ImageRecord[], nextCursor: string | null }

GET  /api/v1/images/:id        → 200, Content-Type from the stored mimeType
GET  /api/v1/images/:id/thumb  → 200 image/jpeg   (long edge 320px)
GET  /api/v1/health            → 200 { ok: true, version: string, uptimeMs: number }
```

Uploads are stored byte-for-byte as received and served back with their recorded `mimeType`: a gallery
original may be PNG or HEIC, and transcoding it would destroy the very bytes the dataset exists to
preserve. Thumbnails are always JPEG, because they are derived artefacts.

Environment (`server/.env.example`): `PORT`, `API_TOKEN`, `IMAGE_DIR`, `DB_PATH`, `THUMB_DIR`.

## Acceptance criteria

1. `docker compose up` brings up the server and Caddy; `curl https://scanner.yo-po.eu/api/v1/health`
   returns 200 over TLS with a valid certificate.
2. Any authenticated route without a bearer token returns 401; `/health` without one returns 200.
3. Uploading an image returns an ID; the file exists in the volume; `GET /api/v1/images/:id` returns
   identical bytes (verify with `sha256sum` on both sides).
4. `GET /api/v1/images/:id/thumb` returns an image whose long edge is 320px, and the second request is
   served from the disk cache (verify by timing, or by the cache file's mtime not changing).
5. **Path traversal is refused.** `GET /api/v1/images/..%2F..%2Fetc%2Fpasswd` and an upload whose metadata
   contains a path both return 400 and touch no file outside `IMAGE_DIR`.
6. Two uploads sharing a `captureGroupId` with `variant` `upload` and `original` are both listed, and
   filtering by `variant=upload` returns only one.
7. The container restarts with the volume intact: images and database survive `docker compose down && up`.
8. `grep -rn 'Date.now()' server/src` shows only timestamp assignments, never a subtraction.

## Risks / unknowns

- **Open question for the owner:** is there SSH access to the Hetzner box, does `scanner.yo-po.eu`
  already resolve to it, and who runs the deploy? Caddy cannot issue a certificate until DNS points at
  the machine. Until answered, this phase can be finished and verified locally with a self-signed
  Caddy config, but its acceptance criteria 1 is not met.
- `better-sqlite3` is a native module: the Docker build needs build tooling present, or a prebuilt binary
  matching `node:22-slim`. Check this early — it is the usual cause of a broken first image build.
- File ownership in the volume matters later: phase 07 mounts it read-only into the sidecar, so the UID
  the server writes as must be readable there. Decide the UID here rather than discovering it in phase 07.

## Review checkpoint

Show: a photo uploaded from `curl`, listed, fetched back byte-identical, thumbnailed; a 401 without a
token; a refused traversal attempt; and the whole thing running under Compose behind Caddy with real TLS.
