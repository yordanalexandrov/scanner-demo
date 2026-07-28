import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // better-sqlite3 and sharp are native modules with process-wide state; a single fork keeps the
    // temporary directories each test creates from colliding on a two-core box.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
