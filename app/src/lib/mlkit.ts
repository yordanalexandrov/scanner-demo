import TextRecognition from '@react-native-ml-kit/text-recognition';
import { PRICING_VERSION, pricing, startTimer } from '@scanner-demo/shared';
import type { Block, OcrResponse } from '@scanner-demo/shared';

/**
 * The on-device engine, adapted to the one `OcrResponse` shape every engine returns.
 *
 * The adapter is the whole point: an accuracy difference between ML Kit and a server engine has to
 * be attributable to the recognition, so everything downstream of this function - the parser, the
 * scoring, the export - sees the same structure whichever engine produced it.
 *
 * **The wrapper reports no confidence.** Verified against
 * `@react-native-ml-kit/text-recognition@2.0.0`, whose `TextBlock` carries `text`, `frame`, `lines`
 * and `recognizedLanguages` and nothing else. Every block therefore gets `confidence: null`, never
 * `1.0` - substituting a number would make this path look maximally certain about every block it
 * ever emitted and would corrupt every confidence comparison in the benchmark - ADR-5.
 */

export const MLKIT_ENGINE = 'mlkit';

export interface RecogniseOptions {
  /** Dimensions of the image being read, so boxes can be normalised afterwards - ADR-5. */
  imageWidth: number;
  imageHeight: number;
}

export async function recogniseWithMlKit(
  uri: string,
  options: RecogniseOptions,
): Promise<OcrResponse> {
  const done = startTimer();
  const result = await TextRecognition.recognize(uri);
  const engineMs = done();

  const blocks: Block[] = result.blocks.map((block) => ({
    text: block.text,
    // ML Kit's frame is `{ left, top, width, height }`; the shared contract is
    // `[x, y, width, height]` in pixels of the processed image, origin top-left - ADR-5.
    bbox:
      block.frame === undefined
        ? null
        : [block.frame.left, block.frame.top, block.frame.width, block.frame.height],
    confidence: null,
  }));

  return {
    engine: MLKIT_ENGINE,
    // Verbatim, line breaks included. The result view shows exactly this - criterion 12.
    rawText: result.text,
    blocks,
    engineMs,
    // The recognition call is the whole of it: no network, nothing else inside the number - ADR-10.
    engineMsScope: 'inference',
    serverTotalMs: null,
    imageWidth: options.imageWidth,
    imageHeight: options.imageHeight,
    usage: null,
    // Read from the shared table rather than written as a literal, so the on-device zero means "the
    // table says on-device runs are free" and not "somebody typed 0 here" - ADR-11.
    costEstimateUsd: pricing[MLKIT_ENGINE]?.usd ?? null,
    pricingVersion: PRICING_VERSION,
  };
}
