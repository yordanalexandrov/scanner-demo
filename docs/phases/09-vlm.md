# Phase 09 — VLM engine

**Status:** implemented, awaiting review · **Depends on:** 06, 07 · **Source:** spec milestone 9

## Goal

The fourth method: a vision-language model reading the packaging, behind an interface swappable enough
that benchmarking a different provider later means adding one file and changing one environment variable.

This is also the one path that separates **reading** from **interpretation**, which is the comparison the
whole harness exists to make possible.

## Scope

1. `VlmProvider` interface with a single method, and `OpenAiProvider` as the only implementation for now.
   The provider is selected by an environment variable. — *spec § Stack — Server*
2. `POST /api/v1/ocr/vlm` — `{ imageId }` → `OcrResponse` **plus** `parsedDate`, `modelReasoning` and
   `promptVersion`. The third was not in the original sketch and has to be there: the prompt lives on
   the server and the app is the sole author of attempt rows, so item 10 below is unsatisfiable
   without it — *spec § Server API*, [ADR-24](../decisions.md#adr-24--the-vlm-response-carries-its-prompt-version-and-the-endpoint-declares-its-own-schema)
3. The model is prompted to return **both** its own structured answer **and** the raw text it read.
   Both are recorded. — *spec § Date parsing*
4. The shared parser is additionally run over the VLM's raw text, on the phone like every other method.
   The attempt therefore carries three things: the model's own answer, the raw text, and the shared
   parser's reading of that raw text. That difference is what tells me how much of the VLM's advantage is
   better reading versus better interpretation.
   — *spec § Date parsing*, [ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows)
5. `engine` records **provider and model name**: `vlm:openai/<model>`. Model versions change and old
   benchmark records must stay interpretable. — *spec § Server API*
6. Structured output enforced by a zod schema on the server; a response that does not conform is a
   recorded failure, not a best-effort parse of prose.
7. `blocks` is populated where possible; where the model gives no positional data, `bbox` is `null` and
   the parser falls through to `latest-of-pair` or `sole-candidate`, recording which rule decided.
   — [ADR-4](../decisions.md#adr-4--bbox-is-nullable-and-the-parser-records-which-rule-decided)
8. `engineMsScope: "inference+network"`.
9. `costEstimateUsd` computed from actual token usage returned by the API against the shared price table.
   The token counts are **persisted** in `OcrResponse.usage`, so a cost figure in the export can be
   re-derived and audited rather than merely believed.
   — [ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table)
10. `promptVersion` is recorded on every attempt. It is a first-class schema field from phase 01, not an
    implementation detail — a prompt change alters results exactly as a model change does.
11. API key from the server's environment only. — *spec § Hard constraint: no secrets in the app*
12. Explicit timeout; failures recorded as attempts with `error` set.

## Out of scope

- A second provider implementation. The interface exists so one can be added later; adding one now would
  be building for a benchmark that has not been run.
- Fine-tuning, few-shot galleries or per-image prompt tweaking. Every image gets the same prompt, or the
  comparison is not a comparison.
- Any client-side model call.

## Deliverables

```
server/src/vlm/
├── types.ts                          # VlmProvider interface + VlmResult
├── openai.ts                         # OpenAiProvider — the only implementation
├── prompt.ts                         # one prompt, versioned
└── index.ts                          # provider selection from env
server/src/engines/vlm.ts             # adapts VlmProvider to OcrEngine
server/src/routes/ocr.ts              # + POST /api/v1/ocr/vlm
server/.env.example                   # + VLM_PROVIDER, VLM_MODEL, VLM_TIMEOUT_MS, OPENAI_API_KEY
packages/shared/src/schemas/ocr.ts    # + vlmOcrResponseSchema — ADR-24
packages/shared/src/pricing.ts        # + real OpenAI prices, source URL, retrieval date
app/src/components/MethodButtons.tsx  # VLM button enabled
app/src/screens/ResultScreen.tsx      # model answer beside parser answer
```

The `.env.example` written in an earlier phase reserved `OPENAI_MODEL`. It is `VLM_MODEL`, as this
document's deliverables and criterion 9 say: a provider-specific model variable would make adding a
provider a change to `server/src/env.ts` as well, and criterion 4 requires that it is not.

## Key decisions

[ADR-4](../decisions.md#adr-4--bbox-is-nullable-and-the-parser-records-which-rule-decided) ·
[ADR-10](../decisions.md#adr-10--latency-segments-clocks-and-what-may-be-subtracted) ·
[ADR-11](../decisions.md#adr-11--cost-estimates-come-from-a-versioned-price-table) ·
[ADR-15](../decisions.md#adr-15--the-app-is-the-sole-author-of-attempt-rows) ·
[ADR-24](../decisions.md#adr-24--the-vlm-response-carries-its-prompt-version-and-the-endpoint-declares-its-own-schema)

## Interfaces

```ts
// server/src/vlm/types.ts — the swap point
export interface VlmProvider {
  readonly id: string;                       // e.g. "openai"
  readonly model: string;                    // recorded in engine as vlm:<id>/<model>
  extract(image: Buffer): Promise<VlmResult>;
}

export type VlmResult = {
  rawText: string;                           // what the model says it read
  parsedDate: string | null;                 // the model's own structured answer, ISO
  modelReasoning: string;
  blocks: Block[];                           // usually bbox: null — ADR-4
  usage: { inputTokens: number; outputTokens: number };
};
```

```
POST /api/v1/ocr/vlm   { imageId } → OcrResponse & { parsedDate, modelReasoning, promptVersion }
```

The prompt is versioned alongside the model, because a prompt change alters results exactly as a model
change does. `promptVersion` is its own column on the attempt (defined in phase 01), not a suffix on the
engine string — the engine string is the price-table key, and overloading it would break the cost lookup.

## Acceptance criteria

1. `POST /api/v1/ocr/vlm` returns a response validating against the schema, with `rawText`, `parsedDate`
   and `modelReasoning` all populated on a legible image.
2. `engine` is `vlm:openai/<model>` with the concrete model name — never bare `vlm`.
3. The attempt row carries the model's own `parsedDate` **and** the shared parser's result over the same
   `rawText`, and the result view shows both side by side, labelled distinctly.
4. **The swap is genuinely one file and one variable.** Verify by adding a stub provider that echoes fixed
   text, selecting it via `VLM_PROVIDER`, and confirming the app, the routes, the schemas and every other
   engine are untouched — `git diff --name-only` for that change lists exactly the new provider file, the
   provider index registration and `server/.env.example`.
5. `costEstimateUsd` is derived from the API's reported token usage, not from a flat per-image guess;
   `usage.inputTokens`/`usage.outputTokens` and `pricingVersion` are stored on the attempt, and
   recomputing the cost from them reproduces the stored figure.
6. Running the same image five times produces five attempt rows, and the Library's grouped view shows the
   spread — the non-determinism the additive rule exists to expose.
7. A malformed model response is recorded as a failure with the raw response retained for inspection, not
   silently coerced.
8. No OpenAI credential or SDK exists in the app: `grep -rnE 'sk-[A-Za-z0-9]{16,}|OPENAI_API_KEY' app/src app/app.json`
   finds nothing, and `openai` is absent from `app/package.json`. (The literal string `openai` appears
   legitimately inside displayed engine names, so the check targets key and SDK shapes.)
9. Old records stay interpretable: changing `VLM_MODEL` produces new attempts with a different `engine`
   string, and the earlier rows are unchanged and still labelled with the model that produced them.
10. Changing the prompt bumps `promptVersion`, and attempts recorded before and after are distinguishable
    in the export without consulting the git history.

## Measured

[09-vlm-models.md](../spikes/09-vlm-models.md) — three models and three prompt versions against 15
distinct products with operator-supplied ground truth. It settles the `VLM_MODEL` default on
`gpt-5.4-mini`, and records two findings the phase document only anticipated: the sidecar reads a
rotated dot-matrix stamp that two of the three VLMs cannot, and the VLM is the only method that picks
the expiry date correctly when a production date is printed beside it.

## Risks / unknowns

- The model may return a confident date it did not actually read. Recording both its answer and the raw
  text is exactly what makes this detectable — expect to find cases and treat them as findings.
- Token-based cost varies with image resolution, so the `upload` and `original` variants cost differently.
  This is a real and interesting result; record it rather than normalising it away.
- Rate limits will make five-in-a-row runs fail intermittently. Recorded failures are data; do not add a
  silent retry that hides latency variance.

## Review checkpoint

Show: the VLM run on several Library images; the model's answer and the shared parser's answer displayed
side by side on the same raw text; five runs on one image showing the spread; cost derived from real token
usage; and the stub-provider swap demonstrated as a one-file change.
