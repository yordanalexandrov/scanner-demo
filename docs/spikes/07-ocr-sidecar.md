# Phase 07 stage A: OCR sidecar spike

**Status:** complete on 2026-07-30; stage B has not started.

## Outcome

The tested image is:

```text
qingchen0607/rapid-ocr-api@sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c
```

It is a usable CPU-only RapidOCR API within this host's memory budget. It accepts an HTTP image
upload, returns per-block quadrilateral boxes and confidences, uses mobile PP-OCR models by default,
and can use the Cyrillic recognition model through a read-only mount and environment variables.

It does **not** satisfy the stage B timing contract as written. The API response omits the inference
duration even though the RapidOCR library computes component durations internally. The TypeScript
server could measure only the complete HTTP call, which includes the process boundary and therefore
cannot be stored as `engineMs` with `engineMsScope: "inference"` under ADR-10.

Stage B must not start until the review checkpoint chooses one of these:

1. Find and spike a different pre-built CPU image whose HTTP response includes its internal
   inference duration. This is the recommended option because it preserves ADR-10.
2. Amend ADR-10 and the phase document to add a separately named sidecar-request duration. It must
   not be called inference time.

Parsing container logs is not a viable third option: it has no request correlation under
concurrency, and the tested image does not log inference duration anyway.

## Test conditions

All host commands were run over SSH on `Emerald` at 14:00-14:11 UTC on 2026-07-30. The test used an
existing Library image, not a manually placed fixture:

```text
/data/images/94530004-ec35-41a2-9250-75e4daa30b73.jpg
size: 223013 bytes
owner: 1000:1000
mode: 0644
sha256: 2e5b6c9bc30ed6f3e33be420a9ca31b1491082203b533b091c842a8c5eb7b3d4
```

The temporary container had:

```text
workers: 1
cpus: 1.0
memory limit: 1 GiB
memory reservation: 512 MiB
root filesystem: read-only
image volume: scanner-demo_scanner-images:/data/images:ro
network: dedicated Docker --internal network
published ports: none
```

The host baseline immediately before the spike was:

```console
$ hostname; free -m; uptime
Emerald
               total        used        free      shared  buff/cache   available
Mem:            3819        1718         354          57        2099        2101
Swap:              0           0           0
 14:00:06 up 50 days, 17:03,  1 user,  load average: 0.25, 0.36, 0.37
```

Eight `garden-prod_supabase-*` containers, the scanner server, nginx, Postgres, and the two
production sites were running. The five Supabase containers with health checks were healthy, and
the three public health probes returned 200:

```text
emerald 200
garden 200
scanner 200
```

After cleanup the same containers were up, the scanner server was healthy, all three probes still
returned 200, and available memory was 2058 MiB.

## 1. Image and digest

The selected pre-built image contains `rapidocr_api`, uses ONNX Runtime on CPU, and is amd64:

```console
$ docker pull qingchen0607/rapid-ocr-api:v20250619
Digest: sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c

$ docker image inspect qingchen0607/rapid-ocr-api:v20250619 \
    --format 'Id={{.Id}} RepoDigests={{json .RepoDigests}} Created={{.Created}} Size={{.Size}}'
Id=sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c
RepoDigests=["qingchen0607/rapid-ocr-api@sha256:a1445b36179ec4218740035b5688c50b40ed46f576b394e95e9582ec44be966c"]
Created=2025-06-19T18:09:53.585520542+08:00
Size=253590211

$ docker exec scanner-ocr-spike pip show rapidocr-api rapidocr onnxruntime
Name: rapidocr-api
Version: 0.2.0
Name: rapidocr
Version: 3.2.0
Name: onnxruntime
Version: 1.22.0
```

The image config exposes port 9005 and defaults to two workers:

```json
{
  "ExposedPorts": { "9005/tcp": {} },
  "Cmd": ["bash", "-c", "rapidocr_api -ip 0.0.0.0 -p 9005 -workers 2"]
}
```

The spike overrode this to one worker. The digest, not the tag, is the candidate for Compose.

## 2. Input modes

The runtime OpenAPI document exposes `POST /ocr` with these multipart form fields:

```json
{
  "image_file": { "format": "binary" },
  "image_data": { "type": "string" },
  "use_det": { "type": "boolean" },
  "use_cls": { "type": "boolean" },
  "use_rec": { "type": "boolean" }
}
```

`image_file` is a normal multipart upload and `image_data` is base64 in a form field. There is no
filesystem-path field. A real multipart request returned 200:

