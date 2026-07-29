import { apiErrorSchema } from '@scanner-demo/shared';
import type { ZodType } from 'zod';
import { config } from '../config';

/**
 * The one door out of the app.
 *
 * Every request goes through here so that authentication and response validation are not
 * per-screen concerns that one screen can forget. The response is parsed with the same zod schemas
 * the server validated it against - they come from `@scanner-demo/shared` and exist exactly once -
 * so a shape mismatch surfaces here, as an error naming the field, rather than as `undefined` two
 * screens later.
 */

/** Requests that outlive this are a failure, not a slow success. Overridable per call. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface RequestOptions {
  timeoutMs?: number;
  /** Caller-owned cancellation - a screen unmounting, a poll being superseded. */
  signal?: AbortSignal;
}

export type ApiFailureKind =
  /** The request never produced a response: no network, DNS failure, TLS failure, timeout. */
  | 'network'
  /** The server answered, with a non-2xx status. */
  | 'http'
  /** The server answered 2xx with a body that is not what the schema says it is. */
  | 'schema';

export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  readonly status: number | null;
  /** The server's `error` code when it sent one - the shape is `apiErrorSchema`. */
  readonly code: string | null;

  constructor(
    message: string,
    options: {
      kind: ApiFailureKind;
      status?: number | null;
      code?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

function url(path: string): string {
  return `${config.serverUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Combines the caller's signal with a timeout.
 *
 * `AbortSignal.any` is not available in Hermes, so the two are wired together by hand. The returned
 * `dispose` must run on every path, or a pending timer keeps the timeout alive after the request
 * has already settled.
 */
function abortSignalFor(options: RequestOptions): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs} ms`));
  }, timeoutMs);

  const onCallerAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onCallerAbort);

  if (options.signal?.aborted === true) {
    onCallerAbort();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** Reads the server's error envelope, falling back to the status line when the body is not one. */
async function httpError(response: Response): Promise<ApiError> {
  const fallback = `HTTP ${response.status} ${response.statusText}`.trim();

  try {
    const parsed = apiErrorSchema.safeParse(await response.json());

    if (parsed.success) {
      return new ApiError(parsed.data.message, {
        kind: 'http',
        status: response.status,
        code: parsed.data.error,
      });
    }
  } catch {
    // A non-JSON error body - nginx's own 413 or 502 page, most likely. The status still says
    // everything the caller can act on.
  }

  return new ApiError(fallback, { kind: 'http', status: response.status });
}

/**
 * Headers are narrowed to a plain object rather than `HeadersInit`.
 *
 * The request builder merges them with the spread below, and spreading a `Headers` instance or an
 * array of pairs yields an object with none of the entries in it - the auth header would survive and
 * the caller's would vanish, silently. Narrowing the type makes that unrepresentable.
 */
type JsonRequestInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function request<T>(
  path: string,
  schema: ZodType<T>,
  init: JsonRequestInit,
  options: RequestOptions,
): Promise<T> {
  const { signal, dispose } = abortSignalFor(options);

  let response: Response;
  try {
    response = await fetch(url(path), {
      ...init,
      signal,
      headers: {
        // Sent on /health too, which does not require it. One code path is worth more than the
        // handful of bytes saved by special-casing the only unauthenticated route.
        Authorization: `Bearer ${config.apiToken}`,
        Accept: 'application/json',
        ...init.headers,
      },
    });
  } catch (error: unknown) {
    throw new ApiError(error instanceof Error ? error.message : 'Network request failed', {
      kind: 'network',
      cause: error,
    });
  } finally {
    dispose();
  }

  if (!response.ok) {
    throw await httpError(response);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw new ApiError('Response body is not valid JSON', { kind: 'schema', cause: error });
  }

  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(`Unexpected response from ${path} - ${issues}`, {
      kind: 'schema',
      status: response.status,
      cause: parsed.error,
    });
  }

  return parsed.data;
}

export function apiGet<T>(
  path: string,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return request(path, schema, { method: 'GET' }, options);
}

export function apiPost<T>(
  path: string,
  body: unknown,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return request(
    path,
    schema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options,
  );
}

/**
 * Multipart upload.
 *
 * `Content-Type` is deliberately absent: React Native's fetch sets it, together with the multipart
 * boundary it generated. Setting it here would send a header whose boundary matches nothing.
 *
 * Uploads are whole photographs over a phone's uplink, so the default timeout is much longer than
 * for a JSON call. It still exists - a stalled upload must fail rather than hang a screen.
 */
export function apiUpload<T>(
  path: string,
  form: FormData,
  schema: ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  return request(path, schema, { method: 'POST', body: form }, { timeoutMs: 60_000, ...options });
}
