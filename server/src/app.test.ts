import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_PARSER_VERSION,
  LEGACY_TIMING_VERSION,
  PARSER_VERSION,
  PRICING_VERSION,
  TIMING_VERSION,
  attemptListQuerySchema,
  imageListQuerySchema,
  ocrResponseSchema,
  parseExpiryDate,
  startTimer,
  vlmOcrResponseSchema,
} from '@scanner-demo/shared';
import type {
  Attempt,
  AttemptCreate,
  BarcodeScan,
  BarcodeScanCreate,
  ImageUploadMeta,
  OcrResponse,
  VlmOcrResponse,
} from '@scanner-demo/shared';
import { buildServer } from './app.js';
import { openDatabase } from './db/client.js';
import type { DbHandle } from './db/client.js';
import { OcrEngineError } from './engines/types.js';
import type { OcrEngine } from './engines/types.js';
import { loadEnv } from './env.js';
import type { Env } from './env.js';
import type { ListCursor } from './lib/cursor.js';
import { attemptListQuery } from './lib/attemptQuery.js';
import { imageListQuery } from './lib/imageQuery.js';
import { THUMBNAIL_LONG_EDGE_PX } from './lib/thumbnails.js';

/**
 * These exercise the same instance the process runs, through `inject()`. They cover the acceptance
 * criteria that do not need a container: auth, byte-identical round trip, thumbnails and their
 * cache, path traversal, and the variant filter.
 */

const TOKEN = 'test-token-not-a-secret';

let root: string;
let env: Env;
let handle: DbHandle;
let app: FastifyInstance;

function testImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 60, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

function meta(overrides: Partial<ImageUploadMeta> = {}): ImageUploadMeta {
  return {
    captureGroupId: randomUUID(),
    variant: 'upload',
    source: 'camera',
    torch: false,
    captureWidth: 4032,
    captureHeight: 3024,
    downscaled: true,
    capturedAt: 1_770_000_000_000,
    capturedAtSource: 'camera',
    ...overrides,
  };
}

/** Builds a multipart body by hand, so the test does not depend on the client it is testing. */
function multipart(parts: {
  file?: { buffer: Buffer; filename: string; contentType: string };
  fields?: Record<string, string>;
  fileFieldName?: string;
}): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----scannerdemo${randomUUID()}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  if (parts.file) {
    const name = parts.fileFieldName ?? 'file';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${parts.file.filename}"\r\n` +
          `Content-Type: ${parts.file.contentType}\r\n\r\n`,
        'utf8',
      ),
      parts.file.buffer,
      Buffer.from('\r\n', 'utf8'),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(
  buffer: Buffer,
  overrides: Partial<ImageUploadMeta> = {},
): Promise<{ statusCode: number; imageId: string }> {
  const { body, headers } = multipart({
    file: { buffer, filename: 'capture.jpg', contentType: 'image/jpeg' },
    fields: { meta: JSON.stringify(meta(overrides)) },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/images',
    headers: { ...headers, authorization: `Bearer ${TOKEN}` },
    payload: body,
  });

  return {
    statusCode: response.statusCode,
    imageId: response.statusCode === 201 ? (response.json() as { imageId: string }).imageId : '',
  };
}

function scanBody(overrides: Partial<BarcodeScanCreate> = {}): BarcodeScanCreate {
  return {
    value: '4006381333931',
    decodeMs: 412.75,
    device: 'Pixel Test (Android 15)',
    ...overrides,
  };
}

async function postScan(
  overrides: Partial<BarcodeScanCreate> = {},
): Promise<{ statusCode: number; id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/barcode-scans',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: scanBody(overrides),
  });

  return {
    statusCode: response.statusCode,
    id: response.statusCode === 201 ? (response.json() as { id: string }).id : '',
  };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-demo-'));

  env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    API_BEARER_TOKEN: TOKEN,
    IMAGE_DIR: path.join(root, 'images'),
    THUMB_DIR: path.join(root, 'thumbs'),
    DATABASE_PATH: path.join(root, 'scanner.sqlite'),
  });

  handle = openDatabase(env.databasePath);
  app = await buildServer({ env, db: handle.db });
});

