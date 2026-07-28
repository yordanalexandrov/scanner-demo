import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  close: () => void;
}

/**
 * Migrations are committed and applied at startup rather than by a separate deploy step. There is
 * one writer and one deployment; a container that boots is a container whose schema is current.
 *
 * The path holds for both `src/db/` and the mirrored `dist/db/` layout.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openDatabase(databasePath: string): DbHandle {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);

  // WAL lets a read run while a write is in flight, which matters here because serving an image
  // and recording an upload happen concurrently on a two-core box.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}
