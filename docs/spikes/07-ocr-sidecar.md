# Spike — phase 07 stage A: the self-hosted OCR sidecar

**Run on 2026-07-31** against `hez.yo-po.eu`, the box described in
[deployment-target.md](../deployment-target.md). Everything below was executed there; the numbers are
observations, not estimates. The throwaway harness and the raw output live in `~/spike-07/` on the box
and are not part of the repository.

**Nothing under `server/src` was written for this spike**, as stage A requires.

---

## Verdict in one page

| Question | Answer |
| --- | --- |
| 1. Image and digest | `qingchen0607/rapid-ocr-api@sha256:a1445b3617…` — `rapidocr_api` 0.2.0 on `rapidocr` 3.2.0. **No official image exists**; this is the least-bad of several unofficial ones |
| 2. Input modes | **HTTP only** — multipart `image_file`, or `image_data` as base64. **There is no path parameter** |
| 3. Reads the shared volume | The mount works and the file is readable, **but the API cannot be told to use it**. The volume is unusable as a transport |
| 4. Cost of one image | **Warm median 1.85 s** (upload variant, 1 worker, `--cpus=1.5`, production running). **Cold 3.4–3.9 s.** Production stopped: 1.73 s |
| 5. Resident memory | **644 MiB with one worker**, 978 MiB with the stock two. Inside the ~1 GB budget only after dropping to one worker |
| 6. Response contents | **Per-block quadrilateral + confidence**, so `anchor-proximity` *can* fire. It did not fire once in ten images — every parse was `sole-candidate` |
| 7. Model / dictionary replacement | **Yes, by configuration alone** — three env vars and a read-only mount. The dictionary travels inside the `.onnx`, so no separate dict file is needed |
| 8. Thread controls | **No environment variables.** Threads are only settable by bind-mounting a replacement `config.yaml`; worker count by the command line |
| 9. Mobile vs server models | **Mobile is already the default** (`model_type: mobile`). Server variants are selectable and were not tested — they do not fit the memory budget |

**Cyrillic, stated plainly:** it is reachable through configuration alone — no Python, no rebuilt image,
no internet at run time. **But it is worse at the job.** The Cyrillic model reads Cyrillic words better
and destroys the digits, and the digits are the measurement. Over ten real packaging photographs the
stock Chinese/English model yielded a correctly parsed expiry date on **7 of 10**; the Cyrillic model on
**1 of 10, and that one was wrong**. ADR-12's provisional decision stands, for a better reason than it
was written with.

---

## Conditions

Every latency figure in this document was taken under the co-tenancy ADR-18 describes: two cores shared
with a live Supabase stack and two production sites. Where a row says "production stopped", the eight
`garden-prod_supabase-*` containers were stopped for the duration and restarted afterwards; that window
was **06:47–06:53 UTC, about six minutes**, and the stack came back with all eight healthy and all three
sites answering 200. A watchdog was armed before stopping them so that a dropped session could not leave
production down.

```
$ free -m                      # before
               total        used        free      shared  buff/cache   available
Mem:            3819        1768         484          57        1954        2051
$ uptime
 06:26:37 up 51 days,  9:29,  1 user,  load average: 0.37, 0.47, 0.41
```

---

## 1. The image, and the fact that there is no official one

The specification names `rapidocr_api` as the default. That is a **PyPI package, not a published
image** — RapidAI ships Dockerfiles for building development environments, not a registry image for the
API server. Every candidate on Docker Hub is an unofficial personal build with zero stars:

| Image | Last pushed | Size | Note |
| --- | --- | --- | --- |
| `volador/rapidocr` | 2024-06-11 | 620 MB | Two years stale, `rapidocr_web` + `rapidocr_api` |
| `volador/rapidocr:slim` | 2024-07-08 | 127 MB | As above |
| `qingchen0607/rapid-ocr-api:v20250619` | 2025-06-19 | 254 MB download / 997 MB on disk | Most pulled (2.6 K), newest of the plausible ones |
| `reodwind/rapidocr_api` | 2026-06-12 | — | Newer, 609 pulls, not evaluated |

