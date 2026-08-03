import { z } from 'zod';

/**
 * One recognised region of text. Identical in shape across all four engines - this is what makes
 * comparing them valid.
 *
 * `bbox` is `[x, y, width, height]` in pixels of the image the engine actually processed, origin
 * top-left. It is nullable because not every engine reports geometry; `confidence` is nullable for
 * the same reason and a missing value is never substituted with `1.0` - ADR-4, ADR-5.
 */
export const blockSchema = z.object({
  text: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});

export type Block = z.infer<typeof blockSchema>;

/**
 * What `engineMs` actually covers. The sidecar and ML Kit can isolate inference; the cloud SDKs
 * cannot separate it from the round trip. Any chart comparing `engineMs` across engines has to
 * show this or it is comparing different things - ADR-10.
 */
export const engineMsScopeSchema = z.enum(['inference', 'inference+network']);

export type EngineMsScope = z.infer<typeof engineMsScopeSchema>;

export const usageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
});

export type Usage = z.infer<typeof usageSchema>;

/**
 * The response every OCR path returns, on-device or server-side.
 *
 * `engine` doubles as the price-table key, so it carries the provider and model where those affect
 * the result: `"mlkit"`, `"onnx-paddleocr"`, `"gcv:builtin/stable"`, `"vlm:openai/<model>"` - ADR-11.
 */
export const ocrResponseSchema = z.object({
  engine: z.string(),
  rawText: z.string(),
  blocks: z.array(blockSchema),
  /** Time inside the recognition engine itself. Read together with `engineMsScope`. */
  engineMs: z.number(),
  engineMsScope: engineMsScopeSchema,
  /** Wall time inside the Fastify handler. `null` on the on-device path, which has no server. */
  serverTotalMs: z.number().nullable(),
  /** Dimensions of the image the engine processed, so bboxes can be normalised after the fact. */
  imageWidth: z.number().int(),
  imageHeight: z.number().int(),
  usage: usageSchema.nullable(),
  /** `null` while the price-table entry is unfilled. Never `0` - an unknown cost is not a free one. */
  costEstimateUsd: z.number().nullable(),
  pricingVersion: z.string(),
});

export type OcrResponse = z.infer<typeof ocrResponseSchema>;

/**
 * The VLM's own structured answer, kept beside the parser's answer rather than instead of it.
 *
 * **This is the one comparison the whole harness exists to make possible.** Every other engine
 * reads; this one reads *and* interprets. Recording only its answer would hide which half of any
 * advantage is which, and recording only the shared parser's reading of its raw text would throw
 * away the interpretation entirely. Both are stored, on one attempt row - phase 09 item 4, ADR-15.
 *
 * It lives here rather than in `attempt.ts` because it is a property of the response first: the VLM
 * endpoint returns these fields, and the attempt merely carries them. One definition, so the field
 * the server sends cannot drift from the field the app stores.
 */
export const vlmAnswerSchema = z.object({
  /** ISO `yyyy-mm-dd`, or `null` when the model found no date. Never a guess - phase 09 item 6. */
  parsedDate: z.string().nullable(),
  modelReasoning: z.string(),
});

export type VlmAnswer = z.infer<typeof vlmAnswerSchema>;

/**
 * What `POST /api/v1/ocr/vlm` returns: an `OcrResponse` plus the model's own reading of it.
 *
 * **`promptVersion` travels on the response, which the phase document's sketch does not show.** It
 * has to: the app is the sole author of attempt rows - ADR-15 - and the prompt lives on the server,
 * so the phone cannot record which prompt produced a result unless it is told. Without it, phase 09
 * criterion 10 - attempts before and after a prompt change are distinguishable in the export - is
 * unsatisfiable by construction. It is a sibling field rather than part of `engine` because the
 * engine string is the price-table key and overloading it would break the cost lookup - ADR-24.
 *
 * A separate schema rather than optional fields on `ocrResponseSchema`: the serialiser validates
 * every response against the schema its route declares, and optional fields there would let any
 * engine quietly ship a `parsedDate` that nothing checks.
 */
export const vlmOcrResponseSchema = ocrResponseSchema.extend({
  ...vlmAnswerSchema.shape,
  promptVersion: z.string(),
});

export type VlmOcrResponse = z.infer<typeof vlmOcrResponseSchema>;
