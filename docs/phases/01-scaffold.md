# Phase 01 — Scaffold and shared contracts

**Status:** complete · **Depends on:** — · **Source:** spec milestone 1

## Goal

A pnpm workspace in which the benchmark's data contracts exist exactly once, compile under strict
TypeScript, and are enforced by CI — so every later phase has one place to put a schema and one gate that
catches drift between app and server.

## Scope

1. pnpm workspace: `app/`, `server/`, `packages/shared/`. Node 22 LTS and the pnpm version pinned
   (`engines`, `packageManager`, `.nvmrc`). — *spec § Repository layout*
2. `packages/shared`: zod schemas for every record the harness stores, with TS types inferred from them
   (never hand-written alongside). — *spec § Server API*
3. Reference data used by the parser, as data tables only: anchor phrases and month names.
   — *spec § Date parsing*, [ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy)
4. Price table with `PRICING_VERSION`. It ships with `PRICING_VERSION = "unset"` and `null` prices; the
   phase that fills a provider's price in also bumps the version to that retrieval date, so a version
   always identifies one price set.
   — [ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table)
5. Monotonic timing helpers in `packages/shared/src/timing.ts`, so both sides measure durations the same
   way and neither reaches for `Date.now()`. — *spec § Gotchas*,
   [ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted)
6. `tsup` build producing ESM + CJS + `.d.ts`.
   — [ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication)
