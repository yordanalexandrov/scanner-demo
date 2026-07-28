import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { CapturedAtSource, ImageSource, ImageVariant } from '@scanner-demo/shared';

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
  ],
);

export type ImageRow = typeof images.$inferSelect;
export type NewImageRow = typeof images.$inferInsert;