afterEach(async () => {
  await app.close();
  handle.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('authentication', () => {
  it('serves /health without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    expect((response.json() as { uptimeMs: number }).uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['/api/v1/images', 'GET'],
    ['/api/v1/images', 'POST'],
    ['/api/v1/barcode-scans', 'GET'],
    ['/api/v1/barcode-scans', 'POST'],
    ['/api/v1/attempts', 'POST'],
    ['/api/v1/attempts', 'GET'],
  ])('refuses %s %s without a token', async (url, method) => {
    const response = await app.inject({ method: method as 'GET' | 'POST', url });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('refuses a wrong token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/images',
      headers: { authorization: 'Bearer wrong' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('does not reveal whether an unauthenticated path exists', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nope' });

    expect(response.statusCode).toBe(401);
  });
});

describe('upload and retrieval', () => {
  it('stores the bytes and returns them unchanged', async () => {
    const original = await testImage(800, 600);
    const { statusCode, imageId } = await upload(original);

    expect(statusCode).toBe(201);

    const stored = fs.readFileSync(path.join(env.imageDir, `${imageId}.jpg`));
    expect(createHash('sha256').update(stored).digest('hex')).toBe(
      createHash('sha256').update(original).digest('hex'),
    );

    const served = await app.inject({
      method: 'GET',
      url: `/api/v1/images/${imageId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/jpeg');
    expect(createHash('sha256').update(served.rawPayload).digest('hex')).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
  });

  it('derives width, height, bytes and mimeType server-side', async () => {
    const original = await testImage(800, 600);
    const { imageId } = await upload(original);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/images',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const item = (listed.json() as { items: { id: string }[] }).items.find(
      (row) => row.id === imageId,
    );

    expect(item).toMatchObject({
      width: 800,
      height: 600,
      bytes: original.byteLength,
      mimeType: 'image/jpeg',
    });
  });

  it('refuses metadata the server is supposed to derive itself - ADR-3', async () => {
    const { body, headers } = multipart({
      file: { buffer: await testImage(64, 64), filename: 'a.jpg', contentType: 'image/jpeg' },
      fields: { meta: JSON.stringify({ ...meta(), width: 1, height: 1, mimeType: 'image/png' }) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/images',
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses metadata carrying a path, and writes nothing', async () => {
    const { body, headers } = multipart({
      file: { buffer: await testImage(64, 64), filename: 'a.jpg', contentType: 'image/jpeg' },
      fields: { meta: JSON.stringify({ ...meta(), path: '../../etc/passwd' }) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/images',
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(fs.readdirSync(env.imageDir)).toHaveLength(0);
  });

  it('ignores the client-supplied filename entirely', async () => {
    const { body, headers } = multipart({
      file: {
        buffer: await testImage(64, 64),
        filename: '../../../../tmp/escaped.jpg',
        contentType: 'image/jpeg',
      },
      fields: { meta: JSON.stringify(meta()) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/images',
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      payload: body,
    });

    expect(response.statusCode).toBe(201);

    const written = fs.readdirSync(env.imageDir);
    expect(written).toEqual([`${(response.json() as { imageId: string }).imageId}.jpg`]);
  });

  it('refuses bytes that are not an image', async () => {
    const { body, headers } = multipart({
      file: {
        buffer: Buffer.from('this is not a photograph', 'utf8'),
        filename: 'a.jpg',
        contentType: 'image/jpeg',
      },
      fields: { meta: JSON.stringify(meta()) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/images',
      headers: { ...headers, authorization: `Bearer ${TOKEN}` },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });

  it('404s for an ID that is well-formed but unknown', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/images/${randomUUID()}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('path traversal', () => {
  it.each([
    ['..%2F..%2Fetc%2Fpasswd', '/api/v1/images/..%2F..%2Fetc%2Fpasswd'],
    ['..%2F..%2Fetc%2Fpasswd/thumb', '/api/v1/images/..%2F..%2Fetc%2Fpasswd/thumb'],
    ['a plain relative name', '/api/v1/images/passwd'],
  ])('refuses %s with 400', async (_label, url) => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('self-hosted OCR', () => {
  /**
   * The sidecar is a container, so the route is exercised against a stub engine behind the same
   * interface phases 08 and 09 will implement. What is under test here is the route's contract -
   * the path never coming from the client, the failure mapping, the timing fields - and none of
   * that is a property of RapidOCR. The adapter itself is tested against real HTTP in
   * `engines/localOcr.test.ts`, and the container itself in the acceptance criteria.
   */
  function stubEngine(
    behaviour: (input: {
      imageId: string;
      path: string;
      signal?: AbortSignal;
    }) => Promise<OcrResponse>,
  ) {
    const calls: { imageId: string; path: string }[] = [];

    return {
      calls,
      engine: {
        name: 'onnx-paddleocr',
        recognise: (input: { imageId: string; path: string; signal?: AbortSignal }) => {
          calls.push(input);
          return behaviour(input);
        },
      },
    };
  }

  /**
   * A stub that honours cancellation the way the real adapter does.
   *
   * A stub that ignored `signal` would make any test of the route's cancellation guard pass
   * regardless of whether the guard is correct - which is exactly what happened once already.
   */
  function cancellableStub(delayMs: number) {
    return stubEngine(
      (input) =>
        new Promise<OcrResponse>((resolve, reject) => {
          const timer = setTimeout(() => resolve(ocrResponse()), delayMs);

          input.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(
              new OcrEngineError('The caller went away before the OCR sidecar answered', {
                cancelled: true,
              }),
            );
          });
        }),
    );
  }

  function ocrResponse(overrides: Partial<OcrResponse> = {}): OcrResponse {
    return {
      engine: 'onnx-paddleocr',
      rawText: 'roeH 0: 07/2027',
      blocks: [{ text: 'roeH 0: 07/2027', bbox: [57, 640, 926, 105], confidence: 0.85122 }],
      engineMs: 1854,
      engineMsScope: 'inference+network',
      serverTotalMs: null,
      imageWidth: 1200,
      imageHeight: 1600,
      usage: null,
      costEstimateUsd: 0,
      pricingVersion: PRICING_VERSION,
      ...overrides,
    };
  }

  /** A second instance over the same database, so uploads made through `app` are visible to it. */
  async function withEngine(
    engine: OcrEngine,
    gcvEngine?: OcrEngine,
    vlmEngine?: OcrEngine,
  ): Promise<FastifyInstance> {
    const instance = await buildServer({
      env,
      db: handle.db,
      localOcrEngine: engine,
      // Never the real ones: they would need credentials this repository does not hold, and would
      // bill a unit or a token if they had them.
      gcvEngine: gcvEngine ?? engine,
      vlmEngine: vlmEngine ?? engine,
    });
    ocrApps.push(instance);
    return instance;
  }

  function post(
    instance: FastifyInstance,
    body: object,
    token: string | null = TOKEN,
    url = '/api/v1/ocr/local',
  ): Promise<LightMyRequestResponse> {
    return instance.inject({
      method: 'POST',
      url,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      payload: body,
    });
  }

  let ocrApps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(ocrApps.map((instance) => instance.close()));
    ocrApps = [];
  });

  it('returns an OcrResponse that validates against the shared schema - criterion 8', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    const response = await post(instance, { imageId });

    expect(response.statusCode).toBe(200);
    expect(ocrResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('builds the path itself, from the stored row', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    await post(instance, { imageId });

    // Inside the image directory, named after the ID, with the extension the server derived from
    // the bytes - nothing here came from the request body.
    expect(stub.calls[0]?.path).toBe(path.join(env.imageDir, `${imageId}.jpg`));
  });

  it('refuses a path where an ID belongs and touches nothing - criterion 9', async () => {
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    const response = await post(instance, { imageId: '../../etc/passwd' });

    expect(response.statusCode).toBe(400);
    // The guard is not "it returned 400": it is that nothing downstream of the check ever ran.
    expect(stub.calls).toEqual([]);
  });

  it('refuses a body carrying a field it does not know', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    const response = await post(instance, { imageId, path: '/etc/passwd' });

    expect(response.statusCode).toBe(400);
    expect(stub.calls).toEqual([]);
  });

  it('404s for a well-formed ID that is not in the library', async () => {
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    const response = await post(instance, { imageId: randomUUID() });

    expect(response.statusCode).toBe(404);
    expect(stub.calls).toEqual([]);
  });

  it('requires the bearer token', async () => {
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    expect((await post(instance, { imageId: randomUUID() }, null)).statusCode).toBe(401);
    expect(stub.calls).toEqual([]);
  });

  it('answers 504 when the engine times out rather than hanging - criterion 10', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(() =>
      Promise.reject(
        new OcrEngineError('The OCR sidecar did not answer within 30000 ms', {
          timedOut: true,
        }),
      ),
    );
    const instance = await withEngine(stub.engine);

    const response = await post(instance, { imageId });

    // A timeout is its own answer, not a generic 502: "the engine was too slow" and "the engine was
    // wrong" are different results about the engine.
    expect(response.statusCode).toBe(504);
    expect((response.json() as { error: string }).error).toBe('engine_timeout');
  });

  it('answers 502 when the engine fails', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(() => Promise.reject(new OcrEngineError('answered HTTP 500')));
    const instance = await withEngine(stub.engine);

    const response = await post(instance, { imageId });

    expect(response.statusCode).toBe(502);
    expect((response.json() as { error: string }).error).toBe('engine_failed');
  });

  it('reports serverTotalMs as the handler, which is longer than the call - criterion 12', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(async () => {
      // **The engine reports what it measured, not the delay it asked for.** Returning the literal
      // `20` here made this test flaky at about 2 in 100: `setTimeout(20)` elapses in slightly under
      // 20 ms on the monotonic clock often enough to matter, and the assertion below then compared a
      // real measurement against a number nothing had measured. Timing the sleep the way a real
      // adapter times its call is what makes the containment property below true by construction.
      const stopEngineTimer = startTimer();
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ocrResponse({ engineMs: stopEngineTimer() });
    });
    const instance = await withEngine(stub.engine);

    const body = (await post(instance, { imageId })).json() as OcrResponse;

    expect(body.serverTotalMs).not.toBeNull();
    // The row read and the response are inside `serverTotalMs` and outside `engineMs`. Both come
    // from the same clock, so this subtraction is one ADR-10 permits - and what it measures is this
    // handler's own overhead, not the process boundary, because the boundary is inside `engineMs`.
    expect(body.serverTotalMs ?? 0).toBeGreaterThan(body.engineMs);
  });

  it('does not treat a consumed request body as a client hanging up - over real HTTP', async () => {
    // A regression test with a scar. The cancellation guard first listened on `request.raw`, whose
    // `close` fires as soon as the JSON body has been read - milliseconds in, client still there -
    // so every request was cancelled and the caller got nothing at all. `inject()` does not model
    // that, and passed; only a real socket shows it. Hence this one test listens for real.
    const { imageId } = await upload(await testImage(1200, 1600));
    // The stub honours `signal`, so a guard that fires too early ends this request with nothing
    // rather than with a response - which is precisely what the bug did.
    const stub = cancellableStub(50);
    const instance = await withEngine(stub.engine);

    await instance.listen({ host: '127.0.0.1', port: 0 });
    const address = instance.server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/ocr/local`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ imageId }),
    });

    expect(response.status).toBe(200);
    expect(ocrResponseSchema.safeParse(await response.json()).success).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });

  it('never polls: the engine is called once per request', async () => {
    const { imageId } = await upload(await testImage(1200, 1600));
    const stub = stubEngine(() => Promise.resolve(ocrResponse()));
    const instance = await withEngine(stub.engine);

    await post(instance, { imageId });
    await post(instance, { imageId });

    expect(stub.calls).toHaveLength(2);
  });

  /**
   * Phase 08 adds an endpoint, not a handler. These assert exactly that: the Vision endpoint routes
   * to its own engine, and inherits the guards and the failure mapping the sidecar one is tested
   * for above rather than reimplementing them.
   */
  describe('the Google Cloud Vision endpoint', () => {
    const GCV_URL = '/api/v1/ocr/gcv';

    it('routes to the Vision engine and not to the sidecar', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      const local = stubEngine(() => Promise.resolve(ocrResponse()));
      const gcv = stubEngine(() =>
        Promise.resolve(
          ocrResponse({ engine: 'gcv:builtin/stable', costEstimateUsd: 0.0015, engineMs: 412 }),
        ),
      );
      const instance = await withEngine(local.engine, gcv.engine);

      const response = await post(instance, { imageId }, TOKEN, GCV_URL);

      expect(response.statusCode).toBe(200);
      expect(ocrResponseSchema.safeParse(response.json()).success).toBe(true);
      expect(gcv.calls).toHaveLength(1);
      expect(local.calls).toEqual([]);
    });

    it('builds the path itself here too, from the stored row', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      const gcv = stubEngine(() => Promise.resolve(ocrResponse()));
      const instance = await withEngine(
        stubEngine(() => Promise.resolve(ocrResponse())).engine,
        gcv.engine,
      );

      await post(instance, { imageId }, TOKEN, GCV_URL);

      expect(gcv.calls[0]?.path).toBe(path.join(env.imageDir, `${imageId}.jpg`));
    });

    it('refuses a path where an ID belongs, and requires the bearer token', async () => {
      const gcv = stubEngine(() => Promise.resolve(ocrResponse()));
      const instance = await withEngine(gcv.engine, gcv.engine);

      expect(
        (await post(instance, { imageId: '../../etc/passwd' }, TOKEN, GCV_URL)).statusCode,
      ).toBe(400);
      expect((await post(instance, { imageId: randomUUID() }, null, GCV_URL)).statusCode).toBe(401);
      // Neither request may reach an engine that bills per call.
      expect(gcv.calls).toEqual([]);
    });

    it('reports a credential failure as a 502 the app can record - criterion 6', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      const gcv = stubEngine(() =>
        Promise.reject(new OcrEngineError('Cloud Vision rejected the credentials: no key file')),
      );
      const instance = await withEngine(gcv.engine, gcv.engine);

      const response = await post(instance, { imageId }, TOKEN, GCV_URL);

      // Never a crash and never an empty success: the phone gets a message and writes an attempt
      // row with `error` set, which is a measurement about the method.
      expect(response.statusCode).toBe(502);
      expect((response.json() as { error: string }).error).toBe('engine_failed');
      expect((response.json() as { message: string }).message).toContain('credentials');
    });

    it('answers 504 when Vision outlives its deadline - criterion 7', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      const gcv = stubEngine(() =>
        Promise.reject(
          new OcrEngineError('Cloud Vision did not answer within 30000 ms', { timedOut: true }),
        ),
      );
      const instance = await withEngine(gcv.engine, gcv.engine);

      const response = await post(instance, { imageId }, TOKEN, GCV_URL);

      expect(response.statusCode).toBe(504);
      expect((response.json() as { error: string }).error).toBe('engine_timeout');
    });
  });

  /**
   * Phase 09 adds an endpoint, not a handler - like phase 08 before it. What is genuinely new is
   * that this one's body is **wider than an `OcrResponse`**, and the serialiser drops whatever the
   * route's schema does not name. These assert that the three extra fields survive the trip, that
   * they exist on this endpoint only, and that everything else about the route is still the shared
   * behaviour tested above rather than a second implementation of it.
   */
  describe('the VLM endpoint', () => {
    const VLM_URL = '/api/v1/ocr/vlm';

    function vlmResponse(overrides: Partial<VlmOcrResponse> = {}): VlmOcrResponse {
      return {
        ...ocrResponse({
          engine: 'vlm:openai/gpt-5.4-mini',
          rawText: 'BEST BEFORE\n31.12.2027',
          blocks: [
            { text: 'BEST BEFORE', bbox: null, confidence: null },
            { text: '31.12.2027', bbox: null, confidence: null },
          ],
          engineMs: 3120,
          usage: { inputTokens: 1842, outputTokens: 96 },
          costEstimateUsd: (1842 * 0.75 + 96 * 4.5) / 1_000_000,
        }),
        parsedDate: '2027-12-31',
        modelReasoning: 'BEST BEFORE sits directly above 31.12.2027.',
        promptVersion: 'prompt-v1',
        ...overrides,
      };
    }

    it('returns the model answer and the prompt version, not just an OcrResponse', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      const local = stubEngine(() => Promise.resolve(ocrResponse()));
      const vlm = stubEngine(() => Promise.resolve(vlmResponse()));
      const instance = await withEngine(local.engine, local.engine, vlm.engine);

      const response = await post(instance, { imageId }, TOKEN, VLM_URL);
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(vlm.calls).toHaveLength(1);
      expect(local.calls).toEqual([]);

      // The whole reason this endpoint declares its own response schema. Under the shared
      // `ocrResponseSchema` all three of these are stripped on the way out, the endpoint still
      // answers 200, and the attempt row becomes one nobody can attribute to a prompt - ADR-24.
      expect(vlmOcrResponseSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        parsedDate: '2027-12-31',
        promptVersion: 'prompt-v1',
        engine: 'vlm:openai/gpt-5.4-mini',
      });
      // The tokens the cost was derived from, stored rather than summarised away - criterion 5.
      expect((body as VlmOcrResponse).usage).toEqual({ inputTokens: 1842, outputTokens: 96 });
      // Filled in by the handler, which is the only thing that can measure its own wall time.
      expect((body as VlmOcrResponse).serverTotalMs).toBeGreaterThanOrEqual(0);
    });

    it('keeps the extra fields off the other endpoints', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      // The same engine behind every route, answering with the VLM's wider body. Only the route
      // that declared the wider schema may let it through - otherwise a `parsedDate` could appear
      // on a method that has no model, and the comparison would silently gain a fifth column.
      const wide = stubEngine(() => Promise.resolve(vlmResponse()));
      const instance = await withEngine(wide.engine, wide.engine, wide.engine);

      expect(
        await post(instance, { imageId }, TOKEN, '/api/v1/ocr/local').then((r) => r.json()),
      ).not.toHaveProperty('parsedDate');
      expect(
        await post(instance, { imageId }, TOKEN, '/api/v1/ocr/gcv').then((r) => r.json()),
      ).not.toHaveProperty('promptVersion');
      expect(
        await post(instance, { imageId }, TOKEN, VLM_URL).then((r) => r.json()),
      ).toHaveProperty('parsedDate');
    });

    it('inherits the guards and the failure mapping rather than reimplementing them', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));
      const vlm = stubEngine(() => Promise.resolve(vlmResponse()));
      const instance = await withEngine(vlm.engine, vlm.engine, vlm.engine);

      expect(
        (await post(instance, { imageId: '../../etc/passwd' }, TOKEN, VLM_URL)).statusCode,
      ).toBe(400);
      expect((await post(instance, { imageId: randomUUID() }, null, VLM_URL)).statusCode).toBe(401);
      // Neither request may reach an engine that spends tokens.
      expect(vlm.calls).toEqual([]);

      // The path is the server's own, from the stored row, exactly as on the other two.
      await post(instance, { imageId }, TOKEN, VLM_URL);
      expect(vlm.calls[0]?.path).toBe(path.join(env.imageDir, `${imageId}.jpg`));
    });

    it('records a bad answer as a 502 and a slow one as a 504, separately', async () => {
      const { imageId } = await upload(await testImage(1200, 1600));

      const malformed = stubEngine(() =>
        Promise.reject(
          new OcrEngineError(
            "The model's answer did not conform - answered: I think it expires around December 2027.",
          ),
        ),
      );
      const bad = await withEngine(malformed.engine, malformed.engine, malformed.engine);
      const badResponse = await post(bad, { imageId }, TOKEN, VLM_URL);

      expect(badResponse.statusCode).toBe(502);
      // The raw answer travels with the failure, so the attempt row the phone writes carries what
      // the model actually said rather than only that it was wrong - criterion 7.
      expect((badResponse.json() as { message: string }).message).toContain(
        'I think it expires around December 2027.',
      );

      const slow = stubEngine(() =>
        Promise.reject(
          new OcrEngineError('OpenAI did not answer within 40000 ms', { timedOut: true }),
        ),
      );
      const late = await withEngine(slow.engine, slow.engine, slow.engine);
      const lateResponse = await post(late, { imageId }, TOKEN, VLM_URL);

      expect(lateResponse.statusCode).toBe(504);
      expect((lateResponse.json() as { error: string }).error).toBe('engine_timeout');
    });

    it('starts and serves the other methods with no VLM configuration at all', async () => {
      // No `vlmEngine` injected, so `buildServer` constructs the real one from an environment that
      // has no `OPENAI_API_KEY`. Construction must call nothing and check nothing: the three
      // methods that do not need OpenAI are unaffected, and the VLM endpoint reports the missing
      // credential as a recorded failure rather than as an outage - the phase 08 rule, again.
      const { imageId } = await upload(await testImage(1200, 1600));
      const local = stubEngine(() => Promise.resolve(ocrResponse()));
      const instance = await buildServer({ env, db: handle.db, localOcrEngine: local.engine });
      ocrApps.push(instance);

      expect((await post(instance, { imageId }, TOKEN, '/api/v1/ocr/local')).statusCode).toBe(200);

      const response = await post(instance, { imageId }, TOKEN, VLM_URL);
      expect(response.statusCode).toBe(502);
      expect((response.json() as { message: string }).message).toContain('OPENAI_API_KEY');
    });
  });
});

