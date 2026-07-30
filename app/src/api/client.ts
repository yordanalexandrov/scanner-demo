import { File, UploadType } from 'expo-file-system';
import type { UploadResult } from 'expo-file-system';
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

/**
 * The absolute URL of an API path.
 *
 * Exported because two things need a URL rather than a parsed response: an `<Image>` source and a
 * file download. Both still go through {@link authHeaders}, so there is one place a request can
 * acquire the token.
 */
export function apiUrl(path: string): string {
  return `${config.serverUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The bearer token, as a header.
 *
 * Image and thumbnail requests authenticate this way rather than through signed URLs: the entire
 * threat model here is "the repository is public", and a token-minting endpoint with an expiry
 * policy would be machinery in service of nothing - ADR-14.
 */
export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${config.apiToken}` };
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
    response = await fetch(apiUrl(path), {
      ...init,
      signal,
      headers: {
        // Sent on /health too, which does not require it. One code path is worth more than the
        // handful of bytes saved by special-casing the only unauthenticated route.
        ...authHeaders(),
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
 * Multipart upload of a file already on disk.
 *
 * **This does not go through `fetch`, and that is not an oversight.** Expo installs a
 * WinterCG-compliant `fetch` as the global one, and its `FormData` conversion rejects React
 * Native's `{ uri, name, type }` file part outright - `expo/src/winter/fetch/convertFormData.ts`
 * says so in as many words and throws `Unsupported FormDataPart implementation`. The alternative
 * that does work through `fetch` is to read the file into memory as a `Blob`; for a
 * full-resolution photograph that is a multi-megabyte allocation, copied again while the body is
 * assembled, on the archive path of every capture.
 *
 * `expo-file-system`'s upload streams the file natively instead. Everything the shared client
 * exists for is preserved by hand below: the bearer token goes on the request, the status is
 * checked, and the body is parsed with the same zod schema the server validated it against.
 *
 * Uploads are whole photographs over a phone's uplink, so the timeout is much longer than for a
 * JSON call. It still exists - a stalled upload must fail rather than hang a screen.
 */
export async function apiUploadFile<T>(
  path: string,
  file: File,
  schema: ZodType<T>,
  parts: Record<string, string>,
  options: { mimeType?: string } = {},
): Promise<T> {
  let result: UploadResult;

  try {
    result = await file.upload(apiUrl(path), {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      // The server expects exactly these two parts and rejects any other field name.
      fieldName: 'file',
      mimeType: options.mimeType ?? 'image/jpeg',
      parameters: parts,
      headers: { ...authHeaders(), Accept: 'application/json' },
    });
  } catch (error: unknown) {
    throw new ApiError(error instanceof Error ? error.message : 'The upload failed', {
      kind: 'network',
      cause: error,
    });
  }

  if (result.status < 200 || result.status >= 300) {
    const parsedError = safeJson(result.body);
    const envelope = apiErrorSchema.safeParse(parsedError);

    throw envelope.success
      ? new ApiError(envelope.data.message, {
          kind: 'http',
          status: result.status,
          code: envelope.data.error,
        })
      : new ApiError(`HTTP ${result.status}`, { kind: 'http', status: result.status });
  }

  const parsed = schema.safeParse(safeJson(result.body));

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ApiError(`Unexpected response from ${path} - ${issues}`, {
      kind: 'schema',
      status: result.status,
      cause: parsed.error,
    });
  }

  return parsed.data;
}

/**
 * Streams a stored file onto the phone. The other direction of {@link apiUploadFile}.
 *
 * It exists because a Library re-run has to read the very bytes the server holds - anything else
 * would benchmark a different image from the one the row names. The download is a measured segment
 * of its own, `timing.downloadMs`, and is never folded into `uploadMs`: one is the phone sending a
 * capture and the other is the phone fetching an archive, and adding them together would describe a
 * round trip that never happened - ADR-10.
 *
 * A non-2xx status arrives as a rejection whose message carries the code, so a 401 on the image
 * route surfaces as a failed re-run rather than as a zero-byte file that ML Kit then reads as
 * "no text found".
 */
export async function apiDownloadFile(path: string, destination: File): Promise<File> {
  try {
    return await File.downloadFileAsync(apiUrl(path), destination, {
      headers: authHeaders(),
      // The destination is named after the image ID, so the same variant downloaded twice is the
      // same file. Overwriting is the intended behaviour; failing on the second run is not.
      idempotent: true,
    });
  } catch (error: unknown) {
    throw new ApiError(error instanceof Error ? error.message : 'The download failed', {
      // The native module reports the HTTP status inside the message rather than as a field, so
      // this stays 'network' rather than claiming a status it would have to guess at.
      kind: 'network',
      cause: error,
    });
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
