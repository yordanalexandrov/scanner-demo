# Phase 02 — Server: image store, health, deployment

**Status:** complete · **Depends on:** 01 · **Source:** spec milestone 2

Deployed and verified on 2026-07-28. `https://scanner.yo-po.eu` is live behind the nginx vhost with a
Let's Encrypt certificate valid to 2026-10-26, on the certbot timer alongside `emerald` and `garden`.
Deployment steps and rollback: [../../deploy/README.md](../../deploy/README.md).

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
11. Docker Compose (v2) with `node:22-slim` and a named volume for the image directory. The stack
    publishes to **loopback only** — `127.0.0.1:3002` — because the box's ports 80 and 443 belong to a
    production nginx. — *spec § Stack — Server*,
    [ADR-17](../decisions.md#adr-17--nginx-and-certbot-instead-of-caddy)
12. TLS on `scanner.yo-po.eu` via a **new nginx virtual host plus certbot**, following the pattern already
    on the box. `client_max_body_size` is raised to 32 MB on the upload route — the existing vhosts cap it
    at 8 MB, which a full-resolution phone photo exceeds, and the failure would be a 413 that never
    reaches the server. — [ADR-17](../decisions.md#adr-17--nginx-and-certbot-instead-of-caddy)
13. Service memory limits, not just CPU limits. The box has no swap and hosts a live Postgres; an
    unbounded container that grows takes down production rather than just the benchmark.
    — [ADR-18](../decisions.md#adr-18--the-benchmark-shares-the-box-with-production)
14. Timings use the shared helpers from `packages/shared/src/timing.ts`, which wrap
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
deploy/
├── nginx/scanner.yo-po.eu.conf    # vhost, committed; installed to /etc/nginx/sites-available
└── README.md                      # the certbot invocation and the deploy steps
```

The nginx vhost lives in the repository even though it is installed outside it, because TLS for this
service now depends on host configuration — see the consequences in
[ADR-17](../decisions.md#adr-17--nginx-and-certbot-instead-of-caddy). An undocumented file on one box is
how a certificate stops renewing and nobody knows why.

## Key decisions

[ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication) ·
[ADR-17](../decisions.md#adr-17--nginx-and-certbot-instead-of-caddy) ·
[ADR-18](../decisions.md#adr-18--the-benchmark-shares-the-box-with-production)

The target box is surveyed in [deployment-target.md](../deployment-target.md) — read it before starting
this phase. It is a live machine with production traffic on it, not a blank VPS.

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

1. `docker compose up -d` brings up the server on `127.0.0.1:3002`, and
   `curl https://scanner.yo-po.eu/api/v1/health` returns 200 over TLS with a valid certificate through the
   nginx vhost.
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
9. **A full-resolution photo uploads successfully** — a file larger than 8 MB does not fail with 413,
   confirming the vhost's raised `client_max_body_size` is on the right route.
10. **The production stack is unaffected.** `emerald` and `garden` still serve over TLS and the eight
    `garden-prod_supabase-*` containers are still healthy, before and after deploying this phase.
    `nginx -t` passes before any reload.
11. Nothing is published beyond loopback: `ss -tln | grep 3002` shows `127.0.0.1:3002`, not `0.0.0.0`.
12. The scanner containers have both `cpus:` and `mem_limit` set — verify with `docker inspect`; on a box
    with no swap an unbounded container is a production incident waiting to happen.

## Risks / unknowns

- ~~**Blocker: `scanner.yo-po.eu` does not resolve.**~~ **Cleared 2026-07-28.** `dig +short
  scanner.yo-po.eu A` returns `167.235.146.155`, so certbot can issue and acceptance criterion 1 is
  reachable.
- SSH access is confirmed: `yordan@hez.yo-po.eu`, with `docker` group membership and passwordless sudo.
  That also means a careless command here reaches production, so every nginx change is `nginx -t`-checked
  before reload and the garden stack is verified healthy afterwards.
- ~~`better-sqlite3` is a native module: the Docker build needs build tooling present, or a prebuilt binary
  matching `node:22-slim`.~~ **Confirmed, and it did break the first image build.** `better-sqlite3`
  **13.0.1 publishes no prebuilds at all**; 12.x publishes `node-v127-linux-x64`, which is exactly Node
  22's ABI. Pinned to 12.x rather than adding python3 and a C++ toolchain to the image, because
  compiling SQLite from source on a two-core box with no swap and a live Postgres is the wrong trade —
  [ADR-18](../decisions.md#adr-18--the-benchmark-shares-the-box-with-production). Recorded in
  `deploy/README.md` under _Known build constraints_.
- ~~File ownership in the volume matters later: phase 07 mounts it read-only into the sidecar, so the UID
  the server writes as must be readable there. Decide the UID here rather than discovering it in phase 07.~~
  **Decided: UID 1000 (`node`), files written `0644`.** The Dockerfile creates `/data/*` owned by `node`
  before the volumes are mounted, so Docker seeds each empty named volume with that ownership. Recorded
  in `deploy/README.md`.
- Only ~20 GB of disk is free and Docker images already account for 6.8 GB of it. Two-variant storage
  ([ADR-3](../decisions.md#adr-3--images-are-stored-in-two-variants-linked-by-capturegroupid)) roughly
  doubles per-capture size; a few hundred images is comfortable, a few thousand is not.

## Review checkpoint

Show: a photo uploaded from `curl`, listed, fetched back byte-identical, thumbnailed; a 401 without a
token; a refused traversal attempt; an upload larger than 8 MB succeeding; and the whole thing running
under Compose behind the nginx vhost with a real certificate — with the two production sites and the
Supabase stack demonstrably untouched.
