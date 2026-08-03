import { buildServer } from './app.js';
import { openDatabase } from './db/client.js';
import { createLocalOcrEngine } from './engines/localOcr.js';
import { loadEnv } from './env.js';
import { warmUpEngine } from './lib/warmup.js';
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

  const localOcrEngine = createLocalOcrEngine({
    baseUrl: env.OCR_SIDECAR_URL,
    timeoutMs: env.OCR_SIDECAR_TIMEOUT_MS,
  });

  const fastify = await buildServer({ env, db, localOcrEngine });

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

  if (env.OCR_WARMUP) {
    // Deliberately not awaited. The server is already listening and every route except the OCR one
    // works without the sidecar; blocking the boot on a container that takes five seconds to load
    // its models would make a deploy look hung. The cold figure is logged because it is the one the
    // README reports separately - phase 07 item 16.
    void warmUpEngine({ engine: localOcrEngine })
      .then((result) => {
        if (result.ok) {
          fastify.log.info(
            { coldStartMs: result.ms, attempts: result.attempts },
            'OCR sidecar warm',
          );
        } else {
          fastify.log.warn(
            { attempts: result.attempts, reason: result.error },
            'the OCR sidecar did not warm up; the first request will pay the model load',
          );
        }
      })
      // `warmUpEngine` is written not to reject, so this is the belt to that braces: an unhandled
      // rejection here would take down a server that is already listening and serving every other
      // route, turning an optional optimisation into a restart loop.
      .catch((error: unknown) => {
        fastify.log.error({ err: error }, 'the warm-up itself failed unexpectedly');
      });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
