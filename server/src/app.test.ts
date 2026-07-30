import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageListQuerySchema, parseExpiryDate } from '@scanner-demo/shared';
import type {
  Attempt,
  AttemptCreate,
  BarcodeScan,
  BarcodeScanCreate,
  ImageUploadMeta,
} from '@scanner-demo/shared';
import { buildServer } from './app.js';
import { openDatabase } from './db/client.js';
import type { DbHandle } from './db/client.js';
import { loadEnv } from './env.js';
import type { Env } from './env.js';
import type { ListCursor } from './lib/cursor.js';
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
