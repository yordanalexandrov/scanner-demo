# Spike — Tesseract as an alternative self-hosted engine

**Run on 2026-07-31**, immediately after [07-ocr-sidecar.md](07-ocr-sidecar.md) and on the same box,
the same ten Library images, the same limits and the same parser. It is a **follow-up to that spike,
not part of phase 07's scope** — nothing here is a phase 07 deliverable and nothing under `server/src`
was written.

The question it answers: the RapidOCR sidecar reads a parseable expiry date on 7 of 10 real packaging
photographs, and its Cyrillic option makes that worse rather than better. **Is there a self-hosted
engine on this box that does better?**

**Answer: no. Tesseract reads 1 of 10.** But *why* it fails is worth more than the score, because it
is not the reason one would guess.

---

## What was compared, and how the comparison was kept fair

Everything that could differ was held fixed, because a comparison measured two different ways is worth
nothing:

| | |
| --- | --- |
| Images | The same ten `upload` variants (1200×1600) from the Library |
| Limits | `--cpus=1.5`, `--memory=1g`, one process |
| Conditions | Production Supabase stack **running** throughout — comparable with case B1 of the first spike |
| Latency | `curl -w %{time_total}` from the host over loopback, 25 sequential requests after warm-up |
| Accuracy | The **same `parseExpiryDate` from `packages/shared`**, same `referenceDate`, differing only in the adapter that turns each engine's output into `Block[]` |
| Parser | `parser-v2` throughout — every figure below was re-scored after ADR-21 landed on `main`, and none of them moved |

Both adapters are in the scratchpad probes, not in the repository. The Tesseract one groups TSV words
into lines by `(block, par, line)`, unions their boxes and averages their confidences, because
RapidOCR returns line-level regions and comparing lines against words would be a different measurement.

---

## Headline comparison

| | RapidOCR sidecar | tesseract-server |
| --- | --- | --- |
| Image | `qingchen0607/rapid-ocr-api@sha256:a1445b…` | `hertzg/tesseract-server@sha256:29f62caf…` |
| Size on disk | 997 MB | **558 MB** (146 MB download) |
| Inside | Python 3.10, FastAPI, onnxruntime | **Deno + TypeScript**, tesseract 5.5.1 |
| Maintenance | one person, last push 2025-06-19 | **active — 3.1.2 on 2026-04-30, git builds to 2026-06-19, semver tags** |
| **Dates parsed, 10 images** | **7 / 10** | **1 / 10** |
| Warm median | 1.854 s | **1.348 s** (`tessdata_fast`) / 2.226 s (full `tessdata`) |
| Cold start | 3.4–3.9 s, ~2× warm | **none measurable** — first request 2.271 s against a 2.226 s median |
| Ready after start | 1.9–2.4 s | **0.77 s** |
| Peak RSS | 644 MiB | **85.6 MiB** |
| Boxes | 4-point quad, needs conversion | **`[x, y, w, h]` directly — already ADR-5's format** |
| Confidence | 0–1 per region | 0–100 per word, averaged per line |
| Engine timing in response | none | none |

Tesseract wins on **every engineering axis** — a seventh of the memory, a quarter of the startup, no
cold start, a smaller and far better maintained image, a better-shaped response, and TypeScript rather
than Python inside a container this repository is not allowed to open. It loses on the only axis that
decides the phase.

---

## Configuration: Bulgarian works, offline, by mount

Same pattern that worked for the Cyrillic ONNX model. The image bundles seven languages and **not
Bulgarian**:

```
$ docker exec spike-tess tesseract --list-langs
List of available languages in "/usr/share/tessdata/" (7):
deu eng fra kat pol rus spa
```

`TESSERACT_SERVER_INSTALL_LANGUAGES` would fetch more at start-up, which is useless behind an internal
network with no route out. Bind-mounting the traineddata file works instead, and all three upstream
variants were tested side by side:

