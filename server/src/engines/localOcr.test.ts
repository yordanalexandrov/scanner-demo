import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { elapsed, now, ocrResponseSchema } from '@scanner-demo/shared';
import { createLocalOcrEngine } from './localOcr.js';
import { OcrEngineError } from './types.js';

/**
 * The sidecar is a black box reached over HTTP, so these run against a stub that answers exactly
 * what the real container was observed to answer - docs/spikes/07-ocr-sidecar.md § 6. Real HTTP,
 * real multipart, real timeouts: a mocked `fetch` would prove the adapter agrees with itself.
 */

let sidecar: http.Server;
let baseUrl: string;
let root: string;
let imagePath: string;

/** Whatever the current test wants the stub to do. Replaced per test, not per request. */
let respond: (request: http.IncomingMessage, response: http.ServerResponse) => void;

/** The shape the container returns: an object keyed by stringified index, quads and a score. */
function twoBlocks(): string {
  return JSON.stringify({
    '0': {
      rec_txt: 'roeH 0: 07/2027',
      dt_boxes: [
        [57, 642],
        [983, 640],
        [983, 743],
        [57, 745],
      ],
      score: 0.85122,
    },
    '1': {
      rec_txt: 'apT.No 4820',
      dt_boxes: [
        [62, 884],
        [613, 880],
        [613, 936],
        [62, 940],
      ],
      score: 0.88677,
    },
  });
}

function engine(overrides: { timeoutMs?: number } = {}) {
  return createLocalOcrEngine({ baseUrl, timeoutMs: overrides.timeoutMs ?? 5_000 });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-demo-ocr-'));
  imagePath = path.join(root, 'image.jpg');

  await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: { r: 242, g: 240, b: 236 } },
  })
    .jpeg()
    .toFile(imagePath);

  respond = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(twoBlocks());
  };

  sidecar = http.createServer((request, response) => {
    // Drained before answering, exactly as the real server does - an unread request body leaves the
    // connection in a state that turns a clean answer into a reset.
    request.resume();
    request.on('end', () => {
      respond(request, response);
    });
  });

  await new Promise<void>((resolve) => sidecar.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    sidecar.closeAllConnections();
    sidecar.close(() => {
      resolve();
    });
  });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the sidecar adapter', () => {
  it('produces a response the shared schema accepts', async () => {
    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    expect(ocrResponseSchema.safeParse(result).success).toBe(true);
    expect(result.engine).toBe('onnx-paddleocr');
    // The container reports no duration of its own, so this is the whole call and says so - phase
    // 07 item 19, ADR-10.
    expect(result.engineMsScope).toBe('inference+network');
    expect(result.engineMs).toBeGreaterThan(0);
    // Marginal cost on a VPS that is already paid for. `0` here is a measured claim, not a
    // placeholder for "unknown" - ADR-11.
    expect(result.costEstimateUsd).toBe(0);
    expect(result.usage).toBeNull();
  });

  it('uploads the bytes rather than a path - the engine has no path parameter', async () => {
    let contentType = '';
    let body = Buffer.alloc(0);

    sidecar.removeAllListeners('request');
    sidecar.on('request', (request, response) => {
      contentType = request.headers['content-type'] ?? '';
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        body = Buffer.concat(chunks);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{}');
      });
    });

    await engine().recognise({ imageId: 'an-id', path: imagePath });

    expect(contentType).toContain('multipart/form-data');
    expect(body.toString('latin1')).toContain('name="image_file"');
    // The JPEG's own magic number, so this asserts the bytes travelled and not their filename.
    expect(body.toString('latin1')).toContain('\xff\xd8\xff');
  });

  it('converts the quadrilateral into an axis-aligned bbox - ADR-5', async () => {
    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    // The engine returns a rotated four-point quad; ADR-5 fixes [x, y, width, height]. The
    // axis-aligned box of the quad is the honest conversion - x from 57, y from 640, out to
    // 983 and 745.
    expect(result.blocks[0]?.bbox).toEqual([57, 640, 926, 105]);
    expect(result.blocks[0]?.confidence).toBeCloseTo(0.85122, 5);
    expect(result.blocks[0]?.text).toBe('roeH 0: 07/2027');
  });

  it('reports the dimensions of the image it sent, so bboxes can be normalised', async () => {
    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    expect(result.imageWidth).toBe(1200);
    expect(result.imageHeight).toBe(1600);
  });

  it('assembles rawText, which the engine does not provide', async () => {
    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    // Detection order, not reading order, and deliberately not re-sorted: the accuracy figures in
    // the spike were scored on the blocks in this order.
    expect(result.rawText).toBe('roeH 0: 07/2027\napT.No 4820');
  });

  it('treats an empty object as "no text", not as a failure', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    };

    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    expect(result.blocks).toEqual([]);
    expect(result.rawText).toBe('');
    // A blank answer is a result about the engine and is recorded as one - phase 05's rule that a
    // failure is data applies to a legitimate blank too.
    expect(ocrResponseSchema.safeParse(result).success).toBe(true);
  });

  it('treats any non-200 as an engine failure and does not parse the body', async () => {
    // The container answers a corrupt image with HTTP 500 and the plain string below - there is no
    // JSON error shape to read, so the adapter must not try to find one.
    respond = (_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('Internal Server Error');
    };

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      OcrEngineError,
    );
  });

  it('rejects a 200 whose body is not the shape the engine promises', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ '0': { rec_txt: 'a date', score: 'high' } }));
    };

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      OcrEngineError,
    );
  });

  it('fails inside the timeout against a sidecar that never answers - criterion 10', async () => {
    respond = () => {
      // Deliberately no response, and no `end()`: this is `docker pause` in miniature.
    };

    const started = now();

    const failure = await engine({ timeoutMs: 300 })
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    expect((failure as OcrEngineError).timedOut).toBe(true);
    // Generous, because the assertion is "it returned rather than hanging", not a latency claim.
    expect(elapsed(started)).toBeLessThan(5_000);
  });

  it('fails rather than hanging when the sidecar is not there at all', async () => {
    await new Promise<void>((resolve) => {
      sidecar.close(() => {
        resolve();
      });
    });

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      OcrEngineError,
    );
  });
});
