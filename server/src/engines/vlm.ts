import fs from 'node:fs/promises';
import sharp from 'sharp';
import { PRICING_VERSION, startTimer, tokenCostUsd } from '@scanner-demo/shared';
import type { VlmOcrResponse } from '@scanner-demo/shared';
import { PROMPT, PROMPT_VERSION } from '../vlm/prompt.js';
import { VlmError } from '../vlm/types.js';
import type { VlmProvider } from '../vlm/types.js';
import { OcrEngineError } from './types.js';
import type { OcrEngine } from './types.js';

/**
 * Adapts a {@link VlmProvider} to the one `OcrEngine` interface all four methods are measured
 * through - phase 09, `server/src/engines/vlm.ts`.
 *
 * **Everything that makes a number comparable lives here rather than in the providers.** Where
 * `engineMs` starts and stops, what `engineMsScope` claims, how the cost is derived, how a failure
 * is classified: one definition, so a second provider added later cannot arrive with its own. What
 * is on the other side of the interface is the call itself, which is the only part that genuinely
 * differs.
 *
 * This is also the one engine whose response carries more than an `OcrResponse`. The model's own
 * answer and the prompt that produced it ride along, because the app is the sole author of attempt
 * rows and cannot record either unless the server says so - ADR-15, ADR-24.
 */

export interface VlmEngineOptions {
  provider: VlmProvider;
}

/**
 * Names the failure so the attempt row says something a reader can act on.
 *
 * The raw response is appended when there is one, because a malformed answer is only diagnosable
 * with the answer in hand - criterion 7. It is the provider that decides whether an answer was
 * malformed and this file that decides where the text ends up, which is the same split as
 * everything else here.
 */
function classify(error: unknown): OcrEngineError {
  if (error instanceof OcrEngineError) {
    return error;
  }

  if (error instanceof VlmError) {
    return new OcrEngineError(
      error.rawResponse === null
        ? error.message
        : `${error.message} - answered: ${error.rawResponse}`,
      { timedOut: error.timedOut, cancelled: error.cancelled, cause: error },
    );
  }

  return new OcrEngineError(
    `The VLM failed: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

export function createVlmEngine(options: VlmEngineOptions): OcrEngine<VlmOcrResponse> {
  const { provider } = options;

  /**
   * `vlm:<provider>/<model>`, never a bare `vlm` - criterion 2, and the price-table key - ADR-11.
   *
   * Model versions change and old benchmark records must stay interpretable, so the concrete model
   * is part of the string rather than something a reader has to infer from a timestamp. Changing
   * `VLM_MODEL` therefore produces attempts under a different key, and the earlier rows keep saying
   * which model produced them - criterion 9.
   */
  const engineName = `vlm:${provider.id}/${provider.model}`;

  return {
    name: engineName,

    async recognise(input) {
      const bytes = await fs.readFile(input.path);

      // The header only - `sharp` does not decode the pixels for this. These are the dimensions of
      // the image as stored, which is what the provider was sent.
      const metadata = await sharp(bytes).metadata();

      const stopEngineTimer = startTimer();

      let result;
      try {
        result = await provider.extract({
          image: bytes,
          mimeType: `image/${metadata.format ?? 'jpeg'}`,
          // The one prompt, handed to the provider rather than reached for by it, so no provider
          // can substitute its own and turn the provider column into a prompt column.
          prompt: PROMPT,
          signal: input.signal,
        });
      } catch (error: unknown) {
        throw classify(error);
      }

      // Stopped once the answer is in hand and before it is picked apart: the measurement is the
      // cost of the call, not of this file's mapping.
      const engineMs = stopEngineTimer();

      const usage = result.usage;

      return {
        engine: engineName,
        // The lines joined, and the blocks are the same lines split. One transcription, two views
        // of it, so `rawText` and `blocks` cannot disagree about what the model read - see
        // `vlm/prompt.ts` for why the model is asked for lines rather than for both.
        rawText: result.textLines.join('\n'),
        blocks: [...result.blocks],
        engineMs,
        // There is no way to separate the model's inference from the round trip to it, and a figure
        // labelled `"inference"` here would invite a comparison with the sidecar's that is not one
        // - ADR-10.
        engineMsScope: 'inference+network',
        // Only the handler can measure its own wall time, so the route fills this in - ADR-10.
        serverTotalMs: null,
        imageWidth: metadata.width,
        imageHeight: metadata.height,
        // Persisted, so the cost figure in an export can be re-derived and audited rather than
        // merely believed - criterion 5.
        usage,
        // Computed from the tokens this call actually reported, against the shared table - never a
        // flat per-image guess. An unpriced model yields `null`, which is not `0` - ADR-11.
        costEstimateUsd: tokenCostUsd(engineName, usage),
        pricingVersion: PRICING_VERSION,
        // The model's own structured answer, recorded beside - not instead of - the shared parser's
        // reading of the same raw text. That difference is the point of this method - item 4.
        parsedDate: result.parsedDate,
        modelReasoning: result.modelReasoning,
        // The prompt that produced all of the above. The phone stores it on the attempt; it cannot
        // know it otherwise - ADR-24.
        promptVersion: PROMPT_VERSION,
      } satisfies VlmOcrResponse;
    },
  };
}