```
$ curl -sSL -o bul.tessdata_fast.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/bul.traineddata   # 1.7 MB
$ curl -sSL -o bul.tessdata_best.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/bul.traineddata   # 8.8 MB
$ curl -sSL -o bul.tessdata.traineddata      https://github.com/tesseract-ocr/tessdata/raw/main/bul.traineddata        # 8.4 MB

$ docker run -v $PWD/bul.tessdata_fast.traineddata:/usr/share/tessdata/bulfast.traineddata:ro …
$ docker exec spike-tess tesseract --list-langs
… (10): bul bulbest bulfast deu eng fra kat pol rus spa
```

**Per-block boxes and confidences are available**, through `configParams`, which is what the README
leaves vague:

```
options={"languages":["bul"],"pageSegmentationMethod":6,"dpi":300,
         "configParams":{"tessedit_create_tsv":"1"}}

level page_num block_num par_num line_num word_num left top width height conf     text
5     1        1         1       1        1        290  533 99    65     1.711693 5
5     1        1         1       1        2        921  569 27    9      78.897186 !
```

`left/top/width/height` is exactly the `[x, y, width, height]` ADR-5 fixes — no quad conversion, no
lost rotation. `conf` is 0–100 per word.

**One gap:** `osd.traineddata` is not in the image, so `--psm 0`, `1` and `12` (the orientation-aware
modes) fail with `Error opening data file /usr/share/tessdata/osd.traineddata`. It would have to be
mounted too.

---

## The result, and the reason

Every page-segmentation mode and both engine modes were swept before scoring, so the number below is
Tesseract's best showing, not its first:

| Configuration | Dates parsed |
| --- | --- |
| `bul` (full tessdata), psm 6, dpi 300 | **1 / 10** |
| `bulfast`, psm 6, dpi 300 | 2 / 10 — **but one is a fabricated date**, see below |
| `bul`, psm 11 (sparse text) | 1 / 10 |
| psm 3 / 4 (the defaults) | 0 / 10 — returns an empty string |
| psm 1 / 12 | unusable, `osd.traineddata` missing |
| **RapidOCR PP-OCRv4 mobile, for reference** | **7 / 10** |

The `bulfast` extra is worse than a miss. On the dm oat-drink carton, whose date line reads
`Mindestens haltbar bis: 04-2503`, it produced `3.003`, which the parser dutifully turned into
**2027-03-03** with `sole-candidate` and no ambiguity flag. A benchmark that silently invents a
plausible date is more damaging than one that returns nothing, and `expiryStatus` would have called it
`valid`.

### It is not the recogniser. It is the localisation.

This is the finding worth keeping. Handed the **cropped date line** that RapidOCR's detector found —
greyscaled, normalised, upscaled 3×, `--psm 7` — Tesseract reads it correctly:

```
crop of "Годен до: 07/2027", 452×80 px from the original

bulfast  →  "Соден до: 07/2027"      # only the leading Г misread
bul      →  ";;%о: 6515027"
eng      →  ";‘io: 6?/5027"
RapidOCR →  "ToneH AO:" + "07/2027"  (score 0.98)
```

`tessdata_fast` — the smallest of the three files — gets the digits, the separator and the year
exactly right. So the Bulgarian recogniser is not the problem. Whole-image preprocessing does not
rescue it either: greyscale + normalise + sharpen + upscale to 2400 px still yields `Ходен до: 0/`.

The structural difference is that **PP-OCR detects text regions first** (DBNet), then recognises
cropped, deskewed, size-normalised line images. Tesseract binarises and runs page-layout analysis over
the whole photograph — a scanned-document assumption that a photograph of a curved, glossy, unevenly
lit box violates. Everything downstream of that is fine.

### So: detector from one, recogniser from the other?

Tested, since all the pieces existed. RapidOCR's 110 detected regions across the ten images were cut
out with `sharp` and each fed to Tesseract `bulfast --psm 7`:

```
94530004  2027-07-31  month  sole-candidate     07/2027      blocks=4
bef20fea  2027-07-31  month  anchor-proximity   07/2027      blocks=7
efd3f1ff  2026-12-16  day    sole-candidate     16.12.2026   blocks=13
3/10 parsed to a date
```

