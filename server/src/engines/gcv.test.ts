import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRICING_VERSION, ocrResponseSchema } from '@scanner-demo/shared';
import { createGcvEngine } from './gcv.js';
import type { AnnotateImage } from './gcv.js';
import { OcrEngineError } from './types.js';
import type { protos } from '@google-cloud/vision';

type AnnotateImageResponse = protos.google.cloud.vision.v1.IAnnotateImageResponse;
type BreakType = NonNullable<
  NonNullable<
    NonNullable<protos.google.cloud.vision.v1.ISymbol['property']>['detectedBreak']
  >['type']
>;

/**
 * These run against the SDK seam rather than against a socket, unlike the sidecar's tests.
 *
 * The sidecar is a black box on the other end of plain HTTP, so a stub server there tests the real
 * wire format. Vision is reached through gRPC and protobuf inside a Google-maintained client;
 * standing a fake gRPC endpoint in front of it would exercise protobuf-js and the auth library, not
 * this adapter. What is on this side of the seam is everything the adapter is answerable for - the
 * request it builds, the tree it flattens, the geometry it converts, the failures it names.
 *
 * The fixtures are built from the documented `AnnotateImageResponse` shape, including the parts that
 * are easy to get wrong and only show up in real data: a vertex whose `x` is omitted because it is
 * zero, breaks that carry the spacing, and a per-image `error` inside an otherwise successful call.
 * Confirming they match the real thing is what the acceptance run with real credentials is for.
 */

let root: string;
let imagePath: string;

function engine(annotate: AnnotateImage, timeoutMs = 5_000) {
  return createGcvEngine({ timeoutMs, annotate });
}

/** A symbol with the break that follows it, in the form Vision reports. */
function symbol(text: string, breakType?: BreakType) {
  return breakType === undefined
    ? { text }
    : { text, property: { detectedBreak: { type: breakType } } };
}

/**
 * One block: `EXP 12.03.2027` over two words, ending in the line break Vision appends.
 *
 * `confidence` is a parameter because an out-of-range one is a case in its own right: it must be
 * refused rather than clamped. The absent case is {@link withoutConfidence}, because protobuf drops
 * the field entirely rather than sending a null.
 */
