import { z } from 'zod';

/**
 * Everything the app reads from the environment, in one place and validated once at startup.
 *
 * The two reads below are written out literally. Expo's Babel transform substitutes the text
 * `process.env.EXPO_PUBLIC_NAME` at build time; there is no `process.env` object to index into at
 * runtime, so a computed or destructured access compiles to `undefined` and only fails on a real
 * device.
 *
 * Both values ship inside the APK - that is what EXPO_PUBLIC_ means. The bearer token is the app's
 * only credential and is deliberately not treated as a secret; every provider key lives on the
 * server - spec, § Hard constraint: no secrets in the app.
 */

const configSchema = z.object({
  /** No trailing slash, so path joining stays a plain concatenation everywhere else. */
  serverUrl: z
    .string()
    .min(1, 'EXPO_PUBLIC_SERVER_URL is required')
    .transform((value) => value.replace(/\/+$/, ''))
    .pipe(z.url({ message: 'EXPO_PUBLIC_SERVER_URL must be an absolute http(s) URL' })),
  apiToken: z.string().min(1, 'EXPO_PUBLIC_API_TOKEN is required'),
});

export type AppConfig = z.infer<typeof configSchema>;

function loadConfig(): AppConfig {
  const parsed = configSchema.safeParse({
    serverUrl: process.env.EXPO_PUBLIC_SERVER_URL,
    apiToken: process.env.EXPO_PUBLIC_API_TOKEN,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Failing at startup beats a Home screen that renders "undefined" and a health check that can
    // never go green. Copy app/.env.example to app/.env and rebuild.
    throw new Error(`Invalid app environment:\n${issues}`);
  }

  return parsed.data;
}

export const config = loadConfig();
