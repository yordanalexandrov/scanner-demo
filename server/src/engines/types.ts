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
 */
export interface OcrEngine {
  /** Doubles as the price-table key and as the `engine` field of every response - ADR-11. */
  readonly name: string;
  recognise(input: { imageId: string; path: string }): Promise<OcrResponse>;
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

  constructor(message: string, options: { timedOut?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'OcrEngineError';
    this.timedOut = options.timedOut ?? false;
  }
}