describe('thumbnails', () => {
  it('has a long edge of 320px and is cached on disk after the first request', async () => {
    const { imageId } = await upload(await testImage(1600, 900));

    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/images/${imageId}/thumb`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    expect(first.headers['x-thumbnail-cache']).toBe('MISS');

    const metadata = await sharp(first.rawPayload).metadata();
    expect(Math.max(metadata.width, metadata.height)).toBe(THUMBNAIL_LONG_EDGE_PX);
    expect(metadata.format).toBe('jpeg');

    const cachePath = path.join(env.thumbDir, `${imageId}.jpg`);
    const mtimeAfterFirst = fs.statSync(cachePath).mtimeMs;

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/images/${imageId}/thumb`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(second.statusCode).toBe(200);
    expect(second.headers['x-thumbnail-cache']).toBe('HIT');
    expect(fs.statSync(cachePath).mtimeMs).toBe(mtimeAfterFirst);
  });

  it('does not enlarge an image smaller than the thumbnail', async () => {
    const { imageId } = await upload(await testImage(100, 80));

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/images/${imageId}/thumb`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const metadata = await sharp(response.rawPayload).metadata();
    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(80);
  });

  it('requires the bearer token, so the grid must send it - phase 06 criterion 9', async () => {
    const { imageId } = await upload(await testImage(400, 300));
    const url = `/api/v1/images/${imageId}/thumb`;

    // The Library's tiles are `<Image>` views, and an `<Image>` pointed at a bare URL renders as an
    // empty box rather than as an error. The token goes on the request instead - ADR-14.
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKEN}` } }))
        .statusCode,
    ).toBe(200);
  });
});

