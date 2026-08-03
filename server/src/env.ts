import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * The environment, validated once at startup.
 *
 * A missing `API_BEARER_TOKEN` must stop the process rather than quietly start a server that
 * accepts every request. Everything else has a development default; nothing here has a default
 * that would be wrong in production without being obviously wrong.
 */

loadDotenv({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Loopback by default: on the deployment box nginx terminates TLS and proxies here, and the
  // container must not be reachable from outside - ADR-17.
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),

  API_BEARER_TOKEN: z.string().min(1, 'API_BEARER_TOKEN is required'),

  IMAGE_DIR: z.string().min(1).default('./data/images'),
  THUMB_DIR: z.string().min(1).default('./data/thumbs'),
  DATABASE_PATH: z.string().min(1).default('./data/scanner.sqlite'),

  // 32 MB. A full-resolution photo from a modern phone exceeds the 8 MB the box's other vhosts
  // allow, so the nginx vhost raises its own limit to match this one - see deploy/README.md.
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(32 * 1024 * 1024),

  // The OCR sidecar, on the internal Docker network. It publishes no ports, so this hostname
  // resolves nowhere else - phase 07.
  OCR_SIDECAR_URL: z.string().min(1).default('http://ocr:9005'),

  // Generous against a measured warm median of 1.85 s and a cold 3.9 s, because the box is shared
  // with production and a 0.5-CPU moment costs 6.4 s - ADR-18. It is a limit on hanging, not a
  // latency budget: a request that outlives it is a failure, and the endpoint says so rather than
  // holding the phone open.
  OCR_SIDECAR_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),

  // One dummy inference at startup, so the first real request is not a model load. Off in tests,
  // which have no sidecar to call and should not spend five retries discovering that.
  OCR_WARMUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type Env = z.infer<typeof envSchema> & {
  /** Absolute, so no filesystem call ever depends on the process's working directory. */
  imageDir: string;
  thumbDir: string;
  databasePath: string;
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }

  return {
    ...parsed.data,
    imageDir: path.resolve(parsed.data.IMAGE_DIR),
    thumbDir: path.resolve(parsed.data.THUMB_DIR),
    databasePath: path.resolve(parsed.data.DATABASE_PATH),
  };
}