**Chosen: `qingchen0607/rapid-ocr-api`, pinned by digest.**

```
$ docker image inspect qingchen0607/rapid-ocr-api:v20250619
RepoDigest  qingchen0607/rapid-ocr-api@sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c
Created     2025-06-19T18:09:53+08:00
Size        253590211
Cmd         ["bash","-c","rapidocr_api -ip 0.0.0.0 -p 9005 -workers 2"]
User        (empty - runs as root)
ExposedPorts 9005/tcp

$ docker exec spike-ocr pip list | grep -iE 'rapidocr|onnx|fastapi|uvicorn'
fastapi      0.115.13
onnxruntime  1.22.0
rapidocr     3.2.0
rapidocr-api 0.2.0
uvicorn      0.34.3
```

Two things to record about this choice rather than discover later:

- **It is one person's build of a Python package.** The digest pin protects reproducibility, not
  supply chain. If that account disappears, stage B needs a new image and the models are the only part
  that carries over. Mitigated slightly by the fact that the models are pinned separately and by SHA256
  (§7), so a replacement image would produce comparable results.
- **The stock command runs two uvicorn workers.** Each loads its own copy of the models. On a two-core
  box that costs 334 MiB for nothing — see §5.

---

## 2. Input modes: HTTP only, no path

The container's own OpenAPI document is the whole answer. There is **one** endpoint:

```
$ curl -sS http://127.0.0.1:9005/openapi.json | jq '.paths, .components.schemas.Body_ocr_ocr_post.properties | keys'
paths:  { "/": { get }, "/ocr": { post, multipart/form-data } }
keys:   [ "image_file", "image_data", "use_det", "use_cls", "use_rec" ]
```

`image_file` is a binary upload; `image_data` is a base64 string. Both were exercised, both work, and
both cost the same:

```
$ curl -F image_file=@94530004….jpg  http://127.0.0.1:9005/ocr   → http=200  time=3.649  (668 bytes)
$ curl -F image_data=<b64.txt        http://127.0.0.1:9005/ocr   → http=200  time=3.666  (identical body)
```

Passing a filesystem path where the base64 was expected fails, which is what confirms there is no
hidden path mode:

```
$ curl -F image_data=/data/images/94530004….jpg http://127.0.0.1:9005/ocr
Internal Server Error                                              → http=500
```

The source agrees: `rapidocr_api/main.py` opens `image_file.file` or base64-decodes `image_data`, and
does nothing else with the request. **The upload branch of phase 07 item 12 is the one that applies.**

Since both modes are equal in cost, **multipart is the one to use** — base64 inflates 223 KB to 297 KB
on the wire for no benefit.

---

## 3. The shared volume: mounted, readable, and useless as a transport

The volume mounts and the sidecar can read what the TS server wrote, at the permissions
`deploy/README.md` fixed for exactly this reason (UID 1000, mode 0644):

```
$ docker exec spike-ocr ls -la /data/images | head -3
drwxr-xr-x 2 1000 1000    4096 Jul 30 19:00 .
-rw-r--r-- 1 1000 1000    8819 Jul 28 11:57 0bbccad4-….jpg

$ docker exec spike-ocr sh -c 'head -c 4 /data/images/94530004-….jpg | od -An -tx1'
 ff d8 ff e0                                        # readable

$ docker exec spike-ocr touch /data/images/spike-write-test
touch: cannot touch '/data/images/spike-write-test': Read-only file system
```

It also works when the container is forced to a non-root UID, which the stock image does not do:

```
$ docker run --user 1000:1000 …
$ docker exec spike-ocr sh -c 'id; head -c 4 /data/images/94530004-….jpg | od -An -tx1'
uid=1000 gid=1000 groups=1000
 ff d8 ff e0                                        # still readable, OCR still returns 200
```

So the plumbing is sound — but §2 means **nothing can ask the engine to open that file**. The TS server
will read the bytes and post them. Localhost-to-container over a Docker bridge, so the copy is cheap,
but it is a copy, and the "removes a pointless read-and-re-encode cycle" motivation in the phase
document does not materialise here.

