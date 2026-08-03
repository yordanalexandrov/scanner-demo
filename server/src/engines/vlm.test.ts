import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRICING_VERSION, vlmOcrResponseSchema } from '@scanner-demo/shared';
import { createVlmEngine } from './vlm.js';
import { OcrEngineError } from './types.js';
import { PROMPT, PROMPT_VERSION } from '../vlm/prompt.js';
import { selectVlmProvider } from '../vlm/index.js';

/**
 * The VLM adapter and the OpenAI provider together, against a stub that answers what the Responses
 * API answers - real HTTP, real JSON, real timeouts.
 *
 * The seam is the socket rather than a mocked `fetch`, for the reason the sidecar's tests give: a
 * mocked client proves the adapter agrees with itself. What is on this side of the seam is
 * everything these two files are responsible for - the request they build, the answer they parse,
 * the failures they classify, the cost they derive - and what is on the other side is OpenAI's
 * inference, which no test here could make a claim about.
 *
 * The response fixtures are built from the documented Responses shape, read on 2026-08-03; the
 * acceptance run against the real API with a real key is what confirms they match it.
 */

let openai: http.Server;
let baseUrl: string;
let root: string;
let imagePath: string;

/** Whatever the current test wants the stub to do. Replaced per test, not per request. */
let respond: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void;

/** What the model is asked to produce, as it arrives: a JSON string inside `output_text`. */
function modelAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    textLines: ['MLEKO 3.2%', 'BEST BEFORE', '31.12.2027', 'LOT 4820'],
    expiryDate: '2027-12-31',
    reasoning: 'BEST BEFORE sits directly above 31.12.2027.',
    ...overrides,
  });
}

function responsesBody(
  options: { text?: string; refusal?: string; status?: string; usage?: unknown } = {},
): string {
  return JSON.stringify({
    id: 'resp_1',
    status: options.status ?? 'completed',
    output: [
      {
        type: 'message',
        content: [
          options.refusal === undefined
            ? { type: 'output_text', text: options.text ?? modelAnswer() }
            : { type: 'refusal', refusal: options.refusal },
        ],
      },
    ],
    usage: options.usage ?? {
      input_tokens: 1842,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 96,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 1938,
    },
  });
}

function engine(
  overrides: { model?: string; provider?: string; timeoutMs?: number; apiKey?: string } = {},
) {
  return createVlmEngine({
    provider: selectVlmProvider({
      provider: overrides.provider ?? 'openai',
      model: overrides.model ?? 'gpt-5.4-mini',
      timeoutMs: overrides.timeoutMs ?? 5_000,
      env: {
        OPENAI_API_KEY: overrides.apiKey ?? 'sk-test-not-a-real-key',
        OPENAI_BASE_URL: baseUrl,
      },
    }),
  });
}

