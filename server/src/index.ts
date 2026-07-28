import { buildServer } from './app.js';
import { openDatabase } from './db/client.js';
import { loadEnv } from './env.js';
import { SERVER_VERSION } from './version.js';

/**
 * Process bootstrap.
 *
 * Graceful shutdown matters more here than it looks: the container is stopped and restarted for
 * every deploy, and SQLite in WAL mode wants its connection closed rather than killed. An
 * ungraceful exit mid-upload would also leave a temporary file behind.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const { db, close: closeDatabase } = openDatabase(env.databasePath);
  const fastify = await buildServer({ env, db });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    fastify.log.info({ signal }, 'shutting down');
    try {
      await fastify.close();
      closeDatabase();
      process.exit(0);
    } catch (error) {
      fastify.log.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await fastify.listen({ host: env.HOST, port: env.PORT });

  fastify.log.info(
    { version: SERVER_VERSION, imageDir: env.imageDir, databasePath: env.databasePath },
    'scanner-demo server ready',
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
