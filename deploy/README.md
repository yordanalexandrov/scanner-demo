# Deploying the benchmark server

The target is `hez.yo-po.eu` (`167.235.146.155`), surveyed in
[../docs/deployment-target.md](../docs/deployment-target.md). **It is a live box running other
people's production traffic** — two sites behind nginx and an eight-container Supabase stack — not a
blank VPS. Every command below is written so that a mistake stops before it reaches them.

The rule that makes this safe: **`sudo nginx -t` passes before any reload, and the production stack
is verified healthy before and after.** There is passwordless sudo on this box, so nothing warns you.

## What runs where

| | |
|---|---|
| Compose stack | `scanner-demo`, one service (`server`), published on **`127.0.0.1:3002` only** |
| TLS | nginx vhost `scanner.yo-po.eu` + certbot — **not** Caddy, [ADR-17](../docs/decisions.md#adr-17--nginx-and-certbot-instead-of-caddy) |
| Image store | named volume `scanner-demo_scanner-images`, mounted at `/data/images` |
| Thumbnail cache | named volume `scanner-demo_scanner-thumbs`, at `/data/thumbs` |
| Database | named volume `scanner-demo_scanner-db`, at `/data/db/scanner.sqlite` |
| Container user | **UID 1000 (`node`)**, files written `0644` |

The UID is fixed here rather than discovered later: phase 07 mounts `scanner-demo_scanner-images`
read-only into the OCR sidecar, and a file the sidecar cannot read would fail there with a much
less obvious error than here. Files are world-readable for the same reason.

## Prerequisites

- `scanner.yo-po.eu` has an `A` record pointing at `167.235.146.155`. Verify before certbot runs;
  it cannot issue a certificate otherwise.

  ```bash
  dig +short scanner.yo-po.eu A     # expect 167.235.146.155
  ```

- `server/.env` exists on the box, copied from `server/.env.example`, with `API_BEARER_TOKEN` set:

  ```bash
  openssl rand -hex 32
  ```

  The same value goes into `app/.env` as `EXPO_PUBLIC_API_TOKEN`. It is bundled into the APK and is
  deliberately not treated as a secret — it is a coarse, rotatable gate on a personal server.

## 1. Record the production baseline

Run this **before** touching anything, and keep the output. It is what "the production stack is
unaffected" is measured against — acceptance criterion 10.

```bash
ssh yordan@hez.yo-po.eu '
  docker ps --filter name=garden-prod_supabase --format "{{.Names}}\t{{.Status}}"
  curl -sS -o /dev/null -w "emerald %{http_code}\n" https://emerald.yo-po.eu/
  curl -sS -o /dev/null -w "garden  %{http_code}\n" https://garden.yo-po.eu/
'
```

## 2. Bring up the stack

```bash
ssh yordan@hez.yo-po.eu
git clone https://github.com/<owner>/scanner-demo.git && cd scanner-demo
cp server/.env.example server/.env && "$EDITOR" server/.env    # set API_BEARER_TOKEN

docker compose build
docker compose up -d
docker compose ps
curl -sS http://127.0.0.1:3002/api/v1/health
```

Confirm nothing is exposed beyond loopback — acceptance criterion 11:

```bash
ss -tln | grep 3002        # expect 127.0.0.1:3002, never 0.0.0.0:3002
```

Confirm both limits are set — acceptance criterion 12. On a box with no swap, a container without a
memory cap is a production incident waiting to happen ([ADR-18](../docs/decisions.md#adr-18--the-benchmark-shares-the-box-with-production)):

```bash
docker inspect scanner-demo-server-1 \
  --format 'NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}}'
# expect NanoCpus=1500000000 Memory=536870912
```

## 3. Obtain the certificate

nginx owns :80, so certbot's standalone mode cannot bind it. It needs a server block that already
answers for the name — hence a temporary HTTP-only vhost first.

```bash
sudo tee /etc/nginx/sites-available/scanner.yo-po.eu >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name scanner.yo-po.eu;
    location / { return 404; }
}
EOF

sudo ln -sfn /etc/nginx/sites-available/scanner.yo-po.eu /etc/nginx/sites-enabled/scanner.yo-po.eu
sudo nginx -t && sudo systemctl reload nginx
```

`certonly` is deliberate: it obtains the certificate and leaves the configuration alone, so the
committed vhost is the one that ends up installed rather than a certbot-rewritten version of it.

```bash
sudo certbot certonly --nginx -d scanner.yo-po.eu
sudo ls /etc/letsencrypt/live/scanner.yo-po.eu/
```

Renewal then rides on the box's existing certbot timer, along with `emerald` and `garden`:

```bash
systemctl list-timers 'certbot*'
sudo certbot renew --dry-run
```

## 4. Install the real vhost

```bash
sudo cp deploy/nginx/scanner.yo-po.eu.conf /etc/nginx/sites-available/scanner.yo-po.eu
sudo nginx -t                 # must pass before the reload, not after
sudo systemctl reload nginx
```

`nginx -t` failing here means the production sites are still being served by the previously loaded
configuration. That is why the test comes first and the reload second.

## 5. Verify

```bash
curl -sS https://scanner.yo-po.eu/api/v1/health                       # 200, no token
curl -sS -o /dev/null -w '%{http_code}\n' https://scanner.yo-po.eu/api/v1/images   # 401

# Acceptance criterion 9: a body over the 8 MB the other vhosts allow must not 413.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $API_BEARER_TOKEN" \
  -F 'file=@big.jpg;type=image/jpeg' \
  -F 'meta={"captureGroupId":"...","variant":"upload","source":"camera","torch":false,"captureWidth":null,"captureHeight":null,"downscaled":false,"capturedAt":0,"capturedAtSource":"camera"}' \
  https://scanner.yo-po.eu/api/v1/images
```

Then repeat step 1 and compare. Eight `garden-prod_supabase-*` containers healthy, both sites
answering — acceptance criterion 10.

## Upgrading

```bash
git pull && docker compose build && docker compose up -d
```

Migrations are applied at boot by the server itself, from the committed `server/drizzle/`. The
named volumes are untouched by `down`/`up`; only `docker compose down -v` would destroy the dataset,
and there is no reason to ever run it here.

## Known build constraints

- **`better-sqlite3` is pinned to 12.x.** 12.x publishes a prebuilt binding for Node 22's ABI
  (`node-v127-linux-x64`); **13.0.1 publishes none**, so it falls back to compiling SQLite from
  source. That needs python3 and a C++ toolchain in the image, and it puts a multi-minute compile
  with a real memory spike on a two-core box with no swap. Revisit only if a later 13.x ships
  prebuilds.
- **`sharp` decodes HEIC through libvips' HEIF support.** If a gallery original is ever refused with
  "could not be decoded", that is the reason — the file is stored byte-for-byte or not at all, and
  transcoding it would defeat the point of keeping originals.

## If something goes wrong

```bash
docker compose logs -f server
sudo tail -f /var/log/nginx/scanner.yo-po.eu.error.log
```

A 413 that appears in the nginx log but not the server log is `client_max_body_size` — the limit in
the vhost and `MAX_UPLOAD_BYTES` in `server/.env` have drifted apart.

To back the whole thing out without touching production:

```bash
docker compose down
sudo rm /etc/nginx/sites-enabled/scanner.yo-po.eu
sudo nginx -t && sudo systemctl reload nginx
```

The volumes survive that, so bringing it back is step 2 again.
