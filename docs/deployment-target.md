# Deployment target

Surveyed **2026-07-28**. This is a live box running other people's production traffic, not a blank VPS.
Several plan assumptions had to change once that was visible, so the facts are recorded here rather than
rediscovered. Re-check before phase 02 if significant time has passed.

## The box

| | |
|---|---|
| Host | `hez.yo-po.eu` → `167.235.146.155` |
| Access | `ssh yordan@hez.yo-po.eu`; groups `sudo`, `docker`; **passwordless sudo** |
| Hostname | `Emerald` |
| OS | Ubuntu 24.04.3 LTS, kernel 6.8.0 |
| CPU | **2 cores**, Intel Xeon (Skylake) |
| RAM | **3.7 GB total, ~2.2 GB available**, **no swap** |
| Disk | 38 GB, 20 GB free (Docker images already account for 6.8 GB) |
| GPU | none — `nvidia-smi` absent, consistent with the CPU-only constraint |
| Docker | 29.1.3 (Ubuntu package) |
| Compose | v2.40.3 (`docker compose`, installed 2026-07-28) and legacy v1.29.2 (`docker-compose`) |
| Firewall | `ufw` inactive |

## What is already running

The box is **not dedicated to this project**. It serves two production sites and an eight-container
Supabase stack:

- `nginx` 1.24 on **:80 and :443** (also :8443), with Let's Encrypt certificates issued by `certbot`.
  Virtual hosts: `emerald`, `garden`.
- `garden-prod_supabase-*` — studio, gateway, storage, meta, rest, auth, db, imgproxy. Roughly 660 MB
  resident, mostly idle at survey time.
- A Node service on `:3001` (the garden backend) and something on `:3000`.

Ports **3002 and 3003 are free**; the scanner server takes 3002, bound to loopback.

## Consequences for the plan

1. **Caddy cannot be used.** nginx owns 80 and 443 and two production sites depend on it. TLS is handled
   by an nginx virtual host plus certbot, following the pattern already on the box.
   See [ADR-17](decisions.md#adr-17--nginx-and-certbot-instead-of-caddy).
2. **The benchmark shares two cores with production.** This affects what the latency numbers mean and how
   they must be gathered. See [ADR-18](decisions.md#adr-18--the-benchmark-shares-the-box-with-production).
3. **Upload size limits are real.** The existing vhosts set `client_max_body_size 8m`. Full-resolution
   originals from a modern phone exceed that, and would fail with 413 before reaching the server. The
   scanner vhost raises it on the upload route.
4. **Memory is the binding constraint, not disk.** ~2.2 GB available, no swap, shared with a live
   Postgres. An OOM kill would take down production, not just the benchmark — so the OCR sidecar gets a
   hard `mem_limit`, not only a CPU cap.

## Outstanding

- **`scanner.yo-po.eu` does not resolve.** It needs an `A` record pointing at `167.235.146.155` before
  certbot can issue a certificate. This is a change at the DNS registrar and is the one remaining blocker
  on phase 02.
