import type { Block, Usage } from '@scanner-demo/shared';

/**
 * The swap point - phase 09 item 1.
 *
 * The whole reason this layer exists is that benchmarking a second provider later must be **adding
 * one file and changing one environment variable**, not editing the route, the schemas, the app or
 * the other three engines. Everything provider-shaped is therefore on this side of the interface:
 * the HTTP call, the request body, the way structured output is requested, the way usage is
 * reported. Everything measurement-shaped is on the other side, in `engines/vlm.ts`, so two
 * providers cannot end up with two definitions of what `engineMs` covers.
 *
 * What is deliberately **not** here: the prompt. It lives in `prompt.ts`, once, because every image
 * gets the same prompt or the comparison is not a comparison - and so does every provider, or the
 * provider column would be measuring the prompt.
 */
export interface VlmProvider {
  /** e.g. `"openai"`. Half of the engine string `vlm:<id>/<model>`, which is the price key. */
  readonly id: string;
  /** The concrete model, never a family or an alias. Model versions move; stored records must not. */
  readonly model: string;
  extract(input: VlmInput): Promise<VlmResult>;
}

export interface VlmInput {
  /** The image exactly as it is stored. No cropping, no hints - every engine sees the same bytes. */
  readonly image: Buffer;
  /** `image/jpeg`, `image/png`, … - needed for the data URL the providers send. */
  readonly mimeType: string;
  /** The one prompt, passed in rather than reached for, so a provider cannot substitute its own. */
  readonly prompt: string;
  /** Aborts the call when the phone hangs up. Optional for the reason it is on `OcrEngine`. */
  readonly signal?: AbortSignal;
}

export interface VlmResult {
  /** What the model says it read, as separate lines in reading order - see `prompt.ts`. */
  readonly textLines: readonly string[];
  /** The model's own structured answer, ISO `yyyy-mm-dd`, or `null`. Never a guess. */
  readonly parsedDate: string | null;
  readonly modelReasoning: string;
  /**
   * Usually `bbox: null` - a VLM reports no geometry, and inventing one would put fabricated
   * coordinates into the column ML Kit and Vision fill with measured ones - ADR-4, ADR-5.
   */
  readonly blocks: readonly Block[];
  /** Real token counts from the provider, persisted so the cost can be re-derived - criterion 5. */
  readonly usage: Usage;
}

/**
 * What a provider needs to exist, and nothing about the engine it will be adapted to.
 *
 * **`env` is passed rather than read, and that is what makes criterion 4 true.** A second provider
 * needs its own credential variable; if those had to be declared in `server/src/env.ts`, adding a
 * provider would be a two-file change and the interface would not be the swap point it claims to
 * be. So the process environment arrives here and each provider reads the variable it owns. This is
 * the one place the repository's "the environment is validated once at startup" rule is relaxed,
 * and the trade is deliberate: a missing provider credential must be a recorded attempt with
 * `error` set rather than a server that refuses to start - the same rule phase 08 settled for
 * Google's key file.
 */
export interface VlmProviderConfig {
  readonly model: string;
  readonly timeoutMs: number;
  readonly env: Readonly<Partial<Record<string, string>>>;
}

/**
 * A failure of the provider, in the provider's own vocabulary.
 *
 * It is a separate type from `OcrEngineError` on purpose: this layer knows nothing about OCR
 * endpoints, 502s or `engineMs`, and `engines/vlm.ts` is what turns one into the other. A provider
 * added later therefore cannot get the HTTP mapping subtly wrong - it does not do the mapping.
 */
export class VlmError extends Error {
  /** Did not answer inside the configured limit. A different fact from answering badly. */
  readonly timedOut: boolean;
  /** The caller went away. Not a fact about the model at all, so it is not recorded as one. */
  readonly cancelled: boolean;
  /**
   * The model's answer as it arrived, kept when it failed to conform - phase 09 criterion 7.
   *
   * A malformed response is a **recorded failure with the response retained**, never a best-effort
   * parse of prose. The text lands in the attempt's `error`, which is where an operator looking at
   * a row that failed will actually look.
   */
  readonly rawResponse: string | null;

  constructor(
    message: string,
    options: {
      timedOut?: boolean;
      cancelled?: boolean;
      rawResponse?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'VlmError';
    this.timedOut = options.timedOut ?? false;
    this.cancelled = options.cancelled ?? false;
    this.rawResponse = options.rawResponse ?? null;
  }
}
