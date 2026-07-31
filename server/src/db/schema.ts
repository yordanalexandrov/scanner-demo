import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  CapturedAtSource,
  DatePrecision,
  ExpiryStatus,
  ImageSource,
  ImageVariant,
  Method,
  ParserVersion,
  ParseRule,
  TimingVersion,
} from '@scanner-demo/shared';

/**
 * The `images` table, mirroring `imageRecordSchema` in `packages/shared` field for field.
 *
 * Column names match the schema's property names rather than being translated to snake_case,
 * exactly as ADR-3 writes them. The mirror is the point: a row and an `ImageRecord` differ only in
 * that SQLite has no booleans, and a reader comparing the two files should not have to translate.
 *
 * `$type` pins the enum columns to the shared union types. SQLite would happily store any string;
 * this makes the compiler refuse one.
 */
export const images = sqliteTable(
  'images',
  {
    id: text('id').primaryKey(),

    /** Shared by the variants of one physical capture, so they stay related - ADR-3. */
    captureGroupId: text('captureGroupId').notNull(),

    variant: text('variant').notNull().$type<ImageVariant>(),
    source: text('source').notNull().$type<ImageSource>(),

    // Derived server-side from the uploaded bytes with sharp, never accepted from the client -
    // ADR-3. Client-supplied dimensions would make the recorded metadata unverifiable.
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    mimeType: text('mimeType').notNull(),

    /** `null` for gallery imports: no capture condition was under our control - ADR-3. */
    torch: integer('torch', { mode: 'boolean' }),
    captureWidth: integer('captureWidth'),
    captureHeight: integer('captureHeight'),
    downscaled: integer('downscaled', { mode: 'boolean' }).notNull(),

    /** Unix ms. Doubles as the parser's default `referenceDate` - ADR-6. */
    capturedAt: integer('capturedAt').notNull(),
    capturedAtSource: text('capturedAtSource').notNull().$type<CapturedAtSource>(),

    /** Unix ms, server-assigned. The only field a stable pagination cursor can be built on. */
    createdAt: integer('createdAt').notNull(),
  },
  (table) => [
    // The listing's sort order. Keyset pagination reads this index directly instead of sorting.
    index('images_createdAt_id_idx').on(table.createdAt, table.id),
    index('images_captureGroupId_idx').on(table.captureGroupId),
    index('images_capturedAt_idx').on(table.capturedAt),

    // The Library's two equality filters, each carrying the listing's sort columns behind it so a
    // filtered page is one range scan and not a scan plus a sort - phase 06 criterion 10. The
    // trailing `id` matters: it is the cursor's tie-breaker, and without it SQLite would have to
    // sort the rows that share a millisecond.
    index('images_source_createdAt_id_idx').on(table.source, table.createdAt, table.id),
    index('images_variant_createdAt_id_idx').on(table.variant, table.createdAt, table.id),
  ],
);

export type ImageRow = typeof images.$inferSelect;
export type NewImageRow = typeof images.$inferInsert;

/**
 * The `barcode_scans` table, mirroring `barcodeScanSchema` in `packages/shared` field for field.
 *
 * Its own table rather than a row type inside `attempts` - ADR-1. A barcode scan has no image, no
 * engine, no raw text, no parsed date and no cost, so folding it in would make most of the attempts
 * columns nullable across the whole benchmark dataset to accommodate a row that shares none of
 * their semantics.
 */
export const barcodeScans = sqliteTable(
  'barcode_scans',
  {
    id: text('id').primaryKey(),

    /** The decoded EAN-13, exactly as the scanner reported it. */
    value: text('value').notNull(),

    /**
     * Scanner-ready to callback, in milliseconds, measured entirely on the phone's monotonic clock.
     * Stored as a real: this is the measurement the phase exists to produce, and rounding it to an
     * integer at rest would throw away precision the phone actually had - ADR-10.
     */
    decodeMs: real('decodeMs').notNull(),

    /** Handset model plus Android version. Decode latency depends on both, so runs stay comparable. */
    device: text('device').notNull(),

    /** Unix ms, server-assigned. Ordered and paginated on, never subtracted - ADR-10. */
    scannedAt: integer('scannedAt').notNull(),
  },
  (table) => [
    // The listing's sort order. Keyset pagination reads this index directly instead of sorting.
    index('barcode_scans_scannedAt_id_idx').on(table.scannedAt, table.id),
  ],
);