```console
$ curl -F image_file=@94530004-ec35-41a2-9250-75e4daa30b73.jpg \
    http://172.20.0.2:9005/ocr
HTTP=200 total_s=5.771909
```

**Chosen mode:** multipart upload. The shared image volume can avoid a decode/re-encode in the
TypeScript server, but it cannot avoid copying the original bytes into the HTTP request with this
image.

## 3. Shared-volume access and UID

The container runs as root. The named volume was mounted read-only and had no host port:

```console
$ docker ps --filter name=scanner-ocr-spike \
    --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
scanner-ocr-spike  Up 3 seconds  9005/tcp

$ docker inspect scanner-ocr-spike --format \
    'ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} Mounts={{json .Mounts}}'
ReadonlyRootfs=true
Mounts=[{"Destination":"/data/images","Mode":"ro","RW":false,...}]
```

The process could read and hash a file written by the TypeScript server's UID:

```console
$ docker exec scanner-ocr-spike sh -lc \
    'id; stat -c "%n uid=%u gid=%g mode=%a size=%s" /data/images/94530004-ec35-41a2-9250-75e4daa30b73.jpg; sha256sum /data/images/94530004-ec35-41a2-9250-75e4daa30b73.jpg'
uid=0(root) gid=0(root) groups=0(root)
/data/images/94530004-ec35-41a2-9250-75e4daa30b73.jpg uid=1000 gid=1000 mode=644 size=223013
2e5b6c9bc30ed6f3e33be420a9ca31b1491082203b533b091c842a8c5eb7b3d4  /data/images/94530004-ec35-41a2-9250-75e4daa30b73.jpg
```

Filesystem access therefore works, but the HTTP API cannot consume the path. The TypeScript adapter
must open the server-constructed path and upload those bytes.

## 4. Cold and steady-state latency

These figures are `curl`'s same-host Docker-bridge HTTP `time_total`, not engine-only inference
times. That distinction is mandatory because the response provides no internal timing.

The first inference after the initial start was 5771.909 ms. The first inference after a full
container restart was 5367.719 ms:

```text
initial first request:  5.771909 s
restart first request:  5.367719 s
```

Ten consecutive requests after warm-up, with a one-second pause between requests, were:

```text
3.167343  3.171451  3.060372  3.114729  2.978169
2.779275  2.763813  2.739064  2.969373  2.854332
```

Using Tukey hinges:

```text
median: 2973.771 ms
Q1:     2779.275 ms
Q3:     3114.729 ms
IQR:     335.454 ms
IQR / median: 11.28%
```

The host load average after the warm series was `0.78, 0.63, 0.48`; all Supabase containers were
still up and all configured health checks were healthy.

## 5. Resident memory

Before the first inference, `docker stats` reported 110.1 MiB. Immediately afterwards it reported
400.7 MiB. A fresh stock-model process measured after one inference reported:

```console
$ grep -E '^(VmRSS|VmHWM|Threads):' /proc/1/status
VmHWM:   640960 kB
VmRSS:   437876 kB
Threads: 10

$ grep -E '^(Rss|Pss):' /proc/1/smaps_rollup
Rss:     437876 kB
Pss:     436884 kB
```

Resident memory was therefore about 427.6 MiB, with an observed high-water mark of about 625.9 MiB.
The stock image fits the roughly 1 GiB budget. A 1 GiB hard limit leaves useful headroom over the
observed peak; a 512 MiB limit would be unsafe.

The Cyrillic-model run was similar: 433472 kB `VmRSS` after inference.

## 6. Response shape

The response is an object keyed by block index. Each block has recognised text, a four-point
quadrilateral, and a numeric confidence:

```json
{
  "4": {
    "rec_txt": "62H24",
    "dt_boxes": [
      [534.0, 859.0],
      [680.0, 859.0],
      [680.0, 904.0],
      [534.0, 904.0]
    ],
    "score": 0.99196
  },
  "5": {
    "rec_txt": "TOeHA0:07/2027",
    "dt_boxes": [
      [312.0, 907.0],
      [739.0, 909.0],
      [739.0, 962.0],
      [312.0, 960.0]
    ],
    "score": 0.79417
  }
}
```

The adapter can convert each quadrilateral to the shared `[x, y, width, height]` pixel format.
`anchor-proximity` can therefore run for this engine. Confidence is available and already in the
0-1 range.

The response contains no flat aggregate string and no timing field.

## 7. Model, dictionary, and Cyrillic configuration

`rapidocr_api` reads exactly three model environment variables:

```text
det_model_path
cls_model_path
rec_model_path
```

All three must be present; if any is absent, the wrapper constructs a completely stock `RapidOCR`
instance. The spike mounted the upstream Cyrillic ONNX model read-only and passed:

```text
det_model_path=/usr/local/lib/python3.10/site-packages/rapidocr/models/ch_PP-OCRv4_det_infer.onnx
cls_model_path=/usr/local/lib/python3.10/site-packages/rapidocr/models/ch_ppocr_mobile_v2.0_cls_infer.onnx
rec_model_path=/models/cyrillic_PP-OCRv3_rec_infer.onnx
```

The downloaded model matched the SHA256 recorded in RapidOCR's installed model manifest:

```console
$ sha256sum /tmp/scanner-ocr-spike-models/cyrillic_PP-OCRv3_rec_infer.onnx
1efb65bdc460af1c0e8733d005b20952b17ca5aac10ddb56c968333791c5eaa3  .../cyrillic_PP-OCRv3_rec_infer.onnx
```

Startup confirmed that the mounted model was selected:

```text
Using /models/cyrillic_PP-OCRv3_rec_infer.onnx
Uvicorn running on http://0.0.0.0:9005
```

The request succeeded and emitted Cyrillic characters, which proves reachability through
configuration:

```json
{
  "3": {
    "rec_txt": "\u041f\u0430pt.N",
    "score": 0.80801
  },
  "5": {
    "rec_txt": "o\u0434e\u043d 40. 0:+202?",
    "score": 0.73087
  }
}
```

This single sample does not establish Cyrillic accuracy; the text was visibly imperfect.

There is no `rec_keys_path` environment variable in the API wrapper. For the ONNX backend this does
not block Cyrillic: RapidOCR reads the character list from the ONNX model's embedded metadata, and
the mounted Cyrillic model exercised that path. A separate mounted dictionary cannot be selected
through this API.

**Answer:** Cyrillic recognition is reachable through configuration alone by mounting the
Cyrillic ONNX model and setting all three model-path variables. It should remain a separately
labelled `onnx-paddleocr-cyrillic` engine as required by ADR-12.

## 8. Thread and concurrency controls

The CLI exposes process concurrency, not a thread environment variable:

```console
$ rapidocr_api --help
usage: rapidocr_api [-h] [-ip IP] [-p PORT] [-workers WORKERS]

  -workers WORKERS, --workers WORKERS
                        number of worker process
```

The wrapper's only environment-variable reads are the three model paths above. RapidOCR's internal
configuration contains `intra_op_num_threads` and `inter_op_num_threads`, but `rapidocr_api` exposes
neither a config-path argument nor environment variables for them.

**Answer:** use `-workers 1` and a Compose `cpus:` hard limit. This image exposes no supported
thread-count environment variable. The tested process had ten threads after inference, all bounded
by the one-CPU cgroup quota.

## 9. Mobile/lightweight model selection

The installed RapidOCR configuration explicitly says `model_type: "mobile"` for detection,
classification, and recognition. Stock startup selected:

```text
ch_PP-OCRv4_det_infer.onnx
ch_ppocr_mobile_v2.0_cls_infer.onnx
ch_PP-OCRv4_rec_infer.onnx
```

The manifest distinguishes these from `ch_PP-OCRv4_det_server_infer.onnx` and
`ch_PP-OCRv4_rec_server_infer.onnx`. The stock paths are therefore already the lightweight variants.
The model-path environment variables also allow those mobile files to be selected explicitly in
Compose.

The Cyrillic option is the multilingual `cyrillic_PP-OCRv3_rec_infer.onnx`, mounted by digest-checked
content as shown above.

## Stage B gate: missing inference duration

The runtime response and OpenAPI schema have no timing field. Read-only inspection of the installed
packages explains why:

- `rapidocr` builds a result with `elapse_list` containing detection, classification, and
  recognition durations.
- `rapidocr_api` converts that result to a new object containing only `rec_txt`, `dt_boxes`, and
  `score`, then returns it.

There is no route option that preserves `elapse_list`. Consequently:

```text
available to the TypeScript server:
  complete sidecar HTTP request duration

not available:
  inference-only duration reported by the sidecar
  transport/process-boundary duration by subtraction
```

Calling the HTTP duration `engineMs` would make `serverTotalMs - engineMs` measure only the Fastify
handler's work outside the HTTP call, not the sidecar process boundary required by ADR-10 and stage
B item 19. Stage B would produce precise-looking but false segmentation, so it is intentionally
blocked at this checkpoint.