**Recommendation:** keep the read-only mount anyway. It costs nothing, it is what the specification
asks for, and it is the difference between a one-line change and a redeployment if a future image ever
accepts a path. Say so in the compose comment, so the next reader does not assume it is load-bearing.

---

## 4. What one image costs on this box

All figures are the HTTP round trip measured with `curl -w %{time_total}` from the host over loopback,
25 sequential requests after warm-up, one image (`94530004`, the 1200×1600 upload variant, 223 KB).
The container reports no timing of its own — see §6 — so this is the closest thing to `engineMs` that
exists.

| # | workers | ONNX threads | `--cpus` | production | median | IQR / median | peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 2 (stock) | default | 1.5 | running | **1.922 s** | 8.1 % | 978 MiB |
| B1 | 1 | default | 1.5 | running | **1.854 s** | 12.0 % | 644 MiB |
| B2 | 1 | intra 2 / inter 1 | 1.5 | running | 1.906 s | 10.4 % | 638 MiB |
| B3 | 1 | intra 1 / inter 1 | 1.5 | running | 2.321 s | 7.2 % | 627 MiB |
| C | 1 | default | 1.5 | **stopped** | **1.730 s** | 4.1 % | 638 MiB |
| F | 1 | default | 1.0 | running | 2.867 s | 6.2 % | — |
| D | 1 | default | 1.0 | **stopped** | 2.769 s | 6.3 % | — |
| E | 1 | default | 0.5 | **stopped** | 6.379 s | 7.0 % | — |

Read three things out of that table.

**The co-tenancy tax is small but the noise is not.** B1 against C is the same container with the same
settings, differing only in whether eight production containers were running: the median moves 7 %
(1.854 → 1.730 s) while the spread triples (12.0 % → 4.1 %). ADR-18's insistence on distributions rather
than single numbers is vindicated — but so is the acceptance criterion's 20 % threshold, which every
configuration met comfortably. **Criterion 13 is achievable as written.**

**The CPU cap dominates everything else.** Halving from 1.5 to 1.0 costs 55 %; going to 0.5 costs 245 %.
Thread settings barely register next to it, because on two cores the ONNX default already resolves to
two threads.

**The box's own latency is not the app's.** These are inference numbers only. The phone's upload of a
223 KB JPEG over mobile data and the nginx hop are on top.

### Cold start

Cold start is **per worker and per input size**, not once per container.

```
2 workers, --cpus=1.5, three container restarts:
  round 1:  3.660  2.104  3.363  1.963  1.895  1.713
  round 2:  3.991  1.918  3.616  1.893  2.011  1.761
  round 3:  3.603  3.136  2.284  1.656  1.802  1.939
```

Two requests pay the penalty, not one, because the round-robin hands the second request to the other
worker's cold process. With one worker there is exactly one cold request, **3.4–3.9 s at `--cpus=1.5`**,
4.96–5.09 s at 1.0, and 11.54 s at 0.5. Warm is roughly half of cold in every configuration.

Separately, the **first request at a new input size is cold again**: on a container already warm on
1200×1600, the first 3000×4000 image took 6.50 s and the next four took 3.16–3.46 s. A warm-up with one
dummy image (phase 07 item 16) therefore only covers the size it used.

Container readiness — process start to the API answering — is **1.9–2.4 s with one worker**, 4.5–5.4 s
with two.

### Image size

Warm, same container, same capture:

| Input | Warm range |
| --- | --- |
| 1200×1600 upload variant (223 KB) | 1.79 – 2.24 s |
| 3000×4000 original (3.0 MB) | 3.16 – 3.46 s |
| 6000×4500 original (16.5 MB) | 2.98 – 3.21 s, and it returned `{}` — no text detected |

The originals cost roughly 1.8× the upload variant. RapidOCR clamps the long side to 2000 px internally
(`Global.max_side_len`), which is why 6000×4500 is not proportionally worse.

### Concurrency

One worker, `--cpus=1.5`, two simultaneous requests:

```
solo    1.906 s
par-a   4.529 s
par-b   4.106 s
```

