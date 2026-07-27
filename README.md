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

**Nothing is implemented yet.** This repository currently contains the specification and the phase plan.
See [`docs/phases/README.md`](docs/phases/README.md) for the build order and where the work stands.

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

## Documentation

| Document | What it is |
|---|---|
| [`docs/scanner-demo-claude-code-prompt.md`](docs/scanner-demo-claude-code-prompt.md) | The original specification. Source of truth. |
| [`docs/phases/README.md`](docs/phases/README.md) | Phase index, dependency graph, requirement coverage matrix. |
| [`docs/phases/NN-*.md`](docs/phases/) | One document per phase: scope, deliverables, acceptance criteria. |
| [`docs/decisions.md`](docs/decisions.md) | Architecture decision records — every judgement call the spec left open. |

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
