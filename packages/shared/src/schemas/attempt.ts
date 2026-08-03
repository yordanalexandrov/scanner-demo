import { z } from 'zod';
import { ocrResponseSchema, vlmAnswerSchema } from './ocr.js';
import { parseResultSchema } from './parse.js';
import { imageVariantSchema } from './image.js';
import { parserVersionSchema } from '../parserVersion.js';
import { timingVersionSchema } from '../timingVersion.js';

/** The four methods being compared. The Cyrillic sidecar configuration is a fifth entry rather than
 * a replacement, so results gathered before it existed stay valid - ADR-12. */
export const methodSchema = z.enum([
  'mlkit',
  'onnx-paddleocr',
  'onnx-paddleocr-cyrillic',
  'gcv',
  'vlm',
]);

export type Method = z.infer<typeof methodSchema>;

/**
 * Every segment is `number | null`, where `null` means "not applicable on this path" and is never
 * rendered as `0` - a gallery import has no capture, a Library re-run has neither capture nor
 * upload. Every segment the phone can observe is stored. Capture-side segments sit outside
 * `totalMs`; the applicable method-side segments account for it - ADR-10, ADR-22.
 */
export const timingSchema = z.object({
  /** `null` for gallery imports and re-runs. */
  captureMs: z.number().nullable(),
  downscaleMs: z.number().nullable(),
  /** `null` for re-runs - the image is already on the server. */
  uploadMs: z.number().nullable(),
  /** Re-runs only: fetching the stored variant back. */
  downloadMs: z.number().nullable(),
  /** Client-measured round trip of the OCR call. `null` on the on-device path. */
  requestMs: z.number().nullable(),
  /** Server-reported, from the server's clock. Never subtracted from a phone-side figure. */
  engineMs: z.number().nullable(),
  serverTotalMs: z.number().nullable(),
  /**
   * `null` when the parser never ran, which is what a failed recognition means: there was no text to
   * parse. It was `z.number()` until a Library re-run made the case visible - a failed run recorded
   * `0`, and a zero-duration parse is a measurement, not the absence of one.
   */
  parseMs: z.number().nullable(),
  /** Measured entirely on the phone, from this method invocation to its parsed result - ADR-22. */
  totalMs: z.number(),
});

export type Timing = z.infer<typeof timingSchema>;

/**
 * One run of one method against one image. The app is the sole author of these rows - ADR-15.
 * Re-running a method appends an attempt; nothing is ever overwritten.
 */
export const attemptSchema = z.object({
  id: z.string(),
  imageId: z.string(),
  captureGroupId: z.string(),
  method: methodSchema,
  inputVariant: imageVariantSchema,
  /** Handset model plus Android version - on-device latency is meaningless without it. */
  device: z.string(),
  /** `null` when the run failed; `error` then says why. */
  ocr: ocrResponseSchema.nullable(),
  parse: parseResultSchema.nullable(),
  vlm: vlmAnswerSchema.nullable(),
  timing: timingSchema,
  /** ISO. Stored so re-runs stay reproducible - ADR-6. */
  referenceDate: z.string(),
  /** The exact shared-parser semantics that produced `parse` - ADR-21. */
  parserVersion: parserVersionSchema,
  /** The start-point semantics of `timing.totalMs` - ADR-22. */
  timingVersion: timingVersionSchema,
  pricingVersion: z.string(),
  /** VLM only. A prompt change alters results the way a model change does, so it is versioned. */
  promptVersion: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
});

export type Attempt = z.infer<typeof attemptSchema>;
