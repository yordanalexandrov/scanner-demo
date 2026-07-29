import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BarcodeScan, BarcodeScanCreate, ImageUploadMeta } from '@scanner-demo/shared';
import { buildServer } from './app.js';
import { openDatabase } from './db/client.js';
import type { DbHandle } from './db/client.js';
import { loadEnv } from './env.js';
import type { Env } from './env.js';
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