Worse than serialising. FastAPI runs the synchronous handler in a threadpool, so both requests execute
and fight over the same 1.5 cores. The app triggers one method at a time by design, so this is a note
rather than a problem — but stage B should not add concurrency, and if a second request can ever
overlap, the server should queue it.

---

## 5. Resident memory

```
$ docker stats --no-stream --format '{{.MemUsage}}' spike-ocr
```

sampled continuously through each run:

| Configuration | Peak RSS |
| --- | --- |
| 2 workers (stock command) | **978.2 MiB** |
| 1 worker | **644.4 MiB** |
| 1 worker, threads capped | 626.7 – 638.3 MiB |

The stock image sits at the very edge of the ~1 GB budget purely because it loads the models twice.
**One worker is the single most valuable configuration change available**: it costs nothing in latency
(1.854 s versus 1.922 s, and the difference is inside the noise) and returns 334 MiB to a box with no
swap.

A `--memory=1g` limit was exercised for the whole of §7 with no OOM kill. **768 MiB would be tight;
1 GB is the right `mem_limit`** with the peak at 644 MiB.

---

## 6. What the response contains

```json
{
  "0": { "rec_txt": "3b5050Λ",        "dt_boxes": [[678,199],[796,254],[779,292],[661,237]], "score": 0.7999  },
  "5": { "rec_txt": "TOeHA0:07/2027", "dt_boxes": [[312,907],[739,909],[739,962],[312,960]], "score": 0.79417 }
}
```

A JSON object keyed by stringified index. Per block: text, **a four-point quadrilateral**, and a
**confidence in 0–1**. Empty text is `{}` with HTTP 200.

Consequences for the adapter, each of which is a real piece of work in stage B:

- **`bbox` needs converting.** ADR-5 fixes `[x, y, width, height]`, axis-aligned. The engine returns a
  rotated quad. The axis-aligned bounding box of the quad is the honest conversion; the rotation is
  information we discard, and that is worth a comment rather than silence.
- **The coordinates are in the uploaded image's own pixel space.** Verified in
  `rapidocr/main.py`, which multiplies the boxes back by the preprocessing ratio
  (`dt_boxes_array[:, :, 0] *= ratio_w`). So `imageWidth` / `imageHeight` are simply the dimensions the
  server already has from `sharp` — no rescaling, no second source of truth.
- **`confidence` maps straight across.** Observed 0.58–0.999. ADR-5's `null` case does not arise here.
- **`rawText` has to be assembled.** The engine returns no joined text and the block order is detection
  order, not reading order.
- **There is no engine timing in the response** — see the correction proposed at the end.
- **Errors have no JSON shape.** Corrupt input, truncated JPEG and an empty POST all return HTTP 500
  with the plain string `Internal Server Error`. The adapter has to treat any non-200 as an engine
  failure and cannot rely on parsing a body. `{}` with 200 is the distinct, legitimate "no text" case.

### Can `anchor-proximity` ever fire? Yes. Did it? No.

Boxes and confidences are present, so ADR-4's positional rule is technically reachable on this engine —
unlike the VLM path. To find out whether it actually fires, the ten upload-variant images from the
Library were run through the engine and their blocks fed to the **real shared parser**
(`parseExpiryDate` from `packages/shared`, built from this branch), with the quad converted as above:

```
image     date         precision  rule            raw          candidates
1fc234d3  2027-07-31   month      sole-candidate  07/2027      1
94530004  2027-07-31   month      sole-candidate  07/2027      1
a13fa97d  2027-07-31   month      sole-candidate  07/2027      1
bef20fea  2027-07-31   month      sole-candidate  07/2027      1
cd6bf095  2027-07-31   month      sole-candidate  07/2027      1
ce774011  2027-07-31   month      sole-candidate  07/2027      1
efd3f1ff  2026-12-16   day        sole-candidate  16.12.2026   1
2134860f  -            -          none            -            1
974b2984  -            -          none            -            1
f058471e  -            -          none            -            0
```