export type BarcodeScanRow = typeof barcodeScans.$inferSelect;
export type NewBarcodeScanRow = typeof barcodeScans.$inferInsert;

/**
 * The `attempts` table - one run of one method against one image.
 *
 * Hybrid on purpose. `attemptSchema` is nested several levels deep and phase 06 has to filter and
 * aggregate on fields buried inside it, so the columns that get filtered, sorted or grouped are
 * flattened and indexed while the full payloads stay as JSON. **The JSON is the record and the
 * columns are its index**: every flattened column is derived from the JSON on write and none is
 * ever edited on its own, or the two would disagree and only one of them would be right.
 *
 * Two columns are nullable where the phase document writes them `not null`. `engine` is read from
 * `ocr.engine` and `parseRule` from `parse.rule`, and both of those objects are null on a failed
 * run - which acceptance criterion 13 requires to be recorded rather than dropped. A failure is
 * data; making these columns `not null` would make it unstorable.
 */
export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),

    imageId: text('imageId')
      .notNull()
      .references(() => images.id),
    /** Denormalised from the image so that the two variants of one capture group together - ADR-3. */
    captureGroupId: text('captureGroupId').notNull(),

    method: text('method').notNull().$type<Method>(),
    /**
     * `(method, inputVariant)` is the grouping key, never `method` alone: the on-device path runs
     * against both variants and averaging the two together would make both numbers wrong - ADR-2.
     */
    inputVariant: text('inputVariant').notNull().$type<ImageVariant>(),

    /** The full engine string including the model, which is also the price-table key - ADR-11. */
    engine: text('engine'),
    device: text('device').notNull(),

    /** Derived from `parse`. `null` when nothing parsed, which the hasDate filter reads directly. */
    expiryDate: text('expiryDate'),
    expiryStatus: text('expiryStatus').$type<ExpiryStatus>(),
    expiryPrecision: text('expiryPrecision').$type<DatePrecision>(),
    parseRule: text('parseRule').$type<ParseRule>(),

    /** Measured entirely on the phone, one clock - ADR-10. Indexed for the median queries. */
    totalMs: real('totalMs').notNull(),
    engineMs: real('engineMs'),
    /** `null` while the price is unfilled. Never `0` - an unknown cost is not a free one - ADR-11. */
    costEstimateUsd: real('costEstimateUsd'),

    /** ISO. Stored so a re-run a year later reaches the same verdict - ADR-6. */
    referenceDate: text('referenceDate').notNull(),
    /** Parser and timing semantics are independent versioned dimensions - ADR-21, ADR-22. */
    parserVersion: text('parserVersion').notNull().$type<ParserVersion>(),
    timingVersion: text('timingVersion').notNull().$type<TimingVersion>(),
    pricingVersion: text('pricingVersion').notNull(),
    /** VLM only. A prompt change alters results the way a model change does. */
    promptVersion: text('promptVersion'),
    error: text('error'),

    // The record itself. Serialised `OcrResponse`, `ParseResult`, `VlmAnswer` and `Timing`.
    ocrJson: text('ocrJson'),
    parseJson: text('parseJson'),
    vlmJson: text('vlmJson'),
    timingJson: text('timingJson').notNull(),

    /** Unix ms, server-assigned. Ordered, never subtracted - ADR-10. */
    createdAt: integer('createdAt').notNull(),
  },
  (table) => [
    index('attempts_imageId_createdAt_idx').on(table.imageId, table.createdAt),
    // Both of the Library's "has this been run?" filters, which ask about a capture group rather
    // than a single row because attempts hang off the group's uploaded row whichever variant was
    // read - ADR-20. `expiryDate` trails `captureGroupId` so `hasDate` is answered out of the index
    // without touching the table. It replaces the plain `captureGroupId` index, whose every query
    // this one serves as a prefix - a second index on the same leading column would only add write
    // cost.
    index('attempts_captureGroupId_expiryDate_idx').on(table.captureGroupId, table.expiryDate),
    // The grouping key of every comparison the harness exists to make.
    index('attempts_method_inputVariant_idx').on(table.method, table.inputVariant),
    // Phase 06's "has a date" filter and phase 10's median-latency queries.
    index('attempts_expiryDate_idx').on(table.expiryDate),
    index('attempts_totalMs_idx').on(table.totalMs),
  ],
);

export type AttemptRow = typeof attempts.$inferSelect;
export type NewAttemptRow = typeof attempts.$inferInsert;
