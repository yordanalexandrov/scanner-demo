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

  // The service-account key file for Google Cloud Vision - phase 08. The engine reads it from here
  // and passes it to the SDK explicitly rather than letting the SDK search: a credential the SDK
  // cannot find leaves a floating rejection that would take the process down, so the check happens
  // where it can be answered - see server/src/engines/gcv.ts.
  //
  // **Optional on purpose, and it must stay optional.** A missing key is a recorded attempt with
  // `error` set, not a server that refuses to start: every other route, and the two other engines,
  // work perfectly well without Google - phase 08 criterion 6.
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),

  // Explicit limit on the Vision call. gax makes it the total deadline across the transient retries
  // it performs, so the endpoint cannot outlive it.
  //
  // Keep it BELOW the app's own 45 s round-trip timeout, for the reason OCR_SIDECAR_TIMEOUT_MS is:
  // the server timing out first is what makes a slow engine arrive on the phone as a measurement
  // rather than as noise.
  GCV_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),

  // Which VlmProvider implementation serves /api/v1/ocr/vlm - phase 09.
  //
  // **A plain string rather than an enum, deliberately.** The interface exists so that benchmarking
  // a second provider is one new file plus one line in server/src/vlm/index.ts; an enum here would
  // make this file a third one to edit, and criterion 4 checks that it is not. An unregistered name
  // is caught by the registry and answered as a 502 naming the known providers, so the typo is
  // still loud - it just does not take the other three methods down with it.
  VLM_PROVIDER: z.string().min(1).default('openai'),

  // The concrete model, and half of the engine string `vlm:<provider>/<model>`, which is also the
  // price-table key - ADR-11. Changing it produces attempts under a new key and leaves the earlier
  // rows saying which model produced them - criterion 9.
  //
  // Unlike GCV's pin this one IS an environment variable, because comparing two models is a thing
  // this benchmark is for. The safety net is the price table rather than the type: a model with no
  // entry yields `costEstimateUsd: null`, which is an honest "not priced" rather than a number
  // borrowed from a different model.
  VLM_MODEL: z.string().min(1).default('gpt-5.4-mini'),

  // Explicit limit on the whole VLM call. Keep it BELOW the app's own 45 s round-trip timeout
  // (app/src/api/ocr.ts), for the reason the other two engines' limits are: the server timing out
  // first is what makes a slow model arrive on the phone as a measurement rather than as noise.
  VLM_TIMEOUT_MS: z.coerce.number().int().min(1).default(40_000),
});

export type Env = z.infer<typeof envSchema> & {
  /** Absolute, so no filesystem call ever depends on the process's working directory. */
  imageDir: string;
  thumbDir: string;
  databasePath: string;
  /**
   * The source this was validated from, carried along for the VLM providers - phase 09.
   *
   * A provider reads its own credential variable out of this rather than having it declared above,
   * so adding a second provider stays a one-file change - see `vlm/types.ts`, `VlmProviderConfig`.
   * It is passed through rather than reached for as `process.env`, so a test configures a provider
   * by building an `Env` like every other test does instead of mutating the process.
   */
  raw: Readonly<Partial<Record<string, string>>>;
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
    raw: source,
    imageDir: path.resolve(parsed.data.IMAGE_DIR),
    thumbDir: path.resolve(parsed.data.THUMB_DIR),
    databasePath: path.resolve(parsed.data.DATABASE_PATH),
  };
}
