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

  it('reports a timeout while reading the body as a timeout, not as a bad shape', async () => {
    // `docker pause` between the status line and the JSON. The engine was not wrong here, it was
    // too slow, and the two are different results about it - criterion 10.
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"0": {"rec_txt": "07/2027",');
      // Deliberately never finished.
    };

    const failure = await engine({ timeoutMs: 300 })
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    expect((failure as OcrEngineError).timedOut).toBe(true);
  });

  it('refuses geometry that is not the four points the engine was measured to return', async () => {
    // A single point converts to `bbox: [500, 500, 0, 0]` - which looks like geometry, is not, and
    // would enter the record as though it were.
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ '0': { rec_txt: '07/2027', dt_boxes: [[500, 500]], score: 0.9 } }),
      );
    };

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      OcrEngineError,
    );
  });

  it('refuses a confidence outside [0, 1] rather than clamping it into range', async () => {
    // Clamping 7 to 1 would record fabricated certainty. A score that far out is a broken engine.
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          '0': {
            rec_txt: '07/2027',
            dt_boxes: [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
            ],
            score: 7,
          },
        }),
      );
    };

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      OcrEngineError,
    );
  });

  it('runs one call at a time, because overlapping inference measures contention', async () => {
    // The spike measured two simultaneous requests at 4.5 s and 4.1 s against 1.9 s solo, and asks
    // for a queue if overlap is possible. This asserts the queue exists, not how fast it is.
    let inFlight = 0;
    let maxInFlight = 0;

    sidecar.removeAllListeners('request');
    sidecar.on('request', (request, response) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      request.resume();
      setTimeout(() => {
        inFlight -= 1;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(twoBlocks());
      }, 40);
    });

    const shared = engine();
    await Promise.all([
      shared.recognise({ imageId: 'a', path: imagePath }),
      shared.recognise({ imageId: 'b', path: imagePath }),
      shared.recognise({ imageId: 'c', path: imagePath }),
    ]);

    expect(maxInFlight).toBe(1);
  });

  it('keeps serving after a failed call rather than wedging the queue', async () => {
    const shared = engine();

    respond = (_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('Internal Server Error');
    };
    await expect(shared.recognise({ imageId: 'a', path: imagePath })).rejects.toThrow(
      OcrEngineError,
    );

    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(twoBlocks());
    };
    await expect(shared.recognise({ imageId: 'b', path: imagePath })).resolves.toMatchObject({
      engine: 'onnx-paddleocr',
    });
  });

  it('abandons the call when the caller goes away, and says that is what happened', async () => {
    respond = () => {
      // Never answers, so only the caller's own signal can end this.
    };

    const controller = new AbortController();
    const pending = engine()
      .recognise({ imageId: 'an-id', path: imagePath, signal: controller.signal })
      .catch((error: unknown) => error);

    setTimeout(() => controller.abort(), 50);
    const failure = await pending;

    expect(failure).toBeInstanceOf(OcrEngineError);
    // A dropped client is not an engine failure, and must not be counted as one.
    expect((failure as OcrEngineError).cancelled).toBe(true);
    expect((failure as OcrEngineError).timedOut).toBe(false);
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
