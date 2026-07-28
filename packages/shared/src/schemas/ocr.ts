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