**3 / 10 — better than Tesseract alone, well short of RapidOCR alone, at roughly twice the latency**
(1.85 s of RapidOCR plus 110 crops in 16.5 s, i.e. ~0.15 s each, ~1.6 s per image). Two things kill it:

- **RapidOCR cannot be asked for boxes only.** `use_rec=false` returns HTTP 500 — the handler
  dereferences `ocr_res.txts` unconditionally. The hybrid pays for a recognition pass it discards.
- Many crops recognise nothing, so the block count collapses from 6–15 to 1–13.

One consolation prize: `bef20fea` is the **only time `anchor-proximity` has fired in either spike**,
because Tesseract read «Годен до» as its own block next to the date. It confirms ADR-4's rule is
reachable in principle — and, at 3/10, that reaching it is not what limits this path.

---

## Latency and footprint, measured the same way as the first spike

25 sequential requests, warm, production running, `--cpus=1.5`:

| Configuration | median | IQR / median | peak RSS | peak CPU |
| --- | --- | --- | --- | --- |
| `bul` (full tessdata), psm 6 | 2.226 s | 6.6 % | 85.6 MiB | 151 % |
| **`bulfast`, psm 6** | **1.348 s** | 7.8 % | as above | as above |
| Cropped date line only, psm 7 | 0.272 s | 7.3 % | — | — |
| *RapidOCR, same protocol (case B1)* | *1.854 s* | *12.0 %* | *644 MiB* | *153 %* |

Two notes for anyone reusing these numbers:

- **There is no cold start to warm away.** First request 2.271 s against a 2.226 s median. Tesseract
  loads a small model per process; there is no ONNX session to build. Phase 07 item 16's warm-up would
  be unnecessary on this engine.
- **The worker pool is keyed by the argument string** (`/status` shows
  `pools: [{args: "-l bul+eng --psm 3", … max: 2}]`). Each distinct option combination gets its own
  pool of up to 2. A server that varied `psm` per request would quietly multiply the process count.

---

## Conclusion

**Keep RapidOCR as `onnx-paddleocr`.** Nothing here changes the stage B recommendation in the first
spike. 7/10 against 1/10 is not a margin that a seventh of the memory or a quarter of the startup can
buy back, and the benchmark exists to measure date extraction.

Three things worth carrying forward regardless:

1. **The failure is localisation, not language.** If the self-hosted path is ever revisited, the lever
   is a better *detector* or a better-framed input, not a better recogniser or a different dictionary.
   That also retires the intuition — mine included — that Cyrillic support was the gap.

   Since this was written, the three images both engines fail on were examined pixel by pixel and turn
   out to share one property: **the date is dot-matrix inkjet**, and the ones both engines read are
   continuous-glyph prints. Tesseract's 1/10 and RapidOCR's 7/10 are the same finding seen from two
   distances — RapidOCR's detector rescues the easy cases, and neither engine touches the hard ones.
   Four engines have now read 0 of 3 dot-matrix dates; see "Why the three failures are one failure" and "Would more hardware change any of this?" in
   [07-ocr-sidecar.md](07-ocr-sidecar.md).
2. **`tessdata_fast` is genuinely fast and genuinely accurate on located lines**: 0.272 s per crop and
   a clean `07/2027`. If a future phase ever crops to a region of interest — a user-drawn box, a
   detector, a second pass over an anchor's neighbourhood — Tesseract at 85 MiB is a strong candidate
   for that shape of work.
3. **Do not add this as a fifth engine.** It would cost an entry in `methodSchema`, one in the price
   table, a button, and a README row — and it would contribute a column of mostly empty cells plus at
   least one fabricated date. If it is ever added, the fabricated-date case is the reason
   `parse.candidates` and `confidence.signals` are recorded, and the README must say that a
   `sole-candidate` result from a weak engine is not the same claim as one from a strong one.

**State of the box:** the spike container and the pulled image were removed; the eight production
containers are healthy and `emerald`, `garden` and `scanner` all answer 200. `~/spike-07/` keeps the
harness, the raw timings, the crops and the three `bul.traineddata` variants. The image digest is
recorded above, so re-pulling is one command.