7. TypeScript strict mode in all three packages; a single base `tsconfig` they extend.
8. ESLint + Prettier, one config at the root.
9. Vitest wired up in `packages/shared` with one smoke test (the parser's tests arrive in phase 05).
10. GitHub Actions: install → build shared → lint → typecheck → test → secret scan.
11. Secret scanning: `gitleaks` in CI **and** a `husky` pre-commit hook, so a key is caught before it
    reaches a public remote rather than after. Confirm the current staged-scan subcommand against the
    installed gitleaks version — `protect --staged` is the older form and `git --staged` the newer one;
    pin whichever the installed release documents rather than the one written here.
    — *spec § Hard constraint: no secrets in the app*
12. `app/.env.example` and `server/.env.example` listing every variable with a comment, no real values.
13. `README.md`, `LICENSE` (MIT), `.gitignore` including `.idea/`.
    — [ADR-13](../decisions.md#adr-13--idea-is-gitignored)

## Out of scope

- Any runtime code — no Fastify server, no Expo app, no parser implementation. Phases 02, 03, 05.
- Metro monorepo configuration: it needs an app to configure. Phase 03.
- The Drizzle schema and migrations. Phase 02 — the zod schemas here are the source of truth for shape;
  the Drizzle tables mirror them.
- Filling in real prices in the price table. Phases 08 and 09, from the providers' pricing pages.

## Deliverables

```
package.json                       # workspace root, scripts, packageManager
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.js
.prettierrc
.nvmrc
.husky/pre-commit                  # gitleaks protect --staged
.gitleaks.toml
.github/workflows/ci.yml
app/.env.example
server/.env.example
packages/shared/
├── package.json
├── tsup.config.ts
├── vitest.config.ts
└── src/
    ├── index.ts
    ├── schemas/
    │   ├── ocr.ts                 # Block, OcrResponse
    │   ├── image.ts               # ImageRecord
    │   ├── attempt.ts             # Attempt, Timing
    │   ├── barcode.ts             # BarcodeScan
    │   └── parse.ts               # ParseResult
    ├── data/
    │   ├── anchors.ts
    │   └── months.ts
    ├── timing.ts                   # monotonic now()/elapsed(), used by app and server alike
    └── pricing.ts
```

## Key decisions

[ADR-5](../decisions.md#adr-5--bbox-format-and-confidence-nullability) ·
[ADR-9](../decisions.md#adr-9--month-name-locales-for-dd-mmm-yyyy) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) ·
[ADR-13](../decisions.md#adr-13--idea-is-gitignored) ·
[ADR-14](../decisions.md#adr-14--shared-package-build-and-thumbnail-authentication)

## Interfaces

The contracts introduced here. Every later phase adds implementations behind them, not variants of them.

```ts
// schemas/ocr.ts — identical in shape across all four engines; this is what makes the comparison valid
export const blockSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(), // [x, y, w, h] px, top-left
  confidence: z.number().min(0).max(1).nullable(),
});

export const ocrResponseSchema = z.object({
  engine: z.string(),            // "mlkit" | "onnx-paddleocr" | "gcv:builtin/stable" | "vlm:openai/<model>"
                                 // doubles as the price-table key — ADR-11
  rawText: z.string(),
  blocks: z.array(blockSchema),
  engineMs: z.number(),
  engineMsScope: z.enum(["inference", "inference+network"]),
  serverTotalMs: z.number().nullable(),   // null on the on-device path
  imageWidth: z.number().int(),           // of the image the engine actually processed
  imageHeight: z.number().int(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).nullable(),
  costEstimateUsd: z.number().nullable(),  // null while the price table entry is unfilled — never 0
  pricingVersion: z.string(),
});

// schemas/image.ts
export const imageRecordSchema = z.object({
  id: z.string(),
  captureGroupId: z.string(),
  variant: z.enum(["upload", "original"]),
  source: z.enum(["camera", "gallery"]),
  width: z.number().int(), height: z.number().int(),
  bytes: z.number().int(), mimeType: z.string(),
  torch: z.boolean().nullable(),                       // null for gallery imports
  captureWidth: z.number().int().nullable(),
  captureHeight: z.number().int().nullable(),
  downscaled: z.boolean(),
  capturedAt: z.number().int(),                        // unix ms — the referenceDate of ADR-6
  capturedAtSource: z.enum(["camera", "exif", "import"]),  // where capturedAt came from — ADR-6
  createdAt: z.number().int(),
});

// schemas/attempt.ts
export const timingSchema = z.object({
  captureMs: z.number().nullable(),      // null for gallery imports and re-runs
  downscaleMs: z.number().nullable(),
  uploadMs: z.number().nullable(),       // null for re-runs
  downloadMs: z.number().nullable(),     // re-runs only: fetching the stored variant back
  requestMs: z.number().nullable(),      // client-measured round trip of the OCR call; null on-device
  engineMs: z.number().nullable(),       // server-reported
  serverTotalMs: z.number().nullable(),  // server-reported
  parseMs: z.number(),
  totalMs: z.number(),                   // measured entirely on the phone
});

export const attemptSchema = z.object({
  id: z.string(),
  imageId: z.string(),
  captureGroupId: z.string(),
  method: z.enum(["mlkit", "onnx-paddleocr", "onnx-paddleocr-cyrillic", "gcv", "vlm"]),
  inputVariant: z.enum(["upload", "original"]),
  device: z.string(),                    // handset model + Android version — on-device latency depends on it
  ocr: ocrResponseSchema.nullable(),     // null when the run failed
  parse: parseResultSchema.nullable(),
  vlm: z.object({ parsedDate: z.string().nullable(), modelReasoning: z.string() }).nullable(),
  timing: timingSchema,
  referenceDate: z.string(),             // ISO; stored so re-runs stay reproducible
  pricingVersion: z.string(),
  promptVersion: z.string().nullable(),  // VLM only; a prompt change alters results as a model change does
  error: z.string().nullable(),
  createdAt: z.number().int(),
});

// schemas/parse.ts
export const parseSignalSchema = z.enum([
  "anchor-matched", "ambiguous-numeric", "month-precision-only",
  "no-bbox", "engine-confidence-missing", "multiple-candidates",
]);

export const parseResultSchema = z.object({
  expiry: z.object({
    date: z.string(),                              // ISO yyyy-mm-dd
    precision: z.enum(["day", "month"]),
    status: z.enum(["valid", "expired"]),          // ADR-7: expired is a successful extraction
    raw: z.string(),
  }).nullable(),
  productionDate: z.object({ date: z.string(), raw: z.string() }).nullable(),
  rule: z.enum(["anchor-proximity", "latest-of-pair", "sole-candidate", "none"]),
  ambiguous: z.boolean(),
  confidence: z.object({ score: z.number().min(0).max(1), signals: z.array(parseSignalSchema) }),
  candidates: z.array(z.object({ raw: z.string(), date: z.string(), rejectedFor: z.string().nullable() })),
  referenceDate: z.string(),
});

// schemas/barcode.ts — ADR-1
export const barcodeScanSchema = z.object({
  id: z.string(), value: z.string().length(13),
  decodeMs: z.number(), device: z.string(), scannedAt: z.number().int(),
});
```

## Acceptance criteria

1. `pnpm install` completes from a clean checkout with no lockfile changes.
2. `pnpm -r build` produces `packages/shared/dist/{index.js,index.cjs,index.d.ts}`.
3. `pnpm -r typecheck` passes, and no package weakens the base config: `tsconfig.base.json` sets
   `"strict": true`, and `grep -rn '"strict"' app/tsconfig.json server/tsconfig.json packages/*/tsconfig.json`
   returns nothing — no package overrides it.
4. `pnpm -r lint` and `pnpm -r test` pass.
5. Importing `@scanner-demo/shared` from a scratch `.ts` file in both `server/` and a plain Node script
   resolves types — no `any`.
6. Staging a file containing a plausible API key is rejected by the pre-commit hook. Verify by attempting
   a commit with a dummy `sk-` string and confirming a non-zero exit.
7. The CI workflow passes on a pushed branch.
8. `git ls-files | grep '^\.idea'` returns nothing.
9. The price table ships honest placeholders: `PRICING_VERSION === "unset"` and every provider price is
   `null`, so a cost of `0.00` can never be mistaken for a real figure before phases 08 and 09 fill them
   in.
10. `packages/shared/src/timing.ts` exports the monotonic helpers, and
    `grep -rn 'Date.now()' packages/shared/src` finds nothing.

## Risks / unknowns

- pnpm's symlinked `node_modules` is the usual source of monorepo pain with Metro; it does not bite until
  phase 03, but the shared package's dual-output build exists specifically to keep that fix small.
- `gitleaks` may need a small allowlist for `.env.example` placeholder values. If it does, the allowlist
  goes in `.gitleaks.toml` with a comment, never by disabling the check.

## Review checkpoint

Show: the workspace installing and building clean, the schema files as the single definition of every
record, CI green on a branch, and the pre-commit hook rejecting a fake key. The point of review here is
the **schemas** — every later phase is expensive to change if a field is missing from these.
