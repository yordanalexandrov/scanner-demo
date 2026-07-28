import { z } from 'zod';

/** `upload` is the downscaled variant sent from the phone; `original` is what the camera produced. */
export const imageVariantSchema = z.enum(['upload', 'original']);

export type ImageVariant = z.infer<typeof imageVariantSchema>;

/**
 * How the image entered the system. Gallery imports have no controlled capture conditions, so their
 * results are valid for comparing OCR accuracy and meaningless for comparing capture latency. Every
 * screen that averages latency has to be able to filter on this.
 */
export const imageSourceSchema = z.enum(['camera', 'gallery']);

export type ImageSource = z.infer<typeof imageSourceSchema>;

/** Where `capturedAt` came from, since an import can only ever be as good as its EXIF - ADR-6. */
export const capturedAtSourceSchema = z.enum(['camera', 'exif', 'import']);

export type CapturedAtSource = z.infer<typeof capturedAtSourceSchema>;

export const imageRecordSchema = z.object({
  id: z.string(),
  /** Groups the variants of one capture, so `upload` and `original` stay related. */
  captureGroupId: z.string(),
  variant: imageVariantSchema,
  source: imageSourceSchema,
  width: z.number().int(),
  height: z.number().int(),
  bytes: z.number().int(),
  mimeType: z.string(),
  /** `null` for gallery imports - no capture conditions were under our control. */
  torch: z.boolean().nullable(),
  captureWidth: z.number().int().nullable(),
  captureHeight: z.number().int().nullable(),
  downscaled: z.boolean(),
  /** Unix ms. Doubles as the parser's default `referenceDate` - ADR-6. */
  capturedAt: z.number().int(),
  capturedAtSource: capturedAtSourceSchema,
  createdAt: z.number().int(),
});

export type ImageRecord = z.infer<typeof imageRecordSchema>;
