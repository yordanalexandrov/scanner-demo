# scanner-demo

A **benchmark harness**, not a product.

`scanner-demo` exists to answer two questions about real supermarket packaging, with numbers rather than
impressions:

1. How fast is on-device EAN-13 barcode scanning?
2. How do four different expiry-date extraction methods compare in **accuracy, latency and cost**?

| Method | Where it runs |
|---|---|
| On-device | ML Kit Text Recognition v2, on the phone |
| Self-hosted | RapidOCR (PaddleOCR ONNX models) in a sidecar container |
| Google Vision | Cloud Vision `DOCUMENT_TEXT_DETECTION` |
| VLM | OpenAI, behind a swappable provider interface |

Every design decision serves *measurement and fair comparison*. Where polish and comparability conflict,
comparability wins.

## Status

**Phases 01 and 02 of 10 are complete; phase 03 is in review.** Every record the harness stores is
defined once in `packages/shared`. The server is deployed at `scanner.yo-po.eu` and stores, serves and
thumbnails images. The Android app now builds as an Expo development build, navigates its five screens
and reports whether the server is reachable. There is no camera code and no OCR yet — those start at
phase 04. See [`docs/phases/README.md`](docs/phases/README.md) for the build order and where the work
stands.

## Layout

```
scanner-demo/
├── app/                 # React Native (Expo dev build, Android only)
├── server/              # Fastify + TypeScript: image store, OCR engines, benchmark records
├── packages/
│   └── shared/          # Types, zod schemas, and the date parser — used by BOTH app and server
├── docs/
├── docker-compose.yml
└── README.md
```

`packages/shared` is load-bearing, not decorative. The `OcrResponse` shape, the zod validation schemas and
the date parser exist **once** and are imported by both sides, so on-device and server results are parsed
by literally the same code. Any accuracy difference between methods is therefore attributable to the OCR,
not to parsing.

## Development

Node 22 (see [`.nvmrc`](.nvmrc)) and pnpm, pinned by `packageManager` in the root `package.json`.

```bash
pnpm install
pnpm -r build       # packages/shared → ESM + CJS + .d.ts
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

`pnpm -r build` runs before typechecking `app/` or `server/`: both resolve the shared package through its
`dist` output, so it has to exist first. CI orders the steps the same way.

Copy `app/.env.example` → `app/.env` and `server/.env.example` → `server/.env` and fill them in. Both
`.env` files are gitignored.

The pre-commit hook scans staged changes with [gitleaks](https://github.com/gitleaks/gitleaks) and
**fails if gitleaks is not installed**, rather than passing quietly — a scanner that silently does nothing
is worse than no scanner. Version 8.19 or newer is required; it introduced `gitleaks git`, which replaced
`gitleaks protect`:

```bash
curl -sL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
  | tar -xz -C /tmp gitleaks && install -m 0755 /tmp/gitleaks ~/.local/bin/gitleaks
```

Coding agents: start with [`AGENTS.md`](AGENTS.md).

## Documentation

| Document | What it is |
|---|---|
| [`docs/scanner-demo-claude-code-prompt.md`](docs/scanner-demo-claude-code-prompt.md) | The original specification. Source of truth. |
| [`docs/phases/README.md`](docs/phases/README.md) | Phase index, dependency graph, requirement coverage matrix. |
| [`docs/phases/NN-*.md`](docs/phases/) | One document per phase: scope, deliverables, acceptance criteria. |
| [`docs/decisions.md`](docs/decisions.md) | Architecture decision records — every judgement call the spec left open. |
| [`docs/deployment-target.md`](docs/deployment-target.md) | The server this runs on, and what its constraints mean for the numbers. |
| [`AGENTS.md`](AGENTS.md) | Working instructions for coding agents. `CLAUDE.md` is a symlink to it. |

## Known limitations

These are properties of the methods being measured, not bugs. They are recorded here because they affect
how the benchmark numbers should be read.

- **ML Kit Text Recognition v2 does not support Cyrillic.** It handles Latin, Chinese, Devanagari,
  Japanese and Korean. The digits of a date read fine, but Bulgarian anchor words
  (`Годен до`, `Срок на годност`) will never be recognised on the on-device path. The server-side
  engines all handle Cyrillic.
- **The self-hosted engine's default models are Chinese + English.** Cyrillic recognition requires
  selecting a different recognition model explicitly; see [ADR-12](docs/decisions.md) and
  [phase 07](docs/phases/07-ocr-sidecar.md).
- **Gallery imports have no controlled capture conditions.** Their results are valid for comparing OCR
  accuracy and meaningless for comparing capture latency. The History and Library screens filter on
  this so the two never land in the same average silently.
- **The server runs on two cores shared with a live application.** Absolute latencies are therefore not
  portable to other hardware. What stays valid is the comparison between the four methods, since all four
  are measured under the same conditions — and local contention slightly flatters the cloud engines
  against the self-hosted one. See [`docs/deployment-target.md`](docs/deployment-target.md).

## Security

The repository is public and API keys compiled into an APK are extractable with `strings`. Therefore the
app holds **zero** provider credentials: Google Cloud Vision and the VLM are called only from the server,
which reads keys from environment variables. The app authenticates to the server with a single shared
bearer token from `app/.env` (gitignored; see `.env.example`). A pre-commit hook and a CI job fail if
anything resembling a key is staged.

The bearer token is itself extractable from the APK, for exactly the reason above — it is bundled at build
time. It is deliberately not treated as a secret: it is a coarse gate on a personal benchmark server, it
is rotatable, and it is used nowhere else. The point of the design is that losing it exposes a box of
photographs of yoghurt lids, not a billable API account.

## License

MIT — see [LICENSE](LICENSE).
