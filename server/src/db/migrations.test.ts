import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_PARSER_VERSION, LEGACY_TIMING_VERSION } from '@scanner-demo/shared';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));
const LEGACY_MIGRATION_TAGS = [
  '0000_cloudy_smasher',
  '0001_groovy_toxin',
  '0002_awesome_johnny_storm',
  '0003_chunky_piledriver',
] as const;

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Drizzle records applied migrations by the journal timestamps, so this folder uses the real
 * pre-06b files and their real journal entries rather than approximating the legacy schema by hand.
 */
function legacyMigrations(root: string): string {
  const target = path.join(root, 'legacy-migrations');
  const meta = path.join(target, 'meta');
  fs.mkdirSync(meta, { recursive: true });

  for (const tag of LEGACY_MIGRATION_TAGS) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), path.join(target, `${tag}.sql`));
  }

  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number } & Record<string, unknown>>;
  };

  fs.writeFileSync(
    path.join(meta, '_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 3) }),
  );

  return target;
}

describe('database migrations', () => {
  it('backfills semantic versions without changing a legacy attempt payload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-demo-migration-'));
    temporaryRoots.push(root);

    const sqlite = new Database(path.join(root, 'scanner.sqlite'));
    const db = drizzle(sqlite);

    try {
      migrate(db, { migrationsFolder: legacyMigrations(root) });
      sqlite.pragma('foreign_keys = ON');

      sqlite
        .prepare(
          `insert into images (
            id, captureGroupId, variant, source, width, height, bytes, mimeType, torch,
            captureWidth, captureHeight, downscaled, capturedAt, capturedAtSource, createdAt
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'image-legacy',
          'group-legacy',
          'upload',
          'camera',
          1600,
          1200,
          12345,
          'image/jpeg',
          1,
          4032,
          3024,
          1,
          1_785_000_000_000,
          'camera',
          1_785_000_000_100,
        );

      // Deliberately non-canonical spacing proves the migration did not parse and re-serialise JSON.
      const ocrJson = '{ "rawText" : "EXP 12.03.2027", "blocks" : [] }';
      const parseJson = '{ "expiry" : { "date" : "2027-03-12" }, "candidates" : [] }';
      const timingJson = '{ "totalMs" : 70186.04111900926, "captureMs" : 1125.4851559996605 }';

      sqlite
        .prepare(
          `insert into attempts (
            id, imageId, captureGroupId, method, inputVariant, engine, device, expiryDate,
            expiryStatus, expiryPrecision, parseRule, totalMs, engineMs, costEstimateUsd,
            referenceDate, pricingVersion, promptVersion, error, ocrJson, parseJson, vlmJson,
            timingJson, createdAt
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'attempt-legacy',
          'image-legacy',
          'group-legacy',
          'mlkit',
          'upload',
          'mlkit',
          'SM-S928B (Android 16)',
          null,
          null,
          null,
          'none',
          70_186.04111900926,
          92.68500000238419,
          0,
          '2026-07-30',
          'unset',
          null,
          null,
          ocrJson,
          parseJson,
          null,
          timingJson,
          1_785_000_000_200,
        );

      const before = sqlite
        .prepare(
          'select id, imageId, ocrJson, parseJson, vlmJson, timingJson from attempts order by id',
        )
        .all();

      migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      const after = sqlite
        .prepare(
          `select id, imageId, ocrJson, parseJson, vlmJson, timingJson,
            parserVersion, timingVersion
          from attempts order by id`,
        )
        .all() as Array<Record<string, unknown>>;

      expect(after).toHaveLength(1);
      expect(
        after.map(
          ({ parserVersion: _parserVersion, timingVersion: _timingVersion, ...row }) => row,
        ),
      ).toEqual(before);
      expect(after[0]?.parserVersion).toBe(LEGACY_PARSER_VERSION);
      expect(after[0]?.timingVersion).toBe(LEGACY_TIMING_VERSION);

      const versionColumns = (
        sqlite.pragma('table_info(attempts)') as Array<{
          name: string;
          notnull: number;
        }>
      ).filter(({ name }) => name === 'parserVersion' || name === 'timingVersion');

      expect(versionColumns).toEqual([
        expect.objectContaining({ name: 'parserVersion', notnull: 1 }),
        expect.objectContaining({ name: 'timingVersion', notnull: 1 }),
      ]);
    } finally {
      sqlite.close();
    }
  });
});