**Seven of ten parse to a date, and every one of them by `sole-candidate`.** The anchor rule never got
the chance, because the engine never produced two competing date candidates on this dataset. That is
worth knowing before any effort goes into anchor tuning for this path: on Bulgarian pharmaceutical and
food packaging, the constraint is finding *one* candidate, not choosing between several.

Cross-check: on `94530004` the stored on-device attempt recorded `expiry.date = 2027-07-31`,
`raw = "07/2027"` — the same answer the sidecar produces on the same capture, from a different variant.

---

## 7. Replacing the model and the dictionary — yes, by configuration alone

`rapidocr_api/main.py` reads three environment variables, all lowercase, and passes them to RapidOCR as
`Det.model_path`, `Cls.model_path` and `Rec.model_path`:

```python
det_model_path = os.getenv("det_model_path", None)
cls_model_path = os.getenv("cls_model_path", None)
rec_model_path = os.getenv("rec_model_path", None)
if det_model_path is None or cls_model_path is None or rec_model_path is None:
    self.ocr = RapidOCR()
```

**All three or none** — setting only the recogniser silently changes nothing. The det and cls paths can
point at the models already inside the image.

The catalogue the package ships (`rapidocr/default_models.yaml`) lists a Cyrillic recogniser, and
`LangRec.CYRILLIC` is a first-class option in its type enum:

```
onnxruntime → PP-OCRv4 → rec:
  arabic_… ch_… ch_doc_… chinese_cht_… cyrillic_PP-OCRv3_rec_infer.onnx  devanagari_…
  en_… japan_… ka_… korean_… latin_PP-OCRv3_rec_infer.onnx  ta_… te_…
```

Downloaded on the host and checksum-verified against that catalogue:

```
$ curl -sSL -o cyrillic_PP-OCRv3_rec_infer.onnx \
    https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.1.0/onnx/PP-OCRv4/rec/cyrillic_PP-OCRv3_rec_infer.onnx
http=200 size=8972413
$ sha256sum cyrillic_PP-OCRv3_rec_infer.onnx
1efb65bdc460af1c0e8733d005b20952b17ca5aac10ddb56c968333791c5eaa3      # matches default_models.yaml
```

Mounted read-only and selected by environment variable, on an **internal network with no DNS and no
route out**, to prove that no run-time download is involved:

```
$ docker network create --internal spike-net
$ docker run -d --name spike-ocr --network spike-net \
    -v $HOME/spike-07/models:/models:ro \
    -e det_model_path=…/ch_PP-OCRv4_det_infer.onnx \
    -e cls_model_path=…/ch_ppocr_mobile_v2.0_cls_infer.onnx \
    -e rec_model_path=/models/cyrillic_PP-OCRv3_rec_infer.onnx \
    --memory=1g --cpus=1.5 qingchen0607/rapid-ocr-api@sha256:a1445b…

$ docker exec spike-ocr sh -c 'getent hosts www.modelscope.cn || echo NO_DNS'
NO_DNS
$ docker logs spike-ocr | grep 'Using /'
Using /usr/local/lib/python3.10/site-packages/rapidocr/models/ch_PP-OCRv4_det_infer.onnx
Using /usr/local/lib/python3.10/site-packages/rapidocr/models/ch_ppocr_mobile_v2.0_cls_infer.onnx
Using /models/cyrillic_PP-OCRv3_rec_infer.onnx

$ curl http://127.0.0.1:9005/                       # from the host
curl: (7) Failed to connect to 127.0.0.1 port 9005  # unreachable, as intended
$ docker run --rm --network spike-net curlimages/curl -F image_file=@… http://spike-ocr:9005/ocr
{"0":{"rec_txt":"ђођо",…}}                          → http=200
```

**No Python was written, the container was not opened, and it needs no internet.** Stage B's
internal-only network is compatible with a swapped model, provided the `.onnx` is fetched at build or
deploy time and mounted.

**The dictionary needs no separate handling.** `rapidocr/ch_ppocr_rec/main.py` takes the character list
from the ONNX model's own metadata when the engine is onnxruntime (`self.session.have_key()`), and only
falls back to a `rec_keys_path` file for other engines. The dictionary travels inside the model file.
`rapidocr_api` does not expose `rec_keys_path` at all, so this is fortunate rather than designed.

