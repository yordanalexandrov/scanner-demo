import { z } from 'zod';
import { MODEL_ANSWER_JSON_SCHEMA, modelAnswerSchema } from './prompt.js';
import { VlmError } from './types.js';
import type { VlmProvider, VlmProviderConfig, VlmResult } from './types.js';

/**
 * OpenAI, through the Responses API, called from the server and only from the server.
 *
 * **The app holds no OpenAI credential and never will** - the repository is public and a key
 * compiled into an APK comes back out with `strings`. The phone sends an image ID over the
 * bearer-token API and the key is read from the environment on this side - spec, § Hard constraint:
 * no secrets in the app.
 *
 * Three deliberate choices, each of which is a measurement decision rather than a preference:
 *
 * - **`fetch` rather than the `openai` SDK.** Nothing here needs streaming, retries, polling or
 *   assistants, and the parts that would be used are one POST and one JSON body. Against that, an
 *   SDK is a dependency on a box with 2 cores and ~2.2 GB shared with production - ADR-18 - and its
 *   own retry policy would quietly turn several calls into one `engineMs`. The sidecar adapter is
 *   built the same way for the same reason, so the two share their timeout and cancellation
 *   semantics instead of each having their own.
 * - **The response is parsed, not cast.** Structured output makes a conforming answer likely, not
 *   certain: a refusal, a truncation or a schema the model ignored all arrive as HTTP 200. Every one
 *   of those becomes a recorded failure carrying the raw response - item 6, criterion 7.
 * - **Image detail is pinned to `high`.** Expiry dates are printed small, and `auto` is a provider
 *   heuristic that can move underneath a stored record. Pinning it means the token count varies with
 *   the image rather than with a policy - which is the variation the phase wants recorded.
 */

const PROVIDER_ID = 'openai';

/** Overridable so a test can point the provider at a local server. Nothing else needs it. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Enough for a densely printed package plus two sentences, and a hard stop on a runaway generation.
 *
 * A response that hits it comes back `status: "incomplete"` and is recorded as a failure rather than
 * as a partial reading - half a transcription scored as a reading would flatter the method.
 */
const MAX_OUTPUT_TOKENS = 4000;

/** How much of a non-conforming answer is kept in the error. Enough to diagnose, not a log flood. */
const RAW_RESPONSE_LIMIT = 2000;

/**
 * The half of the Responses payload this provider reads.
 *
 * Parsed rather than cast for the same reason the Vision adapter parses its protos: the SDK types
 * describe what could arrive rather than what did, and a field that stops arriving should fail here,
 * naming itself, instead of surfacing as `undefined` inside a benchmark record.
 */
