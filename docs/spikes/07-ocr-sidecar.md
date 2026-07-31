# Spike — phase 07 stage A: the self-hosted OCR sidecar

**This is the stage A gate document.** It reconciles **two independent spikes of the same container**,
run without sight of each other, plus a follow-up investigation into whether more hardware would change
the answer:

| Run | When | Where | Branch |
| --- | --- | --- | --- |
| First | 2026-07-30, 14:00–14:11 UTC | `hez.yo-po.eu` | `feat/phase-07-ocr-sidecar` |
| Second, independent | 2026-07-31, 06:26–07:00 UTC | `hez.yo-po.eu` | `feat/phase-07-ocr-sidecar-spike` |
| Resource follow-up | 2026-07-31 | 32-core / 62 GB / RTX 4080 workstation | as above |

The two runs **agree on all nine questions** and contradict each other nowhere. Each found things the
other missed, and both are folded in below with attribution. Where their numbers appear to differ they
are reconciled rather than averaged — the differences turn out to be measurement conditions, not
disagreements.

A separate follow-up, [07b-tesseract-alternative.md](07b-tesseract-alternative.md), measured Tesseract
under the same protocol.

**Nothing under `server/src` was written.** The throwaway harness and raw output live in `~/spike-07/`
on the box.

**Every accuracy figure here was produced by `parser-v2`** — the parser as amended by
[ADR-21](../decisions.md#adr-21--candidate-boundaries-and-the-order-of-the-sanity-window) in phase 06b,
which landed on `main` while this spike was being written. The engine outputs were captured once and
re-scored against the new parser rather than re-run, since the OCR is unaffected by a parser change.
One figure moved, and instructively — see "A parser change moved one of these numbers" below. This is
what `parserVersion` exists for: **an accuracy number from this harness is a statement about an engine
and a parser together**, and citing one without the other is the confound ADR-21 was written to stop.

---

## Verdict

| Question | Answer |
| --- | --- |
| 1. Image and digest | `qingchen0607/rapid-ocr-api@sha256:a1445b3617…` — `rapidocr_api` 0.2.0 on `rapidocr` 3.2.0. **No official image exists**; this is the least-bad of several unofficial ones |
| 2. Input modes | **HTTP only** — multipart `image_file`, or `image_data` as base64. **There is no path parameter** |
| 3. Reads the shared volume | The mount works and the file is readable, **but the API cannot be told to use it**. The volume is unusable as a transport |
| 4. Cost of one image | **Warm median 1.85 s** (upload variant, 1 worker, `--cpus=1.5`, production running). **Cold 3.4–3.9 s.** Production stopped: 1.73 s |
| 5. Resident memory | **644 MiB with one worker** (`VmHWM` 626 MiB), 978 MiB with the stock two. Inside the ~1 GB budget only after dropping to one worker |
| 6. Response contents | **Per-block quadrilateral + confidence**, so `anchor-proximity` *can* fire. It never did on this dataset — every parse was `sole-candidate` |
| 7. Model / dictionary replacement | **Yes, by configuration alone** — three env vars and a read-only mount. The dictionary travels inside the `.onnx` |
| 8. Thread controls | **No environment variables.** Threads only via a bind-mounted `config.yaml`; workers via the command line. **This is not optional on a many-core host** — see §8 |
| 9. Mobile vs server models | **Mobile is already the default.** Server variants were later tested on bigger hardware and are 30–150× slower for no accuracy gain — see "Would more hardware change any of this?" |

**Cyrillic, stated plainly:** reachable through configuration alone — no Python, no rebuilt image, no
internet at run time. **But it is worse at the job**, and by a margin that settles ADR-12: 7 of 10
images on the stock Chinese/English models against 1 of 10 on the Cyrillic one, and that one is wrong.

---

## Correction: what "7 of 10" actually means

The headline accuracy figure needs three qualifications, all discovered after the first write-up and
all of them material. **A reader who takes 7/10 at face value will over-trust this engine.**

- **The dataset is 5 distinct products, not 10.** Six of the ten photographs are the same Paracofdal
  box. By distinct product the score is **2 of 5**.
- **Every failure is a dot-matrix date.** The three products that fail all carry inkjet dot-matrix
  date codes; the ones that succeed carry continuous-glyph prints. See "Why the three failures are one failure".
- **0 of 3 dot-matrix dates are read** — by this engine, by its server-variant models, by PaddleOCR
  server, and by Tesseract with Bulgarian language data. Four independent attempts — see "Would more hardware change any of this?".

Dot-matrix is how expiry dates are actually applied to food packaging — stamped on the line, not
printed with the artwork. So the figure that predicts real-world behaviour is the 0/3, not the 7/10.
**The dataset must be widened before any accuracy claim is made from it**; that is a prerequisite for
phases 08–10 being meaningful, not a phase 07 task.

---

## Conditions

Every VPS latency figure was taken under the co-tenancy ADR-18 describes: two cores shared with a live
Supabase stack and two production sites. Where a row says "production stopped", the eight
`garden-prod_supabase-*` containers were stopped for the duration and restarted afterwards — a window
of about six minutes on 2026-07-31, after which all eight were healthy and `emerald`, `garden` and
`scanner` all answered 200. A watchdog was armed first so a dropped session could not leave production
down.

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
| `volador/rapidocr` | 2024-06-11 | 620 MB | Two years stale |
| `volador/rapidocr:slim` | 2024-07-08 | 127 MB | As above |
| `qingchen0607/rapid-ocr-api:v20250619` | 2025-06-19 | 254 MB download / 997 MB on disk | Most pulled (2.6 K), newest plausible one |
| `reodwind/rapidocr_api` | 2026-06-12 | — | Newer, 609 pulls, not evaluated |

**Chosen: `qingchen0607/rapid-ocr-api`, pinned by digest.** Both runs selected it independently and
both recorded the same digest.

```
RepoDigest  qingchen0607/rapid-ocr-api@sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c
Created     2025-06-19T18:09:53+08:00
Size        253590211
Cmd         ["bash","-c","rapidocr_api -ip 0.0.0.0 -p 9005 -workers 2"]
User        (empty - runs as root)

$ docker exec spike-ocr pip list | grep -iE 'rapidocr|onnx|fastapi|uvicorn'
fastapi 0.115.13   onnxruntime 1.22.0   rapidocr 3.2.0   rapidocr-api 0.2.0   uvicorn 0.34.3
```

Two things to record rather than discover later:

- **It is one person's build of a Python package.** The digest pin protects reproducibility, not
  supply chain. Mitigated slightly by the models being pinned separately by SHA256 (§7), so a
  replacement image would produce comparable results.
- **The stock command runs two uvicorn workers**, each loading its own copy of the models — 334 MiB
  for nothing on a two-core box. Both runs independently overrode it to one.

---

## 2. Input modes: HTTP only, no path

The container's own OpenAPI document is the whole answer. There is **one** OCR endpoint:

```
$ curl -sS http://127.0.0.1:9005/openapi.json | jq '.paths, .components.schemas.Body_ocr_ocr_post.properties | keys'
paths:  { "/": { get }, "/ocr": { post, multipart/form-data } }
keys:   [ "image_file", "image_data", "use_det", "use_cls", "use_rec" ]
```

`image_file` is a binary upload; `image_data` is a base64 string. Both work and both cost the same:

```
$ curl -F image_file=@94530004….jpg  http://127.0.0.1:9005/ocr   → http=200  time=3.649  (668 bytes)
$ curl -F image_data=<b64.txt        http://127.0.0.1:9005/ocr   → http=200  time=3.666  (identical body)
```

Passing a filesystem path where base64 was expected fails, which is what confirms there is no hidden
path mode:

```
$ curl -F image_data=/data/images/94530004-….jpg http://127.0.0.1:9005/ocr
Internal Server Error                                              → http=500
```

The source agrees: `rapidocr_api/main.py` opens `image_file.file` or base64-decodes `image_data`.
**The upload branch of phase 07 item 12 is the one that applies.**

Both modes being equal in cost, **multipart is the one to use** — base64 inflates 223 KB to 297 KB on
the wire for no benefit.

---

## 3. The shared volume: mounted, readable, and useless as a transport

The volume mounts and the sidecar reads what the TS server wrote, at the permissions
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

Two hardening facts, one from each run:

- The container **also works with a read-only root filesystem** (`ReadonlyRootfs=true`) — first run.
- It **also works forced to a non-root UID**, which the stock image does not do — second run:

```
$ docker run --user 1000:1000 …
$ docker exec spike-ocr sh -c 'id; head -c 4 /data/images/94530004-….jpg | od -An -tx1'
uid=1000 gid=1000 groups=1000
 ff d8 ff e0                                        # still readable, OCR still returns 200
```

Both belong in stage B's compose service.

So the plumbing is sound — but §2 means **nothing can ask the engine to open that file**. The TS server
will read the bytes and post them.

**Recommendation:** keep the read-only mount anyway. It costs nothing, it is what the specification
asks for, and it is the difference between a one-line change and a redeployment if a future image ever
accepts a path. Say so in the compose comment, so the next reader does not assume it is load-bearing.

---

## 4. What one image costs

All figures are the HTTP round trip measured with `curl -w %{time_total}` over loopback, 25 sequential
requests after warm-up, one image (`94530004`, the 1200×1600 upload variant, 223 KB). The container
reports no timing of its own — §6 — so this is the closest thing to `engineMs` that exists.

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

**The two runs reconcile here.** The first run measured a warm median of **2.974 s** with
`IQR/median = 11.28 %` over 10 requests — which looks like a different engine until you notice it ran
at `--cpus=1.0`, where the second run independently measured **2.867 s**. A 3.6 % difference between
two people, two days and two harnesses. The apparent gap was the CPU cap, not the engine, and **neither
document says so on its own** — which is the argument for having run it twice.

Three things follow from the table.

**The co-tenancy tax is small but the noise is not.** B1 against C is the same container differing only
in whether eight production containers were running: the median moves 7 % while the spread triples
(12.0 % → 4.1 %). ADR-18's insistence on distributions rather than single numbers is vindicated — and
so is criterion 13's 20 % threshold, which every configuration met comfortably. **Criterion 13 is
achievable as written.**

**The CPU cap dominates everything else.** Halving 1.5 → 1.0 costs 55 %; going to 0.5 costs 245 %.
Thread settings barely register next to it on two cores.

**These are inference numbers only.** The phone's upload over mobile data and the nginx hop are on top.

### Cold start

Cold start is **per worker and per input size**, not once per container.

```
2 workers, --cpus=1.5, three container restarts:
  round 1:  3.660  2.104  3.363  1.963  1.895  1.713
  round 2:  3.991  1.918  3.616  1.893  2.011  1.761
  round 3:  3.603  3.136  2.284  1.656  1.802  1.939
```

Two requests pay the penalty, not one, because the round-robin hands the second request to the other
worker's cold process. With one worker there is exactly one cold request: **3.4–3.9 s at `--cpus=1.5`**
(the first run measured 5.37–5.77 s at `--cpus=1.0`, consistent with the second run's 4.96–5.09 s).
Warm is roughly half of cold in every configuration.

Separately, the **first request at a new input size is cold again**: on a container already warm on
1200×1600, the first 3000×4000 image took 6.50 s and the next four took 3.16–3.46 s. **A warm-up with
one dummy image — phase 07 item 16 — only covers the size it used.**

### Image size

Warm, same container, same capture:

| Input | Warm range |
| --- | --- |
| 1200×1600 upload variant (223 KB) | 1.79 – 2.24 s |
| 3000×4000 original (3.0 MB) | 3.16 – 3.46 s |
| 6000×4500 original (16.5 MB) | 2.98 – 3.21 s, and it returned `{}` — no text detected |

Originals cost roughly 1.8× the upload variant. RapidOCR clamps the long side to 2000 px internally
(`Global.max_side_len`), which is why 6000×4500 is not proportionally worse.

### Concurrency

One worker, `--cpus=1.5`, two simultaneous requests: **4.529 s and 4.106 s against 1.906 s solo.**
Worse than serialising — FastAPI runs the synchronous handler in a threadpool, so both requests execute
and fight over the same cores. The app triggers one method at a time by design, so this is a note
rather than a problem; but stage B should not add concurrency, and if a second request can ever
overlap, the server should queue it.

---

## 5. Resident memory

| Configuration | Peak |
| --- | --- |
| 2 workers (stock command) | **978.2 MiB** (`docker stats`) |
| 1 worker | **644.4 MiB** (`docker stats`) · `VmRSS` 437.9 MiB, **`VmHWM` 625.9 MiB** (`/proc/1/status`) |
| 1 worker, threads capped | 626.7 – 638.3 MiB |

The two methods agree within 3 %. `/proc/1/status` is the better instrument and comes from the first
run; `docker stats` sampled continuously through a 25-request series comes from the second.

The stock image sits at the very edge of the ~1 GB budget purely because it loads the models twice.
**One worker is the single most valuable configuration change available**: it costs nothing in latency
(1.854 s against 1.922 s, inside the noise) and returns 334 MiB to a box with no swap.

A `--memory=1g` limit was exercised throughout §7 with no OOM kill. **768 MiB would be tight; 1 GB is
the right `mem_limit`.**

---

## 6. What the response contains

```json
{
  "0": { "rec_txt": "3b5050Λ",        "dt_boxes": [[678,199],[796,254],[779,292],[661,237]], "score": 0.7999  },
  "5": { "rec_txt": "TOeHA0:07/2027", "dt_boxes": [[312,907],[739,909],[739,962],[312,960]], "score": 0.79417 }
}
```

An object keyed by stringified index. Per block: text, **a four-point quadrilateral**, and a
**confidence in 0–1**. No text is `{}` with HTTP 200.

Consequences for the adapter, each a real piece of stage B work:

- **`bbox` needs converting.** ADR-5 fixes `[x, y, width, height]`, axis-aligned; the engine returns a
  rotated quad. The axis-aligned bounding box of the quad is the honest conversion; the rotation is
  information we discard, and that earns a comment rather than silence.
- **The coordinates are in the uploaded image's own pixel space.** Verified in `rapidocr/main.py`,
  which multiplies the boxes back by the preprocessing ratio (`dt_boxes_array[:, :, 0] *= ratio_w`).
  So `imageWidth` / `imageHeight` are the dimensions the server already has from `sharp`.
- **`confidence` maps straight across.** Observed 0.58–0.999; ADR-5's `null` case does not arise here.
- **`rawText` has to be assembled.** No joined string, and block order is detection order, not reading
  order.
- **Errors have no JSON shape.** Corrupt input, a truncated JPEG and an empty POST all return HTTP 500
  with the plain string `Internal Server Error`. The adapter must treat any non-200 as an engine
  failure and cannot parse a body. `{}` with 200 is the distinct, legitimate "no text" case.
- **There is no engine timing** — see the stage B gate section.

### Can `anchor-proximity` ever fire? Yes. Did it? No.

Boxes and confidences are present, so ADR-4's positional rule is reachable on this engine, unlike the
VLM path. Whether it actually fires was settled by running the ten upload variants through the engine
and feeding the blocks to the **real shared parser** (`parseExpiryDate` from `packages/shared`), quad
converted as above:

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

Seven parse, **every one by `sole-candidate`.** The anchor rule never got the chance, because the
engine never produced two competing candidates. Before any effort goes into anchor tuning for this
path: the constraint is finding *one* candidate, not choosing between several. (The only
`anchor-proximity` hit anywhere in this investigation came from the Tesseract hybrid in 07b.)

Cross-check: on `94530004` the stored on-device attempt recorded `expiry.date = 2027-07-31`,
`raw = "07/2027"` — the same answer from a different engine on a different variant.

---

## Why the three failures are one failure

Reading the parser's rejected candidates and then looking at the actual pixels turns three unrelated
misses into a single, specific weakness.

| Image | Real date | Print method | What the engine read |
| --- | --- | --- | --- |
| `974b2984` | **16.10.26** | **dot-matrix** | nothing. `04-2503` is a rotated pre-printed code, which the parser then rejected as "year 2503" |
| `f058471e` | **L 21.06.2026** | **dot-matrix** | `2026`, `004`, `136` — fragmented |
| `2134860f` | unreadable by eye — jar lid, rotated ~45°, out of focus | **dot-matrix** | `8.61分5` |
| `94530004` *(a success)* | **Годен до: 07/2027** | continuous glyphs, thermal | clean, score 0.98 |

**Every miss is dot-matrix. Every verified success is continuous-glyph print.** The engine reads the
dates that are easy to read and misses the ones that dominate real packaging.

`2134860f` is worth separating out: it is out of focus and rotated. No engine fixes that, and it is
an argument for capture guidance in the app rather than for a different OCR.

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

**All three or none** — setting only the recogniser silently changes nothing. The detection and
classification paths can point at the models already inside the image.

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
route out**, to prove no run-time download is involved:

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
| PP-OCRv5 mobile ch (downloaded) | 4 / 10 | Reads `/` as `1` — `0712027` — on four images, and **one of the four is a fabricated date** |
| Cyrillic PP-OCRv3 (downloaded) | 1 / 10 | And that one is **wrong**: `18.12` where the date is `16.12.2026` |

The failure mode is specific and consistent. On `94530004` the same date line reads:

```
v4 ch/en   "TOeHA0:07/2027"      → parses to 2027-07-31
cyrillic   "oдeн 40. 0:+202?"    → nothing
v5 ch      "ToneH AO:" "0712027" → nothing
```

The Cyrillic model does what it says — `Паpt.N` for «Парт.№» where the ch model gives `napT.No`, and
`Heoвopeн най-дobp до` for «Неотворен най-добър до» — but it mangles digits, and digits are the entire
measurement. PP-OCRv5 is both slower (median 2.622 s against 1.854 s) and less accurate here, so the
newer version is not an upgrade for this task.

**This settled ADR-12**, which had posed feasibility as the deciding question. Feasibility is a yes and
it does not matter: `onnx-paddleocr-cyrillic` is deferred rather than built, on the measurement above.

### A parser change moved one of these numbers

Re-scoring the captured engine outputs against `parser-v2` left seven of the eight configurations
measured here unchanged — the chosen engine included, at 7/10 with the same seven images. **PP-OCRv5
moved from 3/10 to 4/10, and the extra is a fabricated date.**

On `974b2984`, whose real best-before is `16.10.26`, v5 emits a noise block `1.10` alongside the
rotated pre-printed code `04-2503`:

```
candidates: [ { raw: "04-2503", date: "2503-04-30", rejectedFor: "more than 10 years…" },
              { raw: "1.10",    date: "2026-10-01", rejectedFor: null } ]
chosen: 2026-10-01, day precision, status "valid", rule anchor-proximity
signals: ["multiple-candidates","anchor-matched","ambiguous-numeric"]
```

Under `parser-v1` the sanity window ran last on the *chosen* candidate, so the implausible 2503 date
won the deciding rule and was then discarded — the wrong answer masked the noise and the image
returned nothing. ADR-21 moved the window ahead of the rule, exactly as it argues it should; the
consequence on this input is that the surviving noise candidate now wins on its own.

That is not an argument against ADR-21 — the old behaviour was accidental, not protective. It is worth
recording for two other reasons. **A fabricated date is worse than a miss**, and this one carries
`status: "valid"`. And it is the second time `anchor-proximity` has fired anywhere in this
investigation — the first was a correct hit in the Tesseract hybrid of 07b — which means **the rule
ADR-4 treats as the most trustworthy has a 1-in-2 record on real data here.** Its `signals` do record
`ambiguous-numeric`, so the evidence is preserved; whether the results view leans on the rule name is
a question for phase 10.

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
`<site-packages>/rapidocr/config.yaml`. Three knobs, all configuration:

| Knob | How | Effect measured |
| --- | --- | --- |
| **Worker processes** | `-workers N` on the command line | 2 → 1 saves **334 MiB**, no latency cost |
| **ONNX threads** | bind-mount a replacement `config.yaml` over the packaged one | `intra_op=1` holds the container to **101.4 % CPU** instead of ~153 %, at +25 % latency |
| **CPU share** | `cpus:` in Compose | The dominant control — §4 |

The mounted-configuration route was verified, not assumed: copying the file out, editing two lines and
mounting it back changed the observed CPU ceiling, which is what proves it took effect.

```
peak cpu, default threads:  152.9 %   median 1.854 s
peak cpu, intra=1 inter=1:  101.4 %   median 2.321 s
```

### The default is safe on two cores and dangerous on more

**`nproc` inside a container started with `--cpus=N` still reports the host's core count.**

```
$ nproc                                   # 32-core host
32
$ docker run --rm --cpus=8 busybox nproc
32
```

So ONNX Runtime's default (`intra_op_num_threads: -1`) sizes its pool from 32 while the cgroup grants
8 CPUs of runtime — 4× oversubscription across hard synchronisation barriers. With the server-variant
models this is not "slower": **a single request did not return in ten minutes at a sustained 800 % CPU.**
Pinning the threads through the mounted `config.yaml` fixed it immediately.

On the two-core VPS this is invisible, because the default resolves to 2 threads for 2 cores — which is
why both spikes recommended leaving it alone, and why that recommendation needs its condition stated.

**Recommendation for stage B:** one worker, `cpus: 1.5`, `mem_limit: 1g`, `user: "1000:1000"`,
read-only root filesystem, and ONNX threads left at their default **on this box only**, with a comment
naming the reason. Any move to a larger host must pin the thread count in the same commit. Note that
`server` is already at `cpus: 1.5` on the same two cores — the two are never busy simultaneously on
this workload, but the sum is deliberate overcommit and belongs in the compose comment.

---

## 9. Mobile versus server models

Already answered by the default configuration — the bundled models **are** the mobile ones:

```yaml
Det:  lang_type: "ch"   model_type: "mobile"   ocr_version: "PP-OCRv4"
Rec:  lang_type: "ch"   model_type: "mobile"   ocr_version: "PP-OCRv4"
```

```
$ docker exec spike-ocr ls -la …/rapidocr/models/
 4745517  ch_PP-OCRv4_det_infer.onnx          # mobile; the server variant is ~113 MB
10857958  ch_PP-OCRv4_rec_infer.onnx          # mobile; the server variant is ~90 MB
  585532  ch_ppocr_mobile_v2.0_cls_infer.onnx
```

The server variants are selectable the same way as the Cyrillic model — `model_type: server` in a
mounted `config.yaml`, or a downloaded `*_server_infer.onnx` and the env vars of §7. They do not fit
this box at 644 MiB resident for the mobile pair, so the specification's preference and ADR-18's
constraint agree here.

They were later tested on hardware that could hold them, and the answer is that nothing was being
missed: **30–150× slower for no accuracy gain** — see "Would more hardware change any of this?" below.

So phase 07 item 20 — "select the mobile models explicitly" — needs no code. It needs the model **names
in the README** and a note that they are the image's defaults, so a future image change that quietly
ships something else is visible as a difference rather than absorbed as noise.

---

## The stage B gate: there is no inference duration, and no alternative that has one

The response carries no timing field. The **first run found the root cause**, which the second then
verified line by line:

```
rapidocr/utils/output.py:26   elapse_list: List[Union[float, None]]
rapidocr/main.py:275          elapse_list=[det_res.elapse, cls_res.elapse, rec_res.elapse]
rapidocr_api/main.py:53       out_dict[i] = {"rec_txt": …, "dt_boxes": …, "score": …}
```

The library measures detection, classification and recognition separately. The API wrapper builds a
fresh dictionary of three fields and discards them. There is no route option that preserves
`elapse_list`, and parsing container logs is not a third way: no request correlation under concurrency,
and the image does not log durations anyway.

**Phase 07 item 19 and ADR-10 are therefore wrong as written.** Item 19 says `engineMs` is "time inside
the container as it reports it"; ADR-10 says "the sidecar and ML Kit report `inference`". Neither is
achievable with this image.

The first run proposed finding a different image that does report it, and preferred that because it
preserves ADR-10. **That option has since been closed by elimination:**

- **`rapidocr_api` 0.2.0 is the final release** — uploaded 2025-05-22, nothing since, checked
  2026-07-31. Every image in that family wraps the same package and has the same defect.
- **`jarvis1tube/paddleocr-server`, the specification's named alternative, reports no timing either.**
  Pulled by digest and probed: every scalar path in the response was scanned for
  `time|elapse|duration|ms` — zero hits. It also **cannot run on this box**: `VmHWM` peaked at
  **2.42 GB** against ~2.1 GB available with no swap and a live Postgres. See "Would more hardware change any of this?".
- **Tesseract's HTTP server reports no timing either** — 07b.

Two options went to the checkpoint:

1. **`engineMs` = the whole sidecar HTTP call, `engineMsScope: "inference+network"`.** Honest, and it
   makes `serverTotalMs - engineMs` the Fastify handler's own overhead rather than the process
   boundary, which must be said in the README.
2. The same, plus a one-off transport calibration in the README as an upper bound on what moving OCR
   in-process could save.

**Decided 2026-07-31: option 1.** ADR-10 is amended accordingly and phase 07 item 19 is rewritten. The
consequence to accept knowingly is that "is the process boundary worth removing?" — the question the
specification's *§ Gotchas* line exists to answer — has no figure behind it in this harness. Nothing
prevents measuring the transport deliberately later; it simply is not part of stage B.

---

## Would more hardware change any of this? No

Measured rather than assumed, on a 32-core / 62 GB / RTX 4080 workstation, same ten images, same
parser.

**Control — same models, bigger machine.** Same image, same mobile models, 8 CPUs instead of 1.5:
median **1.496 s** against 1.854 s, and **the identical 7/10 with the identical misses**. Five times
the cores buys 19 %; ONNX does not scale past roughly two cores on this workload, and accuracy does not
move at all.

**Server-variant models — the thing the 1 GB budget forbade.** `ch_PP-OCRv4_det_server_infer.onnx`
(113 MB) and `ch_PP-OCRv4_rec_server_infer.onnx` (90 MB), thread-pinned per §8:

| Image | Print | Server models | Mobile, for reference |
| --- | --- | --- | --- |
| `94530004` | continuous | `07/2027` ✓ in **48.8 s** | `07/2027` ✓ in 1.5 s |
| `f058471e` | **dot-matrix** | no date | no date |
| `974b2984` | **dot-matrix** | no date, in **234 s** | no date |
| `2134860f` | **dot-matrix** | `8.64分 \| PESTO \| GENOVI` | nothing |

**0 of 3 dot-matrix, exactly as mobile, at 30–150× the latency.** They do buy something real — far more
of the small offset-printed text, word by word where mobile merged it — but the benchmark does not
measure that.

**PaddleOCR server** (`jarvis1tube/paddleocr-server@sha256:2276d460…`, 5.66 GB on disk): endpoints
`POST /ocr` (base64 or an HTTP URL) and `POST /ocr/upload` (multipart) — **still no filesystem path**.
Response carries `rec_texts`, `rec_scores`, `rec_polys` and `rec_boxes` as `[x1,y1,x2,y2]`, which is
closer to ADR-5's format than a quad. Cold 16.6 s, warm 2.62–2.89 s on 8 cores. `VmRSS` 1.44 GB,
**`VmHWM` 2.42 GB**. Its start-up checks connectivity to model hosters unless
`DISABLE_MODEL_SOURCE_CHECK=True`. Accuracy: **7 of 10 — the same seven, the same three misses.**

**Conclusion.** Four independent engines — RapidOCR mobile, RapidOCR server, PaddleOCR server, and
Tesseract with Bulgarian data — read **0 of 3** dot-matrix dates. That is no longer a property of one
engine; it is the ceiling of CPU OCR on this input, and hardware does not move it. A GPU would, but the
engine that reads dot-matrix by context is a VLM, and the benchmark already has that column in phase
09 — so the harness will discover this on its own, which is the right outcome. Moving the self-hosted
engine to different hardware would also break `costEstimateUsd: 0` (ADR-11 justifies it as sunk VPS
capacity) and the same-conditions framing of ADR-18.

---

## What this changes for stage B

**Configuration to carry forward**

```yaml
image: qingchen0607/rapid-ocr-api@sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c
command: ["bash","-c","rapidocr_api -ip 0.0.0.0 -p 9005 -workers 1"]   # one worker: -334 MiB, no latency cost
user: "1000:1000"          # verified working; the image defaults to root
read_only: true            # verified working
cpus: 1.5
mem_limit: 1g              # peak observed 644 MiB (VmHWM 626 MiB)
```

Internal network, no published ports, image volume mounted `:ro`, models left at the image defaults,
ONNX threads left at the default **with a comment naming the two-core condition**. Engine string
`onnx-paddleocr`; `costEstimateUsd: 0` per ADR-11.

**Two corrections the phase document needs**

1. **Item 19 and ADR-10 on `engineMs`** — see the stage B gate section. The alternative has been eliminated, so this is now a
   choice between two honest labellings, not a choice between fixing and fudging.
2. **Item 12's "removes a pointless read-and-re-encode cycle" does not apply.** The engine cannot be
   given a path. The mount stays because the specification asks for it and because it is free, but the
   compose file should say plainly that it is presently unused.

**Decisions at this checkpoint**

- **`engineMs` — settled 2026-07-31: option 1 of the stage B gate section.** `engineMsScope: "inference+network"`, ADR-10
  amended, phase 07 item 19 rewritten. Stage B is unblocked.
- **Models:** keep the bundled PP-OCRv4 **mobile ch/en** as `onnx-paddleocr`. Under `parser-v2`, 7/10
  against 4/10 for PP-OCRv5 — one of which is fabricated — 1/10 for Cyrillic, 1/10 for Tesseract and
  7/10 for PaddleOCR server at five times the memory. It is also the fastest of all of them.
- **Cyrillic — settled 2026-07-31: `onnx-paddleocr-cyrillic` is deferred, not built.** The first run
  recommended building it as ADR-12 requires; that run had no accuracy data and said so. The
  measurement now exists and says it makes the self-hosted path worse, and that its benefit — matchable
  Bulgarian anchors — addresses a constraint §6 shows is not binding. ADR-12 is amended and accepted on
  that basis. The `method` enum entry and price-table key stay, so adding the engine later is a compose
  service rather than a schema change and a migration.
- **The dataset** — not a phase 07 task, but a prerequisite for phases 08–10 meaning anything. Ten
  photographs of five products, six of them one box, cannot carry an accuracy claim.

**State of the box**

Spike containers, the internal network and the pulled `curl` image were removed; production was
verified healthy afterwards — eight containers up, `emerald`, `garden` and `scanner` all answering 200.
`~/spike-07/` keeps the harness, the raw timings and the downloaded models with their checksums. On the
workstation, the RapidOCR and PaddleOCR images and all downloaded models were removed after use.