### And yet the Cyrillic model should not be the default

Same ten images, three model configurations, same parser:

| Configuration | Images parsed to a date | Notes |
| --- | --- | --- |
| **PP-OCRv4 mobile ch/en (bundled default)** | **7 / 10** | Reads `07/2027` and `16.12.2026` cleanly |
| PP-OCRv5 mobile ch (downloaded) | 3 / 10 | Reads `/` as `1` — `0712027` — on four images |
| Cyrillic PP-OCRv3 (downloaded) | 1 / 10 | And that one is **wrong**: `18.12` where the date is `16.12.2026` |

The failure mode is specific and consistent. On `94530004` the same date line reads:

```
v4 ch/en   "TOeHA0:07/2027"     → parses to 2027-07-31
cyrillic   "oдeн 40. 0:+202?"   → nothing
v5 ch      "ToneH AO:" "0712027" → nothing
```

The Cyrillic model does what it says — `Паpt.N` for «Парт.№» where the ch model gives `napT.No`, and
`Heoвopeн най-дobp до` for «Неотворен най-добър до» — but it mangles digits, and digits are the entire
measurement. PP-OCRv5 is both slower (median 2.622 s versus 1.854 s) and less accurate here, so the
newer version is not an upgrade for this task.

**This resolves ADR-12.** The default stays the bundled Chinese/English mobile models. A
`onnx-paddleocr-cyrillic` engine is *buildable* exactly as ADR-12 anticipated, and the benchmark can
carry it as a separately labelled second engine — but the honest expectation to write into the README
is that it will score worse on dates, and its value is that it makes the Bulgarian anchor phrases
partially matchable, which §6 shows is not currently the binding constraint.

---

## 8. Bounding CPU and threads

**There is no thread environment variable.** `rapidocr/inference_engine/onnxruntime/main.py` builds its
`SessionOptions` solely from the configuration file:

```python
intra_op_num_threads = cfg.get("intra_op_num_threads", -1)
if intra_op_num_threads != -1 and 1 <= intra_op_num_threads <= cpu_nums:
    sess_opt.intra_op_num_threads = intra_op_num_threads
```

and `rapidocr_api` never passes a `config_path`, so `RapidOCR()` always loads
`<site-packages>/rapidocr/config.yaml`. That leaves exactly three knobs, all of them configuration:

| Knob | How | Effect measured |
| --- | --- | --- |
| **Worker processes** | `-workers N` on the command line | 2 → 1 saves **334 MiB**, no latency cost |
| **ONNX threads** | bind-mount a replacement `config.yaml` over the packaged one | `intra_op=1` holds the container to **101.4 % CPU** instead of ~153 %, at +25 % latency |
| **CPU share** | `cpus:` in Compose | The dominant control — see §4 |

The mounted-configuration route was verified, not assumed. Copying the file out, editing two lines, and
mounting it back changed the observed CPU ceiling, which is what proves it took effect:

```
$ docker cp spike-ocr:/usr/local/lib/python3.10/site-packages/rapidocr/config.yaml config.base.yaml
$ sed -i 's/intra_op_num_threads: -1/intra_op_num_threads: 1/; s/inter_op_num_threads: -1/inter_op_num_threads: 1/' config.threads1.yaml
$ docker run -v $PWD/config.threads1.yaml:/usr/local/lib/python3.10/site-packages/rapidocr/config.yaml:ro …

peak cpu, default threads:  152.9 %   median 1.854 s
peak cpu, intra=1 inter=1:  101.4 %   median 2.321 s
```

**Recommendation for stage B:** one worker, `cpus: 1.5`, `mem_limit: 1g`, and **leave the ONNX threads
at their default**. On a two-core box the default already resolves to two threads and the `cpus:` cap
is what actually bounds the container; a mounted `config.yaml` is a file the deployment has to keep in
step with the image's own, and it buys nothing here. Note that `server` is already at `cpus: 1.5` on the
same two cores — the two are never busy simultaneously on this workload, but the sum is deliberate
overcommit and belongs in the compose comment.