const responseSchema = z.object({
  status: z.string().nullish(),
  incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
  output: z
    .array(
      z.object({
        type: z.string(),
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().nullish(),
              /** A refusal is an answer about the request, not a reading. Never parsed as one. */
              refusal: z.string().nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
  /**
   * The token counts the whole cost column rests on - criterion 5. **Required, not optional**: a
   * response with no usage would otherwise become an attempt whose cost is `null` for a reason
   * nobody could distinguish from an unpriced model.
   */
  usage: z.object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
});

/** OpenAI's own error envelope, for the message an operator can actually act on. */
const errorSchema = z.object({
  error: z.object({ message: z.string().nullish(), code: z.string().nullish() }).nullish(),
});

function truncate(text: string): string {
  return text.length <= RAW_RESPONSE_LIMIT ? text : `${text.slice(0, RAW_RESPONSE_LIMIT)}…`;
}

export function createOpenAiProvider(config: VlmProviderConfig): VlmProvider {
  const apiKey = config.env.OPENAI_API_KEY ?? null;
  const baseUrl = (config.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');

  return {
    id: PROVIDER_ID,
    model: config.model,

    async extract(input): Promise<VlmResult> {
      if (apiKey === null || apiKey === '') {
        // Checked here rather than at startup: a missing credential is a recorded attempt with
        // `error` set, not a server that refuses to serve the three methods that do not need it.
        throw new VlmError('OpenAI has no credentials: OPENAI_API_KEY is not set');
      }

      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const signal =
        input.signal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, input.signal]);

      /** Which signal fired decides what the failure *means* - a slow model or a gone client. */
      const failure = (fallback: string, cause: unknown): VlmError => {
        if (timeoutSignal.aborted) {
          return new VlmError(`OpenAI did not answer within ${config.timeoutMs} ms`, {
            timedOut: true,
            cause,
          });
        }
        if (input.signal?.aborted === true) {
          return new VlmError('The caller went away before OpenAI answered', {
            cancelled: true,
            cause,
          });
        }
        return new VlmError(fallback, { cause });
      };

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: config.model,
            input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: input.prompt },
                  {
                    // Base64 inline, because the image never leaves this server for anywhere but
                    // the provider: uploading it somewhere fetchable would put a benchmark
                    // photograph on a public URL to save one round trip.
                    type: 'input_image',
                    image_url: `data:${input.mimeType};base64,${input.image.toString('base64')}`,
                    detail: 'high',
                  },
                ],
              },
            ],
            text: {
              format: {
                type: 'json_schema',
                name: 'expiry_reading',
                schema: MODEL_ANSWER_JSON_SCHEMA,
                // Refused rather than best-effort: a response that does not conform is a failure
                // this benchmark records, not prose it tries to salvage - item 6.
                strict: true,
              },
            },
            max_output_tokens: MAX_OUTPUT_TOKENS,
            // Deliberately not stored on OpenAI's side. The record of this run lives in the
            // attempt row; a copy retained for 30 days by a provider is not part of the harness.
            store: false,
          }),
          signal,
        });
      } catch (error: unknown) {
        throw failure('OpenAI could not be reached', error);
      }

      const body = await response.text().catch((error: unknown) => {
        throw failure('OpenAI answered with a body that could not be read', error);
      });

      if (!response.ok) {
        const parsed = errorSchema.safeParse(safeJson(body));
        const message = parsed.success ? (parsed.data.error?.message ?? null) : null;

        throw new VlmError(
          `OpenAI answered HTTP ${response.status}${message === null ? '' : `: ${message}`}`,
          { rawResponse: truncate(body) },
        );
      }

      const parsed = responseSchema.safeParse(safeJson(body));
      if (!parsed.success) {
        throw new VlmError(
          `OpenAI answered 200 with an unexpected shape: ${z.prettifyError(parsed.error)}`,
          { rawResponse: truncate(body) },
        );
      }

      const { status, incomplete_details: incomplete, output, usage } = parsed.data;

      if (status === 'incomplete') {
        // A transcription cut off at the token limit is not a shorter reading, it is no reading.
        throw new VlmError(`OpenAI stopped early (${incomplete?.reason ?? 'no reason given'})`, {
          rawResponse: truncate(body),
        });
      }

      const content = (output ?? [])
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content ?? []);

      const refusal = content.find((part) => part.type === 'refusal')?.refusal;
      if (refusal !== null && refusal !== undefined) {
        // A refusal is a real result about the method - some packaging photographs will trip a
        // safety filter - so it is recorded as one rather than retried into silence.
        throw new VlmError(`OpenAI refused the image: ${refusal}`, { rawResponse: truncate(body) });
      }

      const text = content.find((part) => part.type === 'output_text')?.text;
      if (text === null || text === undefined || text === '') {
        throw new VlmError('OpenAI answered with no output text', { rawResponse: truncate(body) });
      }

      const answer = modelAnswerSchema.safeParse(safeJson(text));
      if (!answer.success) {
        throw new VlmError(
          `The model's answer did not conform to the schema it was given: ${z.prettifyError(answer.error)}`,
          { rawResponse: truncate(text) },
        );
      }

      return {
        textLines: answer.data.textLines,
        parsedDate: answer.data.expiryDate,
        modelReasoning: answer.data.reasoning,
        // One block per transcribed line, with no geometry. A VLM reports no coordinates and
        // asking it to invent some would fill a measured column with guesses - ADR-4, ADR-5.
        blocks: answer.data.textLines.map((line) => ({
          text: line,
          bbox: null,
          confidence: null,
        })),
        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      };
    },
  };
}

/** `undefined` for anything that is not JSON, so the caller reports the shape rather than a throw. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