/** The JSON body the stub received, for the assertions about what was actually sent. */
let received: Record<string, unknown> | null = null;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-demo-vlm-'));
  imagePath = path.join(root, 'image.jpg');
  received = null;

  await sharp({
    create: { width: 1200, height: 1600, channels: 3, background: { r: 242, g: 240, b: 236 } },
  })
    .jpeg()
    .toFile(imagePath);

  respond = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(responsesBody());
  };

  openai = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      try {
        received = JSON.parse(body) as Record<string, unknown>;
      } catch {
        received = null;
      }
      respond(request, response, body);
    });
  });

  await new Promise<void>((resolve) => openai.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(openai.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    openai.closeAllConnections();
    openai.close(() => {
      resolve();
    });
  });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the VLM adapter', () => {
  it('produces a response the shared VLM schema accepts', async () => {
    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    expect(vlmOcrResponseSchema.safeParse(result).success).toBe(true);

    // Provider and model, never a bare `vlm` - criterion 2. Old records must stay interpretable
    // after the provider moves its default on.
    expect(result.engine).toBe('vlm:openai/gpt-5.4-mini');

    // The model's own answer and the raw text it says it read, both recorded - item 3.
    expect(result.parsedDate).toBe('2027-12-31');
    expect(result.modelReasoning).toContain('BEST BEFORE');
    expect(result.rawText).toBe('MLEKO 3.2%\nBEST BEFORE\n31.12.2027\nLOT 4820');

    // One block per transcribed line, and `rawText` is those same lines joined - the two views
    // cannot disagree about what was read.
    expect(result.blocks.map((block) => block.text)).toEqual(result.rawText.split('\n'));

    // No geometry and no confidence: a VLM reports neither, and inventing either would fill a
    // measured column with guesses - ADR-4, ADR-5.
    expect(result.blocks.every((block) => block.bbox === null)).toBe(true);
    expect(result.blocks.every((block) => block.confidence === null)).toBe(true);

    // There is no way to separate the model's inference from the trip to it - ADR-10.
    expect(result.engineMsScope).toBe('inference+network');
    expect(result.engineMs).toBeGreaterThan(0);
    // Only the handler can measure its own wall time.
    expect(result.serverTotalMs).toBeNull();
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it('derives the cost from the tokens the call reported, and stores them', async () => {
    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    // Persisted, so the figure below can be re-derived from the export - criterion 5.
    expect(result.usage).toEqual({ inputTokens: 1842, outputTokens: 96 });
    expect(result.pricingVersion).toBe(PRICING_VERSION);
    // 1842 in at $0.75/1M plus 96 out at $4.50/1M. Computed the long way, so this fails if the
    // table changes without the version changing with it.
    expect(result.costEstimateUsd).toBe((1842 * 0.75 + 96 * 4.5) / 1_000_000);

    // A model nobody priced records `null`, never `0` - an unknown cost must not be
    // indistinguishable from a free one - ADR-11.
    const unpriced = await engine({ model: 'gpt-5.4-imaginary' }).recognise({
      imageId: 'an-id',
      path: imagePath,
    });
    expect(unpriced.engine).toBe('vlm:openai/gpt-5.4-imaginary');
    expect(unpriced.costEstimateUsd).toBeNull();
    // The tokens are still stored: what is unknown is the price, not the usage.
    expect(unpriced.usage).toEqual({ inputTokens: 1842, outputTokens: 96 });
  });

  it('sends one prompt, the whole image, and a strict schema - and no credential from the app', async () => {
    await engine().recognise({ imageId: 'an-id', path: imagePath });

    const content = (
      received?.input as [{ content: { type: string; text?: string; image_url?: string }[] }]
    )[0].content;

    // The one prompt, verbatim. A provider that substituted its own would turn the provider column
    // into a prompt column - phase 09, § Out of scope.
    expect(content.find((part) => part.type === 'input_text')?.text).toBe(PROMPT);

    // The image as stored: no crop, no region hint, no resize. Every engine sees the same bytes.
    const image = content.find((part) => part.type === 'input_image')?.image_url ?? '';
    expect(image.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(Buffer.from(image.split(',')[1] ?? '', 'base64')).toEqual(fs.readFileSync(imagePath));

    // Structured output, enforced - item 6. `strict` off would let the model answer in prose.
    const text = received?.text as { format: { type: string; strict: boolean } };
    expect(text.format.type).toBe('json_schema');
    expect(text.format.strict).toBe(true);

    // The run's record lives in the attempt row, not in a copy retained by the provider.
    expect(received?.store).toBe(false);
  });

  it('records a malformed answer as a failure, keeping what the model actually said', async () => {
    // Structured output makes conformance likely, not certain. Prose where JSON was demanded is the
    // case criterion 7 names: recorded as a failure, with the response retained for inspection.
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(responsesBody({ text: 'I think it expires around December 2027.' }));
    };

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof OcrEngineError &&
        !error.timedOut &&
        error.message.includes('I think it expires around December 2027.'),
    );
  });

  it('refuses a date the model invented the shape of', async () => {
    // `2027-02-30` passes a regex and is not a day. Coercing it - or letting `Date` roll it into
    // March - would file a fabricated date as a reading, which is the one thing a benchmark of
    // date extraction must never do.
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(responsesBody({ text: modelAnswer({ expiryDate: '2027-02-30' }) }));
    };

    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      /did not conform/u,
    );
  });

  it('accepts a null date without turning it into one', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        responsesBody({
          text: modelAnswer({ expiryDate: null, reasoning: 'No year is printed anywhere.' }),
        }),
      );
    };

    const result = await engine().recognise({ imageId: 'an-id', path: imagePath });

    // A model that found no date is a measurement about the model. The raw text it read is still
    // recorded, and the shared parser still runs over it on the phone - which is the comparison.
    expect(result.parsedDate).toBeNull();
    expect(result.rawText).not.toBe('');
  });

  it('separates a refusal, a truncation and a transport failure', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(responsesBody({ refusal: 'I cannot help with that image.' }));
    };
    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      /refused the image/u,
    );

    // Half a transcription is not a shorter reading, it is no reading.
    respond = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
          usage: { input_tokens: 1842, output_tokens: 4000 },
        }),
      );
    };
    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      /stopped early \(max_output_tokens\)/u,
    );

    // A provider error keeps the provider's own sentence: that is the part an operator can act on.
    respond = (_request, response) => {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Rate limit reached', code: 'rate_limit' } }),
      );
    };
    await expect(engine().recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      /HTTP 429: Rate limit reached/u,
    );
  });

  it('times out as a timeout, distinctly from answering badly', async () => {
    // A hung provider must be recorded as "it did not answer inside our limit", never merged with
    // "it answered badly" - the two are different results about the method.
    respond = () => undefined;

    await expect(
      engine({ timeoutMs: 120 }).recognise({ imageId: 'an-id', path: imagePath }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof OcrEngineError && error.timedOut && !error.cancelled,
    );
  });

  it('stops when the caller goes away, and says that is what happened', async () => {
    respond = () => undefined;

    const abandoned = new AbortController();
    setTimeout(() => {
      abandoned.abort();
    }, 40);

    await expect(
      engine().recognise({ imageId: 'an-id', path: imagePath, signal: abandoned.signal }),
    ).rejects.toSatisfy(
      // Not a fact about the model at all. Recording a dropped phone connection as a model failure
      // would put a network event into how often this method fails.
      (error: unknown) => error instanceof OcrEngineError && error.cancelled && !error.timedOut,
    );
  });

  it('fails on the endpoint alone when the credential or the provider name is wrong', async () => {
    await expect(
      engine({ apiKey: '' }).recognise({ imageId: 'an-id', path: imagePath }),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/u);

    // An unregistered VLM_PROVIDER is a bad measurement of one method, not an outage of the
    // harness: the engine still has a well-formed name and the error names the providers that do
    // exist. Nothing here constructs a client or takes the server down.
    const unknown = engine({ provider: 'not-a-provider' });
    expect(unknown.name).toBe('vlm:not-a-provider/gpt-5.4-mini');
    await expect(unknown.recognise({ imageId: 'an-id', path: imagePath })).rejects.toThrow(
      /VLM_PROVIDER="not-a-provider" \(known: openai\)/u,
    );
  });
});