function oneBlock(confidence = 0.93): AnnotateImageResponse {
  return {
    fullTextAnnotation: {
      text: 'EXP 12.03.2027\n',
      pages: [
        {
          width: 1200,
          height: 1600,
          blocks: [
            {
              boundingBox: {
                // `x` omitted on the first vertex, because protobuf drops a zero. A box that
                // touches the left edge arrives exactly like this from the real API.
                vertices: [{ y: 640 }, { x: 983, y: 640 }, { x: 983, y: 745 }, { y: 745 }],
              },
              confidence,
              paragraphs: [
                {
                  words: [
                    { symbols: [symbol('E'), symbol('X'), symbol('P', 'SPACE')] },
                    {
                      symbols: [
                        symbol('1'),
                        symbol('2'),
                        symbol('.'),
                        symbol('0'),
                        symbol('3'),
                        symbol('.'),
                        symbol('2'),
                        symbol('0'),
                        symbol('2'),
                        symbol('7', 'LINE_BREAK'),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** The same response with the field removed, which is what "Vision reported no confidence" is. */
function withoutConfidence(response: AnnotateImageResponse): AnnotateImageResponse {
  const block = response.fullTextAnnotation?.pages?.[0]?.blocks?.[0];

  if (block !== undefined) {
    delete block.confidence;
  }

  return response;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-demo-gcv-'));
  imagePath = path.join(root, 'image.jpg');

  await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: { r: 242, g: 240, b: 236 } },
  })
    .jpeg()
    .toFile(imagePath);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the Cloud Vision adapter', () => {
  it('produces a response the shared schema accepts', async () => {
    const result = await engine(() => Promise.resolve(oneBlock())).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    expect(ocrResponseSchema.safeParse(result).success).toBe(true);
    // The model is part of the engine string, so a stored record stays interpretable after Google
    // moves its default on - phase 08 item 8.
    expect(result.engine).toBe('gcv:builtin/stable');
    // The SDK cannot separate Google's inference from the trip to it - criterion 3, ADR-10.
    expect(result.engineMsScope).toBe('inference+network');
    expect(result.engineMs).toBeGreaterThan(0);
    expect(result.usage).toBeNull();
    expect(result.pricingVersion).toBe(PRICING_VERSION);
  });

  it('sends the pinned model, the stored bytes and no tuning of any kind', async () => {
    let seen: Parameters<AnnotateImage>[0] | null = null;
    let options: Parameters<AnnotateImage>[1] | null = null;

    await engine((request, callOptions) => {
      seen = request;
      options = callOptions;
      return Promise.resolve(oneBlock());
    }).recognise({ imageId: 'an-id', path: imagePath });

    const request = seen as unknown as Parameters<AnnotateImage>[0];

    expect(request.features).toEqual([
      { type: 'DOCUMENT_TEXT_DETECTION', model: 'builtin/stable' },
    ]);
    // No `imageContext`: no language hints, no crop hints, nothing tuned for this engine. Every
    // engine sees the same bytes or the accuracy column measures the tuning.
    expect(request.imageContext).toBeUndefined();
    // The JPEG's own magic number, base64-encoded, so this asserts the stored bytes travelled.
    expect(String(request.image?.content)).toMatch(/^\/9j\//u);
    // An explicit deadline, not the SDK's ten-minute default - criterion 7.
    expect(options).toEqual({ timeout: 5_000 });
  });

  it('assembles block text from the symbol tree, spacing it by the reported breaks', async () => {
    const result = await engine(() => Promise.resolve(oneBlock())).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    // One `Block` per Vision block, at the granularity ML Kit reports, with the trailing layout
    // break dropped so the two paths hand the parser the same thing.
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.text).toBe('EXP 12.03.2027');
    // `rawText` is Vision's own joined string, verbatim, exactly as ML Kit's is its own.
    expect(result.rawText).toBe('EXP 12.03.2027\n');
  });

  it('converts the bounding polygon into [x, y, width, height] - ADR-5', async () => {
    const result = await engine(() => Promise.resolve(oneBlock())).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    // The omitted `x` on two vertices is a zero, not a gap: protobuf drops default values, so a box
    // against the left edge has no `x` field at all.
    expect(result.blocks[0]?.bbox).toEqual([0, 640, 983, 105]);
    expect(result.blocks[0]?.confidence).toBeCloseTo(0.93, 5);
  });

  it('records the dimensions Vision reports, so the boxes can be normalised against them', async () => {
    const result = await engine(() => Promise.resolve(oneBlock())).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    expect(result.imageWidth).toBe(1200);
    expect(result.imageHeight).toBe(1600);
  });

  it('falls back to the stored image when Vision reports no page at all', async () => {
    const result = await engine(() => Promise.resolve({ fullTextAnnotation: null })).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    // No text found is a legitimate answer and a measurement about the engine, so it is an empty
    // result rather than a failure - and it still has to say what was looked at.
    expect(result.blocks).toEqual([]);
    expect(result.rawText).toBe('');
    expect(result.imageWidth).toBe(1200);
    expect(result.imageHeight).toBe(1600);
    expect(ocrResponseSchema.safeParse(result).success).toBe(true);
  });

  it('prices one image from the shared table, per unit rather than per thousand', async () => {
    const result = await engine(() => Promise.resolve(oneBlock())).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    // $1.50 per 1000 units, so one image is $0.0015. Non-zero, and deliberately not the free-tier
    // figure the billing console will show at this volume - criterion 4, ADR-11.
    expect(result.costEstimateUsd).toBeCloseTo(0.0015, 10);
  });

  it('records a missing confidence as null rather than as certainty - ADR-5', async () => {
    const result = await engine(() => Promise.resolve(withoutConfidence(oneBlock()))).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    expect(result.blocks[0]?.confidence).toBeNull();
  });

  it('treats a per-image error inside a successful call as a failure, not as an empty read', async () => {
    // The RPC succeeded; the annotation did not. Recording zero blocks here would file "Bad image
    // data" as a measurement of what Vision can read - criterion 6.
    const failure = await engine(() =>
      Promise.resolve({ error: { code: 3, message: 'Bad image data' } }),
    )
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    expect((failure as OcrEngineError).message).toContain('Bad image data');
    expect((failure as OcrEngineError).timedOut).toBe(false);
  });

  it('reports DEADLINE_EXCEEDED as a timeout and nothing else as one - criterion 7', async () => {
    const deadline = Object.assign(new Error('Total timeout of API exceeded'), { code: 4 });

    const failure = await engine(() => Promise.reject(deadline))
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    // "It was too slow" and "it was wrong" are different results about the engine, and the route
    // answers 504 for one and 502 for the other.
    expect((failure as OcrEngineError).timedOut).toBe(true);
  });

  it('names a credential failure for what it is - criterion 6', async () => {
    const denied = Object.assign(new Error('Request had invalid authentication credentials'), {
      code: 16,
    });

    const failure = await engine(() => Promise.reject(denied))
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    expect((failure as OcrEngineError).message).toContain('credentials');
    // Ours to fix, not Google's to blame, and above all not a timeout.
    expect((failure as OcrEngineError).timedOut).toBe(false);
  });

  it('names a missing key file rather than surfacing a bare ENOENT', async () => {
    const missing = new Error("ENOENT: no such file or directory, open '/secrets/gcv.json'");

    const failure = await engine(() => Promise.reject(missing))
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    expect((failure as OcrEngineError).message).toContain('credentials');
  });

  it('refuses a confidence outside [0, 1] rather than clamping it into range', async () => {
    // Clamping 7 to 1 would record fabricated certainty. A score that far out is a broken engine,
    // and the same rule holds on the sidecar path.
    await expect(
      engine(() => Promise.resolve(oneBlock(7))).recognise({ imageId: 'an-id', path: imagePath }),
    ).rejects.toThrow(OcrEngineError);
  });

  it('rejects a response whose shape is not the one the SDK promises', async () => {
    await expect(
      engine(() =>
        Promise.resolve({ fullTextAnnotation: { pages: [{ blocks: 'several' }] } } as never),
      ).recognise({ imageId: 'an-id', path: imagePath }),
    ).rejects.toThrow(OcrEngineError);
  });

  /**
   * These two run against the **real** engine, with no seam in front of it, because what they check
   * is the guard that stands before the SDK - and a stub would stand exactly where the guard does.
   *
   * The guard exists for a measured reason: `@google-cloud/vision` 5.3.7 answers a missing key file
   * and an absent default credential by rejecting the call *and* leaving a floating rejection
   * behind, which Node 22 turns into a dead process. Answering before the SDK is reached is what
   * makes criterion 6's "never a crash" true rather than hoped for. Neither test touches the
   * network, and neither can: both fail before a client is constructed.
   */
  it('refuses without credentials rather than searching for some - criterion 6', async () => {
    const failure = await createGcvEngine({ timeoutMs: 5_000, credentialsPath: null })
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    expect((failure as OcrEngineError).message).toContain('GOOGLE_APPLICATION_CREDENTIALS');
    expect((failure as OcrEngineError).timedOut).toBe(false);
  });

  it('names the key file it cannot read - criterion 6', async () => {
    const keyFile = path.join(root, 'gcv-service-account.json');

    const failure = await createGcvEngine({ timeoutMs: 5_000, credentialsPath: keyFile })
      .recognise({ imageId: 'an-id', path: imagePath })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OcrEngineError);
    // The path, so the operator knows which file to put where rather than that "auth failed".
    expect((failure as OcrEngineError).message).toContain(keyFile);
  });

  it('honours a numeric break enum as well as a named one', async () => {
    // gax reports enum names by default. A configuration that reported numbers instead would
    // otherwise concatenate every word into one, and "EXP12.03.2027" is what the parser would then
    // be scored on - a silent accuracy loss, so it is handled rather than assumed away.
    const numbered = {
      fullTextAnnotation: {
        text: 'EXP 12.03.2027',
        pages: [
          {
            width: 10,
            height: 10,
            blocks: [
              {
                boundingBox: { vertices: [{ x: 0, y: 0 }, { x: 10 }, { x: 10, y: 10 }, { y: 10 }] },
                paragraphs: [
                  {
                    words: [
                      { symbols: [{ text: 'EXP', property: { detectedBreak: { type: 1 } } }] },
                      { symbols: [{ text: '12.03.2027' }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    const result = await engine(() => Promise.resolve(numbered)).recognise({
      imageId: 'an-id',
      path: imagePath,
    });

    expect(result.blocks[0]?.text).toBe('EXP 12.03.2027');
  });
});