---

## 9. Mobile versus server models

Already answered by the default configuration — the bundled models **are** the mobile ones:

```yaml
Det:  lang_type: "ch"   model_type: "mobile"   ocr_version: "PP-OCRv4"
Rec:  lang_type: "ch"   model_type: "mobile"   ocr_version: "PP-OCRv4"
```

```
$ docker exec spike-ocr ls -la …/rapidocr/models/
 4745517  ch_PP-OCRv4_det_infer.onnx          # mobile; the server variant is ~110 MB
10857958  ch_PP-OCRv4_rec_infer.onnx          # mobile
  585532  ch_ppocr_mobile_v2.0_cls_infer.onnx
```

The server variants are selectable the same way as the Cyrillic model (`model_type: server`, or a
downloaded `*_server_infer.onnx` and the env var). **They were not benchmarked and should not be**: at
644 MiB resident with the mobile pair, the server pair does not fit the budget on this box, which makes
the specification's preference and ADR-18's constraint agree.

So phase 07 item 20 — "select the mobile models explicitly" — needs no code. It needs the model
**names in the README** and a note that they are the image's defaults, so that a future image change
that quietly ships something else is visible as a difference rather than absorbed as noise.

---

## What this changes for stage B

**Configuration to carry forward**

```yaml
image: qingchen0607/rapid-ocr-api@sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c
command: ["bash","-c","rapidocr_api -ip 0.0.0.0 -p 9005 -workers 1"]   # one worker: -334 MiB, no latency cost
user: "1000:1000"                                                       # verified working; the image defaults to root
cpus: 1.5
mem_limit: 1g                                                           # peak observed 644 MiB
```

Internal network, no published ports, image volume mounted `:ro`, models left at the image defaults.
Engine string `onnx-paddleocr`; `costEstimateUsd: 0` per ADR-11.

**Two corrections the phase document needs**

1. **Item 19 says `engineMs` is "time inside the container as it reports it". The container reports
   nothing.** There is no timing field in the response and no timing in the uvicorn access log. The only
   honest options are to measure the HTTP call from inside the Fastify handler — in which case
   `engineMs` includes the loopback hop and the multipart encode/decode, and `engineMsScope` must be
   `"inference+network"`, not `"inference"` — or to leave `engineMs` as the round trip and be explicit
   in the README that for this engine the process boundary is *inside* the figure rather than beside it.
   ADR-10 currently states that "the sidecar and ML Kit report `inference`". That sentence is not
   achievable with this image and should be amended at the stage A checkpoint rather than quietly
   contradicted by the code. `serverTotalMs - engineMs` remains valid and still measures the Fastify
   handler's own overhead — just not the container boundary.

2. **Item 12's "removes a pointless read-and-re-encode cycle" does not apply.** The engine cannot be
   given a path (§2–3). The mount stays because the specification asks for it and because it is free,
   but the compose file should say plainly that it is presently unused, or the next reader will assume
   the transport goes through it.

**Two decisions requested at this checkpoint**

- **Models:** keep the image's bundled PP-OCRv4 **mobile ch/en** as `onnx-paddleocr`. 7/10 versus 3/10
  for PP-OCRv5 and 1/10 for Cyrillic, and it is the fastest of the three.
- **Cyrillic:** build `onnx-paddleocr-cyrillic` as a second labelled engine per ADR-12, or defer it? It
  is cheap — one mounted `.onnx` and a second service — but on the evidence above it will make the
  self-hosted path look worse, not better, and its benefit (matchable Bulgarian anchors) addresses a
  constraint that §6 shows is not currently binding. **Recommendation: defer it, record the measurement
  here as the reason, and revisit if the dataset ever grows date lines with two competing candidates.**

**Left on the box**

`~/spike-07/` holds the harness, the raw per-run timings, the OCR outputs and the three downloaded
models with their checksums. The spike container, its internal network and the pulled `curl` image were
removed; production was verified healthy afterwards — eight containers up, `emerald`, `garden` and
`scanner` all answering 200.