describe('listing', () => {
  it('lists both variants of a capture group and filters by variant - ADR-3', async () => {
    const captureGroupId = randomUUID();
    const image = await testImage(320, 240);

    await upload(image, { captureGroupId, variant: 'upload', downscaled: true });
    await upload(image, { captureGroupId, variant: 'original', downscaled: false });

    const all = await app.inject({
      method: 'GET',
      url: '/api/v1/images',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const items = (all.json() as { items: { captureGroupId: string; variant: string }[] }).items;
    expect(items.filter((row) => row.captureGroupId === captureGroupId)).toHaveLength(2);

    const uploads = await app.inject({
      method: 'GET',
      url: '/api/v1/images?variant=upload',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const uploadItems = (uploads.json() as { items: { variant: string }[] }).items;
    expect(uploadItems).toHaveLength(1);
    expect(uploadItems[0]?.variant).toBe('upload');
  });

  it('filters by source and by capture date range', async () => {
    const image = await testImage(64, 64);

    await upload(image, { source: 'camera', capturedAt: 1_000 });
    await upload(image, { source: 'gallery', capturedAt: 5_000, torch: null });

    const gallery = await app.inject({
      method: 'GET',
      url: '/api/v1/images?source=gallery',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect((gallery.json() as { items: unknown[] }).items).toHaveLength(1);

    const ranged = await app.inject({
      method: 'GET',
      url: '/api/v1/images?from=2000&to=6000',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const rangedItems = (ranged.json() as { items: { capturedAt: number }[] }).items;
    expect(rangedItems).toHaveLength(1);
    expect(rangedItems[0]?.capturedAt).toBe(5_000);
  });

  it('paginates newest first without skipping or repeating a row', async () => {
    const image = await testImage(64, 64);
    const uploaded: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const { imageId } = await upload(image);
      uploaded.push(imageId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const url: string = `/api/v1/images?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      const body = page.json() as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...body.items.map((row) => row.id));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...uploaded].reverse());
  });

  it('refuses a malformed cursor rather than silently starting over', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/images?cursor=not-a-cursor',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a limit beyond the maximum', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/images?limit=1000',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('barcode scans', () => {
  it('records a scan and returns it in the listing - ADR-1', async () => {
    const created = await postScan({ value: '4006381333931', decodeMs: 412.75 });

    expect(created.statusCode).toBe(201);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/barcode-scans',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const items = (listed.json() as { items: BarcodeScan[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: created.id,
      value: '4006381333931',
      device: 'Pixel Test (Android 15)',
    });
    // Sub-millisecond precision survives the round trip. Rounding the measurement at rest would
    // throw away precision the phone actually had - ADR-10.
    expect(items[0]?.decodeMs).toBe(412.75);
    expect(items[0]?.scannedAt).toBeGreaterThan(0);
  });

  it('assigns id and scannedAt itself and refuses a client that supplies them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/barcode-scans',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...scanBody(), id: 'chosen-by-the-phone', scannedAt: 1 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a value that is not thirteen digits', async () => {
    const response = await postScan({ value: '400638133393' });

    expect(response.statusCode).toBe(400);
  });

  it('paginates newest first without skipping or repeating a row', async () => {
    const posted: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const { id } = await postScan({ value: String(4_006_381_333_930 + index) });
      posted.push(id);
      // A POST with no image work behind it takes well under a millisecond, so without this the
      // rows would share a `scannedAt` and the order would fall to the UUID tie-break - which is
      // correct but not the property being asserted here.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const url: string = `/api/v1/barcode-scans?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      const body = page.json() as { items: BarcodeScan[]; nextCursor: string | null };
      seen.push(...body.items.map((row) => row.id));
      cursor = body.nextCursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...posted].reverse());
  });

  it('refuses a malformed cursor rather than silently starting over', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/barcode-scans?cursor=not-a-cursor',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(400);
  });
});

/** A minimal on-device attempt. Overrides let each test change only what it is about. */
function attemptBody(imageId: string, overrides: Partial<AttemptCreate> = {}): AttemptCreate {
  return {
    imageId,
    captureGroupId: randomUUID(),
    method: 'mlkit',
    inputVariant: 'upload',
    device: 'Pixel Test (Android 15)',
    ocr: {
      engine: 'mlkit',
      rawText: 'EXP 12.03.2027',
      blocks: [{ text: 'EXP 12.03.2027', bbox: [10, 20, 200, 40], confidence: null }],
      engineMs: 84.2,
      engineMsScope: 'inference',
      serverTotalMs: null,
      imageWidth: 1600,
      imageHeight: 1200,
      usage: null,
      costEstimateUsd: 0,
      pricingVersion: 'unset',
    },
    parse: parseExpiryDate(
      [{ text: 'EXP 12.03.2027', bbox: [10, 20, 200, 40], confidence: null }],
      {
        referenceDate: new Date(Date.UTC(2025, 5, 1)),
      },
    ),
    vlm: null,
    timing: {
      captureMs: 210.5,
      downscaleMs: 44.1,
      uploadMs: 512.9,
      downloadMs: null,
      requestMs: null,
      engineMs: null,
      serverTotalMs: null,
      parseMs: 1.4,
      totalMs: 852.6,
    },
    referenceDate: '2025-06-01',
    parserVersion: PARSER_VERSION,
    timingVersion: TIMING_VERSION,
    pricingVersion: 'unset',
    promptVersion: null,
    error: null,
    ...overrides,
  };
}

async function postAttempt(
  imageId: string,
  overrides: Partial<AttemptCreate> = {},
): Promise<{ statusCode: number; id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/attempts',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: attemptBody(imageId, overrides),
  });

  return {
    statusCode: response.statusCode,
    id: response.statusCode === 201 ? (response.json() as { id: string }).id : '',
  };
}

function listAttempts(imageId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/images/${imageId}/attempts`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

describe('attempts', () => {
  it('round-trips a record through the JSON payload, not through the flat columns', async () => {
    const { imageId } = await upload(await testImage(320, 240));
    const created = await postAttempt(imageId);

    expect(created.statusCode).toBe(201);

    const listed = await listAttempts(imageId);
    const items = (listed.json() as { items: Attempt[] }).items;

    expect(items).toHaveLength(1);
    const attempt = items[0];
    expect(attempt?.id).toBe(created.id);
    expect(attempt?.ocr?.rawText).toBe('EXP 12.03.2027');
    // The parser's own answer survives the round trip intact, signals and candidates included.
    expect(attempt?.parse?.expiry?.date).toBe('2027-03-12');
    // The anchor and the date share a block, so the anchor sits at distance zero from the
    // candidate and decides. That is the intended reading of "nearest an anchor" - ADR-6.
    expect(attempt?.parse?.rule).toBe('anchor-proximity');
    expect(attempt?.parse?.confidence.signals.length).toBeGreaterThan(0);
    // A null segment stays null. Rendering it as 0 would corrupt every average built on it.
    expect(attempt?.timing.requestMs).toBeNull();
    expect(attempt?.timing.totalMs).toBe(852.6);
    expect(attempt?.parserVersion).toBe(PARSER_VERSION);
    expect(attempt?.timingVersion).toBe(TIMING_VERSION);
  });

  it('records two on-device attempts for one capture, one per variant - ADR-2', async () => {
    const captureGroupId = randomUUID();
    const { imageId } = await upload(await testImage(320, 240), { captureGroupId });

    await postAttempt(imageId, { captureGroupId, inputVariant: 'upload' });
    await postAttempt(imageId, { captureGroupId, inputVariant: 'original' });

    const items = (await listAttempts(imageId)).json() as { items: Attempt[] };

    expect(items.items).toHaveLength(2);
    // (method, inputVariant) is the grouping key; method alone would average the two together.
    expect(items.items.map((row) => row.inputVariant).sort()).toEqual(['original', 'upload']);
  });

  it('appends on a re-run rather than overwriting - ADR-15', async () => {
    const { imageId } = await upload(await testImage(320, 240));

    const first = await postAttempt(imageId);
    const second = await postAttempt(imageId);

    const items = (await listAttempts(imageId)).json() as { items: Attempt[] };

    expect(items.items).toHaveLength(2);
    expect(new Set(items.items.map((row) => row.id))).toEqual(new Set([first.id, second.id]));
  });

  it('stores a failed run as a row rather than as a gap - criterion 13', async () => {
    const { imageId } = await upload(await testImage(320, 240));

    const body = attemptBody(imageId);
    const created = await postAttempt(imageId, {
      ocr: null,
      parse: null,
      error: 'ML Kit returned no result',
      // Nothing was parsed, so there is no parse time. `null`, never `0` - a run that failed before
      // the parser was reached must not contribute a zero-duration parse to any average.
      timing: { ...body.timing, parseMs: null },
    });

    expect(created.statusCode).toBe(201);

    const items = (await listAttempts(imageId)).json() as { items: Attempt[] };
    expect(items.items[0]?.error).toBe('ML Kit returned no result');
    expect(items.items[0]?.ocr).toBeNull();
    expect(items.items[0]?.parse).toBeNull();
    expect(items.items[0]?.timing.parseMs).toBeNull();
  });

  it('refuses an attempt against an image that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: attemptBody(randomUUID()),
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a payload the shared schema rejects', async () => {
    const { imageId } = await upload(await testImage(320, 240));
    const body = attemptBody(imageId);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...body, method: 'not-a-method' },
    });

    expect(response.statusCode).toBe(400);
  });

  it.each(['parserVersion', 'timingVersion'] as const)(
    'refuses a post-migration attempt missing %s',
    async (field) => {
      const { imageId } = await upload(await testImage(320, 240));
      const payload: Record<string, unknown> = { ...attemptBody(imageId) };
      delete payload[field];

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/attempts',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload,
      });

      expect(response.statusCode).toBe(400);
    },
  );

  it('refuses unknown semantic version identifiers', async () => {
    const { imageId } = await upload(await testImage(320, 240));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...attemptBody(imageId), parserVersion: 'parser-typo' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('library filters', () => {
  function list(query: string) {
    return app.inject({
      method: 'GET',
      url: `/api/v1/images${query}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }

  /** The same question, asked of the database directly - criterion 2. */
  function countWhere(predicate: string): number {
    const row = handle.db.$client
      .prepare(`select count(*) as n from images where ${predicate}`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * Four images across three capture groups, in the shapes the Library has to tell apart:
   *
   * - **A** camera capture, uploaded variant, benchmarked, a date extracted.
   * - **B** the archived full-resolution original of A. No attempt row of its own - both of A's
   *   on-device runs hang off the uploaded row - ADR-2, ADR-20.
   * - **C** gallery import, one run that failed, so no date.
   * - **D** camera capture, nothing has been run against it.
   */
  async function fixture() {
    const groupA = randomUUID();
    const groupC = randomUUID();
    const groupD = randomUUID();
    const bytes = await testImage(64, 64);

    const a = await upload(bytes, { captureGroupId: groupA, variant: 'upload', capturedAt: 1_000 });
    const b = await upload(bytes, {
      captureGroupId: groupA,
      variant: 'original',
      downscaled: false,
      capturedAt: 1_000,
    });
    const c = await upload(bytes, {
      captureGroupId: groupC,
      source: 'gallery',
      torch: null,
      capturedAt: 5_000,
    });
    const d = await upload(bytes, { captureGroupId: groupD, capturedAt: 9_000 });

    // The on-device path records one attempt per variant, both against the uploaded row - ADR-2.
    await postAttempt(a.imageId, { captureGroupId: groupA, inputVariant: 'upload' });
    await postAttempt(a.imageId, { captureGroupId: groupA, inputVariant: 'original' });
    // A failure is a row, not a gap - ADR-15. It has been run, and it has no date.
    await postAttempt(c.imageId, {
      captureGroupId: groupC,
      ocr: null,
      parse: null,
      error: 'ML Kit failed to read the image',
    });

    return { groupA, a, b, c, d };
  }

  it('narrows to the same set the database does, and the filters compose - criterion 2', async () => {
    const { groupA } = await fixture();

    // Written out here rather than imported from the route, so that this is a second opinion about
    // what each filter means and not the implementation agreeing with itself.
    const sameGroup = 'attempts.captureGroupId = images.captureGroupId';
    const hasAttemptRow = `exists (select 1 from attempts where ${sameGroup})`;
    const hasDateRow = `exists (select 1 from attempts where ${sameGroup} and attempts.expiryDate is not null)`;

    const cases: { query: string; sql: string; expected: number }[] = [
      { query: '?source=camera', sql: "source = 'camera'", expected: 3 },
      { query: '?source=gallery', sql: "source = 'gallery'", expected: 1 },
      { query: '?variant=original', sql: "variant = 'original'", expected: 1 },
      {
        query: `?captureGroupId=${groupA}`,
        sql: `captureGroupId = '${groupA}'`,
        expected: 2,
      },
      { query: '?from=2000&to=6000', sql: 'capturedAt between 2000 and 6000', expected: 1 },
      { query: '?hasAttempts=true', sql: hasAttemptRow, expected: 3 },
      { query: '?hasAttempts=false', sql: `not ${hasAttemptRow}`, expected: 1 },
      { query: '?hasDate=true', sql: hasDateRow, expected: 2 },
      { query: '?hasDate=false', sql: `not ${hasDateRow}`, expected: 2 },
      // Combinations compose rather than replacing one another.
      {
        query: '?source=camera&hasDate=false',
        sql: `source = 'camera' and not ${hasDateRow}`,
        expected: 1,
      },
      {
        query: '?variant=upload&hasAttempts=true',
        sql: `variant = 'upload' and ${hasAttemptRow}`,
        expected: 2,
      },
    ];

    for (const { query, sql: predicate, expected } of cases) {
      const items = (await list(query)).json() as { items: unknown[] };
      expect(items.items, query).toHaveLength(expected);
      expect(countWhere(predicate), query).toBe(expected);
    }
  });

  it('returns exactly the un-run images for hasAttempts=false - criterion 3', async () => {
    const { d } = await fixture();

    const items = (await list('?hasAttempts=false')).json() as { items: { id: string }[] };

    expect(items.items.map((row) => row.id)).toEqual([d.imageId]);
  });

  it('reads "has been run" per capture group, not per row - ADR-20', async () => {
    const { b } = await fixture();

    // B carries no attempt row of its own: the `original` run that read its pixels was recorded
    // against the group's uploaded row. Answering per row would file the one variant that was
    // benchmarked twice as never benchmarked at all.
    const own = (await listAttempts(b.imageId)).json() as { items: unknown[] };
    expect(own.items).toHaveLength(0);

    const runs = (await list('?hasAttempts=true')).json() as { items: { id: string }[] };
    expect(runs.items.map((row) => row.id)).toContain(b.imageId);
  });

  it('counts an expired date as a date - ADR-7', async () => {
    const groupId = randomUUID();
    const { imageId } = await upload(await testImage(64, 64), { captureGroupId: groupId });

    // Two years before the reference date the parser was given, so it parses cleanly and expires.
    await postAttempt(imageId, {
      captureGroupId: groupId,
      parse: parseExpiryDate([{ text: 'EXP 12.03.2023', bbox: null, confidence: null }], {
        referenceDate: new Date(Date.UTC(2025, 5, 1)),
      }),
    });

    const attempts = (await listAttempts(imageId)).json() as { items: Attempt[] };
    expect(attempts.items[0]?.parse?.expiry?.status).toBe('expired');

    const withDate = (await list('?hasDate=true')).json() as { items: { id: string }[] };
    expect(withDate.items.map((row) => row.id)).toEqual([imageId]);
  });

  it('refuses a boolean filter that is not true or false', async () => {
    // Not silently coerced: every non-empty string is truthy in JavaScript, and a filter that reads
    // "no" as "yes" would make the grid disagree with the database without saying so.
    expect((await list('?hasAttempts=yes')).statusCode).toBe(400);
  });

  it('refuses a filter it does not know rather than ignoring it - phase 07 item 22', async () => {
    // The failure this prevents was observed on 2026-07-30: a deployed server five commits behind
    // the app answered an unknown filter with a full page of rows, so the grid looked like it was
    // filtering and was not. A filter that lies is worse than one that fails.
    const response = await list('?captureGroupId=does-not-exist&noSuchFilter=1');

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('noSuchFilter');
  });
});

/**
 * The listing behind History and the JSON export - phase 10 item 7.
 *
 * What these defend is that every filter is answered in SQL and answered honestly. A filter that
 * silently does nothing is the worst outcome available here: the per-method medians on screen would
 * be taken over a set the chips say is excluded, and nothing would say so.
 */
describe('the attempts listing', () => {
  function listAll(query = '') {
    return app.inject({
      method: 'GET',
      url: `/api/v1/attempts${query}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
  }

  async function items(query = ''): Promise<Attempt[]> {
    const response = await listAll(query);
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { items: Attempt[] }).items;
  }

  it('narrows on every filter it advertises, in SQL', async () => {
    const camera = await upload(await testImage(64, 64), { source: 'camera' });
    const gallery = await upload(await testImage(64, 64), { source: 'gallery' });

    await postAttempt(camera.imageId, { method: 'mlkit', inputVariant: 'upload' });
    await postAttempt(camera.imageId, { method: 'mlkit', inputVariant: 'original' });
    await postAttempt(camera.imageId, { method: 'gcv', parserVersion: LEGACY_PARSER_VERSION });
    await postAttempt(gallery.imageId, { method: 'vlm', timingVersion: LEGACY_TIMING_VERSION });

    expect(await items()).toHaveLength(4);
    expect((await items('?method=mlkit')).map((row) => row.inputVariant).sort()).toEqual([
      'original',
      'upload',
    ]);
    // The two on-device runs stay separable, which is the whole reason `inputVariant` is a filter
    // in its own right rather than a facet of the image's `variant` - ADR-2.
    expect(await items('?method=mlkit&inputVariant=original')).toHaveLength(1);
    expect((await items(`?parserVersion=${LEGACY_PARSER_VERSION}`)).map((r) => r.method)).toEqual([
      'gcv',
    ]);
    expect((await items(`?timingVersion=${LEGACY_TIMING_VERSION}`)).map((r) => r.method)).toEqual([
      'vlm',
    ]);
  });

  it('filters on the photograph origin, which lives on the image and not on the row', async () => {
    const camera = await upload(await testImage(64, 64), { source: 'camera' });
    const gallery = await upload(await testImage(64, 64), { source: 'gallery' });

    await postAttempt(camera.imageId, { method: 'gcv' });
    await postAttempt(gallery.imageId, { method: 'vlm' });

    // Criterion 3 rests on this working: a gallery import has no capture conditions that were ours
    // to set, so its runs may never land in a capture-latency figure beside a camera capture's.
    expect((await items('?source=camera')).map((row) => row.imageId)).toEqual([camera.imageId]);
    expect((await items('?source=gallery')).map((row) => row.imageId)).toEqual([gallery.imageId]);
  });

  it('serves whole rows, because the export cannot un-summarise a summary', async () => {
    const { imageId } = await upload(await testImage(64, 64));
    await postAttempt(imageId);

    const row = (await items())[0];

    expect(row?.ocr?.rawText).toBe('EXP 12.03.2027');
    expect(row?.ocr?.engineMsScope).toBe('inference');
    // Every candidate the parser considered, and the three versioned fields - phase 10 criterion 8.
    expect(Array.isArray(row?.parse?.candidates)).toBe(true);
    expect(row?.parserVersion).toBe(PARSER_VERSION);
    expect(row?.timingVersion).toBe(TIMING_VERSION);
    expect(row?.pricingVersion).toBe('unset');
    expect(row?.referenceDate).toBe('2025-06-01');
  });

  it('pages newest first and never repeats a row across a page boundary', async () => {
    const { imageId } = await upload(await testImage(64, 64));
    for (let index = 0; index < 5; index += 1) {
      await postAttempt(imageId);
    }

    const first = (await listAll('?limit=2')).json() as { items: Attempt[]; nextCursor: string };
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const seen = [...first.items.map((row) => row.id)];
    let cursor: string | null = first.nextCursor;

    while (cursor !== null) {
      const page = (await listAll(`?limit=2&cursor=${encodeURIComponent(cursor)}`)).json() as {
        items: Attempt[];
        nextCursor: string | null;
      };
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    }

    // Five distinct rows, newest first. The four methods of one re-run-all share a millisecond
    // routinely, so the cursor's `id` tie-breaker is what keeps this true rather than lucky.
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('refuses a filter it does not know rather than ignoring it', async () => {
    // The same failure the image listing is strict against: a server behind the app would otherwise
    // answer an unknown filter with a full unfiltered page, and the screen would look like it was
    // filtering. Here that would put two populations into one median.
    const response = await listAll('?method=gcv&engine=gcv:builtin/stable');

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('engine');
  });

  it('refuses a malformed cursor rather than silently starting over', async () => {
    expect((await listAll('?cursor=not-a-cursor')).statusCode).toBe(400);
  });

  it('answers an empty set with an empty page, not with an error', async () => {
    const response = await listAll('?method=onnx-paddleocr-cyrillic');

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });
});

describe('query plans', () => {
  /** The plan for the query the route runs - it is built by the same function - criterion 10. */
  function planFor(query: Record<string, string>, cursor: ListCursor | null = null): string[] {
    // Parsed from the string form, exactly as the query string delivers it.
    const built = imageListQuery(handle.db, imageListQuerySchema.parse(query), cursor).toSQL();

    const rows = handle.db.$client
      .prepare(`EXPLAIN QUERY PLAN ${built.sql}`)
      .all(...(built.params as never[])) as { detail: string }[];

    return rows.map((row) => row.detail.trim());
  }

  /** A line that scans `images` without naming an index is the full table scan to look for. */
  function fullScans(plan: string[]): string[] {
    return plan.filter(
      (detail) => /^SCAN (TABLE )?images\b/.test(detail) && !detail.includes('USING'),
    );
  }

  it('reads the default listing and every single filter out of an index - criterion 10', () => {
    const plans: { label: string; plan: string[] }[] = [
      { label: 'default listing', plan: planFor({}) },
      { label: 'next page', plan: planFor({}, { sortKey: 1_780_000_000_000, id: randomUUID() }) },
      { label: 'source', plan: planFor({ source: 'camera' }) },
      { label: 'variant', plan: planFor({ variant: 'upload' }) },
      { label: 'captureGroupId', plan: planFor({ captureGroupId: randomUUID() }) },
      { label: 'capturedAt range', plan: planFor({ from: '1000', to: '2000' }) },
      { label: 'hasAttempts', plan: planFor({ hasAttempts: 'true' }) },
      { label: 'hasDate', plan: planFor({ hasDate: 'false' }) },
    ];

    for (const { label, plan } of plans) {
      expect(fullScans(plan), `${label}: ${plan.join(' | ')}`).toEqual([]);
    }
  });

  it('finds the attempt rows behind hasAttempts and hasDate without scanning them', () => {
    // The subquery is what turns these two filters from a table scan per row into an index lookup.
    for (const plan of [planFor({ hasAttempts: 'true' }), planFor({ hasDate: 'true' })]) {
      const attemptLines = plan.filter((detail) => detail.includes('attempts'));
      expect(attemptLines.length, plan.join(' | ')).toBeGreaterThan(0);
      for (const line of attemptLines) {
        expect(line, plan.join(' | ')).toMatch(/USING (COVERING )?INDEX/);
      }
    }
  });

  /** The same check for History's listing, built by the function the route calls. */
  function attemptPlanFor(
    query: Record<string, string>,
    cursor: ListCursor | null = null,
  ): string[] {
    const built = attemptListQuery(handle.db, attemptListQuerySchema.parse(query), cursor).toSQL();

    const rows = handle.db.$client
      .prepare(`EXPLAIN QUERY PLAN ${built.sql}`)
      .all(...(built.params as never[])) as { detail: string }[];

    return rows.map((row) => row.detail.trim());
  }

  it('walks the export path in index order rather than sorting each page', () => {
    // The JSON export pages through the unfiltered listing to exhaustion, so this is the plan that
    // runs most. A `USE TEMP B-TREE FOR ORDER BY` here would mean SQLite sorting the whole table
    // once per page; `attempts_createdAt_id_idx` is what stops it, and the plan naming the index is
    // the evidence rather than the assertion that it exists.
    const queries: Record<string, string>[] = [{}, { from: '1000', to: '2000' }];

    for (const query of queries) {
      const plan = attemptPlanFor(query);
      expect(plan.join(' | '), JSON.stringify(query)).toContain('attempts_createdAt_id_idx');
      expect(plan.join(' | '), JSON.stringify(query)).not.toContain('TEMP B-TREE FOR ORDER BY');
    }
  });

  it('reads every filtered listing out of an index, sorting at most the rows it matched', () => {
    // A `method` filter takes `attempts_method_inputVariant_idx` and then sorts what it matched,
    // because no one index can serve an equality on `method` and an ordering on `createdAt` at the
    // same time. That is a sort over the matched subset, not the table scan this checks for, and
    // adding a third index on the same leading column to remove it would only buy write cost - the
    // same trade the image listing documents for its `capturedAt` range.
    const queries: Record<string, string>[] = [
      { method: 'gcv' },
      { method: 'mlkit', inputVariant: 'original' },
      { parserVersion: PARSER_VERSION },
      { timingVersion: TIMING_VERSION },
      { source: 'camera' },
    ];

    for (const query of queries) {
      const plan = attemptPlanFor(query);
      const scans = plan.filter(
        (detail) => /^SCAN (TABLE )?attempts\b/.test(detail) && !detail.includes('USING'),
      );
      expect(scans, `${JSON.stringify(query)}: ${plan.join(' | ')}`).toEqual([]);
    }
  });

  it('answers the source filter through the images primary key, not a scan of images', () => {
    // `source` lives on `images`, and the subquery is what keeps asking for it from costing a scan
    // per attempt row.
    const plan = attemptPlanFor({ source: 'camera' });
    const imageLines = plan.filter((detail) => detail.includes('images'));

    expect(imageLines.length, plan.join(' | ')).toBeGreaterThan(0);
    for (const line of imageLines) {
      expect(line, plan.join(' | ')).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/);
    }
  });
});

describe('durability', () => {
  it('keeps images and rows across a restart of the server process', async () => {
    const { imageId } = await upload(await testImage(200, 150));
    const scan = await postScan();

    await app.close();
    handle.close();

    handle = openDatabase(env.databasePath);
    app = await buildServer({ env, db: handle.db });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/images/${imageId}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);

    // The barcode numbers outliving the process is the whole reason they are recorded here rather
    // than in the screen that produced them - ADR-1.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/barcode-scans',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect((listed.json() as { items: BarcodeScan[] }).items[0]?.id).toBe(scan.id);
  });
});
