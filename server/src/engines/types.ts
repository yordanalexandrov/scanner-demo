import type { OcrResponse } from '@scanner-demo/shared';

/**
 * One recognition engine, behind one interface - phases 07, 08 and 09 each add an implementation.
 *
 * The interface is deliberately narrow. It takes an image ID and a path the **server** constructed,
 * never anything a client sent, and it returns the shared `OcrResponse` rather than an engine-shaped
 * result that something downstream would have to normalise. That is what keeps the comparison valid:
 * the parser sees the same shape from every engine, so an accuracy difference is attributable to the
 * OCR and not to four different adapters each interpreting their own output.
 *
 * It is also what makes the in-process migration the specification leaves open - a TypeScript ONNX
 * wrapper instead of a container - a one-file change rather than a rewrite.
 *
 * `TResponse` widens the *result*, never the contract: it must extend `OcrResponse`, so every field
 * the comparison rests on is present on every engine. Phase 09 is the one user of it - the VLM
 * returns its own answer and its prompt version alongside, and both have to survive serialisation,
 * which is why each endpoint declares the schema its engine actually returns - ADR-24.
 */
export interface OcrEngine<TResponse extends OcrResponse = OcrResponse> {
  /** Doubles as the price-table key and as the `engine` field of every response - ADR-11. */
  readonly name: string;
  recognise(input: {
    imageId: string;
    path: string;
    /**
     * Aborts the recognition when the caller is no longer there to receive it.
     *
     * **Added to the interface the phase document sketches, on purpose.** The box has two cores
     * shared with production - ADR-18 - and an inference nobody is waiting for still occupies one
     * of them; worse, it delays the request that replaced it and inflates *that* measurement.
     * Optional, so an engine that cannot cancel simply ignores it rather than pretending.
     */
    signal?: AbortSignal;
  }): Promise<TResponse>;
}

/**
 * A failure of the engine itself, as opposed to a failure of the request that reached it.
 *
 * `timedOut` is separated from every other failure because the two are different results about the
 * engine: one says it answered badly, the other says it did not answer inside a limit this server
 * chose. A benchmark that recorded them as the same thing would be hiding the more interesting one.
 */
export class OcrEngineError extends Error {
  readonly timedOut: boolean;
  /**
   * The caller abandoned the request. Not a fact about the engine at all, which is why it is
   * separated: logging a dropped phone connection as an engine failure would put a network event
   * into the record of how often this engine fails.
   */
  readonly cancelled: boolean;

  constructor(
    message: string,
    options: { timedOut?: boolean; cancelled?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'OcrEngineError';
    this.timedOut = options.timedOut ?? false;
    this.cancelled = options.cancelled ?? false;
  }
}
