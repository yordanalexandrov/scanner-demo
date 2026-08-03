import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { PRICING_VERSION, imageCostUsd, startTimer } from '@scanner-demo/shared';
import type { Block, OcrResponse } from '@scanner-demo/shared';
import { OcrEngineError } from './types.js';
import type { OcrEngine } from './types.js';
import type { ImageAnnotatorClient, protos } from '@google-cloud/vision';

/**
 * Google Cloud Vision, `DOCUMENT_TEXT_DETECTION`, called from the server and only from the server.
 *
 * **The app holds no Google credential and never will.** That is the whole reason this engine lives
 * here: the repository is public and a key compiled into an APK comes back out with `strings`. The
 * phone sends an image ID over the bearer-token API, and the key is read from the environment on
 * this side - spec, § Hard constraint: no secrets in the app.
 *
 * Three things this adapter is deliberate about:
 *
 * - **The model is pinned.** `builtin/stable` rather than the default, recorded in the engine string
 *   as `gcv:builtin/stable`, for the same reason the VLM path records its model: a benchmark record
 *   that says only "GCV" stops being interpretable the moment Google moves the default on.
 * - **`engineMsScope` is `"inference+network"`.** The SDK exposes no way to separate Google's
 *   inference from the round trip to it, and a number labelled `"inference"` here would invite a
 *   comparison with the sidecar's that is not a comparison at all - ADR-10.
 * - **Every image is sent as it is stored.** No cropping, no region hints, no `imageContext`, no
 *   language hints. Every engine sees the same bytes, or the accuracy column measures the tuning
 *   rather than the engine.
 */

/**
 * The model pin. `builtin/stable`, `builtin/latest` and `builtin/weekly` are the values Vision
 * accepts for text detection; this one is the one that does not move underneath a stored record.
 *
 * It is a constant rather than an environment variable on purpose. It is half of {@link ENGINE_NAME},
 * which is also the price-table key, so changing it has to be a code change that adds the matching
 * price entry beside it - ADR-11. An env var would let a deployment silently produce attempts whose
 * cost is unknown.
 */
const GCV_MODEL = 'builtin/stable';

/** The engine string, the price-table key, and what the result view shows - ADR-11. */
const ENGINE_NAME = `gcv:${GCV_MODEL}`;

/**
 * How far outside `[0, 1]` a confidence may stray before it stops being float arithmetic and starts
 * being a broken engine - the same rule, and the same reasoning, as the sidecar adapter's.
 */
const SCORE_EPSILON = 1e-6;

/**
 * One corner of a bounding polygon.
 *
 * **A missing coordinate is zero, not missing.** Protobuf omits default values, so a box that
 * touches the left edge of the image arrives as `{ y: 640 }` with no `x` at all. That is a decoding
 * rule rather than a guess, which is why it is not treated like the absent confidence below.
 */
const vertexSchema = z.object({
  x: z.number().nullish(),
  y: z.number().nullish(),
});

const breakSchema = z.object({
  /**
   * Arrives as the enum's name (`"LINE_BREAK"`) under the default gax configuration, and as its
   * number if that configuration ever changes. Both are accepted because the alternative is silent:
   * an unrecognised break concatenates two words into one, and "EXP12.03.2027" is a word this
   * benchmark's parser would then be scored on.
   */
  type: z.union([z.string(), z.number()]).nullish(),
  /** The break precedes the symbol rather than following it. Rare, and cheap to honour. */
  isPrefix: z.boolean().nullish(),
});

const symbolSchema = z.object({
  text: z.string().nullish(),
  property: z.object({ detectedBreak: breakSchema.nullish() }).nullish(),
});

const wordSchema = z.object({ symbols: z.array(symbolSchema).nullish() });

const paragraphSchema = z.object({ words: z.array(wordSchema).nullish() });

const gcvBlockSchema = z.object({
  boundingBox: z.object({ vertices: z.array(vertexSchema).nullish() }).nullish(),
  paragraphs: z.array(paragraphSchema).nullish(),
  /**
   * Vision reports a confidence at block, paragraph, word and symbol level. **This adapter reads the
   * block one and only the block one** - mixing granularities between images would produce a column
   * that cannot be compared with itself, let alone with another engine. Absent stays `null`, never
   * `1.0` - ADR-5.
   */
  confidence: z
    .number()
    .min(-SCORE_EPSILON)
    .max(1 + SCORE_EPSILON)
    .nullish(),
});

const pageSchema = z.object({
  blocks: z.array(gcvBlockSchema).nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

/**
 * The half of `AnnotateImageResponse` this engine reads, parsed rather than cast.
 *
 * The SDK's own types are generated from the protos and make every field optional and nullable, so
 * they describe what could arrive rather than what did. Parsing here means a response that stops
 * matching fails at the boundary, naming the field, instead of surfacing as `undefined` inside a
 * benchmark record - the same reasoning as the sidecar adapter's schema.
 */
const annotateResponseSchema = z.object({
  fullTextAnnotation: z
    .object({
      text: z.string().nullish(),
      pages: z.array(pageSchema).nullish(),
    })
    .nullish(),
  /**
   * A per-image failure inside an otherwise successful RPC - "Bad image data", "Image too large".
   * The transport succeeded, so nothing throws; recording it as a successful recognition of zero
   * blocks would file an error as a measurement.
   */
  error: z.object({ code: z.number().nullish(), message: z.string().nullish() }).nullish(),
});

/**
 * What each break type contributes to the assembled text.
 *
 * `HYPHEN` marks an end-of-line hyphen that Vision does **not** include in the symbols. Rendering it
 * as `-` would put a separator character into a date-parsing benchmark that the recogniser never
 * reported, so the line break alone is what this records - the same rule as the absent confidence:
 * do not invent what the engine did not say.
 */
const BREAK_TEXT: Readonly<Record<string, string>> = {
  UNKNOWN: '',
  SPACE: ' ',
  SURE_SPACE: ' ',
  EOL_SURE_SPACE: '\n',
  HYPHEN: '\n',
  LINE_BREAK: '\n',
};

/** The proto's declaration order, for the case where the enum arrives as its number. */
const BREAK_NAMES = [
  'UNKNOWN',
  'SPACE',
  'SURE_SPACE',
  'EOL_SURE_SPACE',
  'HYPHEN',
  'LINE_BREAK',
] as const;

function breakText(detected: z.infer<typeof breakSchema> | null | undefined): string {
  const type = detected?.type;

  if (type === null || type === undefined) {
    return '';
  }

  const name = typeof type === 'number' ? BREAK_NAMES[type] : type;

  return (name === undefined ? undefined : BREAK_TEXT[name]) ?? '';
}

/**
 * The axis-aligned box of a bounding polygon, as `[x, y, width, height]` in pixels - ADR-5.
 *
 * Vision's polygon is four vertices and is usually already axis-aligned, but it is a polygon in the
 * contract and a rotated one on rotated packaging. Taking its extent is the same conversion the
 * sidecar adapter makes, so a box means the same thing in both columns.
 */
function boundingBox(
  vertices: readonly z.infer<typeof vertexSchema>[],
): [number, number, number, number] | null {
  if (vertices.length === 0) {
    return null;
  }

  const xs = vertices.map((vertex) => vertex.x ?? 0);
  const ys = vertices.map((vertex) => vertex.y ?? 0);

  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

/** A reported dimension, or `undefined` when the field is absent or a protobuf default. */
function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/** Trims a rounding artefact back onto `[0, 1]`; anything further out never reaches here. */
function confidenceOf(score: number | null | undefined): number | null {
  // Absent is `null`, never `1.0` - substituting a number would record certainty Vision never
  // claimed, and would do it on exactly the blocks it was least sure about - ADR-5.
  return score === null || score === undefined ? null : Math.min(1, Math.max(0, score));
}

/**
 * One `Block` per Vision block, with its text assembled from the symbols underneath it.
 *
 * Vision returns a tree - page, block, paragraph, word, symbol - and no text at any level except the
 * whole-image string. Block level is the granularity ML Kit's wrapper reports, so it is the
 * granularity the parser sees from both, and the anchor-proximity rules mean the same thing on
 * either path.
 */
function toBlock(block: z.infer<typeof gcvBlockSchema>): Block {
  let text = '';

  for (const paragraph of block.paragraphs ?? []) {
    for (const word of paragraph.words ?? []) {
      for (const symbol of word.symbols ?? []) {
        const detected = breakText(symbol.property?.detectedBreak);
        const prefix = symbol.property?.detectedBreak?.isPrefix === true;

        text += prefix ? detected + (symbol.text ?? '') : (symbol.text ?? '') + detected;
      }
    }
  }

  return {
    // The break after the last symbol of a block is a line break belonging to the layout, not to the
    // text. ML Kit's blocks carry no trailing newline either, and the two have to be comparable.
    text: text.replace(/\s+$/u, ''),
    bbox: boundingBox(block.boundingBox?.vertices ?? []),
    confidence: confidenceOf(block.confidence),
  };
}

/**
 * The one call this engine makes, behind a function so a test can stand in front of it.
 *
 * The seam is at the SDK rather than at the socket, unlike the sidecar's tests. What is on this side
 * of it is everything this file is responsible for - the request it builds, the geometry and text it
 * maps, the failures it classifies - and what is on the other side is gRPC, protobuf and Google's
 * own client, which testing here would only prove is still Google's. The response fixtures are built
 * from the documented `AnnotateImageResponse` shape; the acceptance run against the real API with
 * real credentials is what confirms they match it.
 */
export type AnnotateImage = (
  request: protos.google.cloud.vision.v1.IAnnotateImageRequest,
  options: { timeout: number },
) => Promise<protos.google.cloud.vision.v1.IAnnotateImageResponse>;

export interface GcvOptions {
  /**
   * Hard limit on the whole call, passed to the SDK as its own deadline.
   *
   * gax turns this into the total timeout across the transient retries it performs on
   * `UNAVAILABLE` and `DEADLINE_EXCEEDED`, so the endpoint cannot outlive it. **A retried call is
   * one `engineMs`**, backoff included - which is what `"inference+network"` already says, and what
   * the README says next to the figure.
   */
  timeoutMs: number;
  /**
   * The service-account key file, and **the only credential source this engine accepts** - see
   * {@link realAnnotate} for the measured reason. `null` means the endpoint fails with a clear
   * message rather than searching for one.
   */
  credentialsPath?: string | null;
  /** Test seam. The process uses the real client. */
  annotate?: AnnotateImage;
}

/**
 * Builds the real Vision client, once, on first use.
 *
 * **Lazily, and that is not premature.** The package pulls in five API versions and a megabyte of
 * protobuf descriptors; a box with two cores shared with production - ADR-18 - should not pay that
 * at boot for an engine that a given session may never call.
 *
 * **The credentials are checked here, before the SDK is touched, because the SDK cannot be trusted
 * to fail politely.** Measured against `@google-cloud/vision` 5.3.7 on Node 22: a missing key file
 * and an absent Application Default Credential each reject the call *and* leave a second, floating
 * rejection behind - `ENOENT` in the first case, "Could not load the default credentials" in the
 * second. Node's default for an unhandled rejection is to throw, so the server would answer the
 * request and then die, which is the one thing phase 08 criterion 6 forbids. A key file whose
 * *contents* are wrong does not do this: it rejects once, normally, and is left to the SDK.
 *
 * The cost of the guard is that Application Default Credentials from anywhere else - a GCE metadata
 * server, a `gcloud` login - are not supported. This runs on a Hetzner box with a mounted key file
 * and nothing else, so what is given up is a path this deployment cannot take anyway.
 */
function realAnnotate(credentialsPath: string | null): AnnotateImage {
  let pending: Promise<ImageAnnotatorClient> | null = null;

  async function client(): Promise<ImageAnnotatorClient> {
    if (credentialsPath === null) {
      throw new OcrEngineError(
        'Cloud Vision has no credentials: GOOGLE_APPLICATION_CREDENTIALS is not set',
      );
    }

    try {
      // Re-checked on every call rather than once: a key file that arrives after the server started
      // should work on the next request instead of on the next restart.
      await fs.access(credentialsPath, fsConstants.R_OK);
    } catch (error: unknown) {
      throw new OcrEngineError(`Cloud Vision cannot read its key file at ${credentialsPath}`, {
        cause: error,
      });
    }

    if (pending === null) {
      pending = import('@google-cloud/vision').then(
        (vision) => new vision.ImageAnnotatorClient({ keyFilename: credentialsPath }),
      );
    }

    try {
      return await pending;
    } catch (error: unknown) {
      // A failed construction is not remembered either, for the same reason.
      pending = null;
      throw error;
    }
  }

  return async (request, options) => {
    // `batchAnnotateImages` with exactly one request - which is precisely what the SDK's
    // `annotateImage` helper does internally, and **not** the batch or async APIs phase 08 puts out
    // of scope. The helper is bypassed only because its type signature accepts no call options, and
    // the explicit timeout is not the part worth giving up for a tidier call.
    const [response] = await (
      await client()
    ).batchAnnotateImages({ requests: [request] }, { timeout: options.timeout });

    const first = response.responses?.[0];

    if (first === undefined || first === null) {
      throw new OcrEngineError('Cloud Vision answered with no annotation for the image');
    }

    return first;
  };
}

/**
 * Names the failure, so the attempt row says something a reader can act on.
 *
 * A timeout is separated from everything else because the two are different results about the
 * engine - "it did not answer inside our limit" against "it answered badly" - and a benchmark that
 * merged them would hide the more interesting one. Credential failures are named explicitly because
 * they are the one failure mode that is certainly ours and not Google's.
 */
function classify(error: unknown, timeoutMs: number): OcrEngineError {
  if (error instanceof OcrEngineError) {
    return error;
  }

  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);

  // gRPC DEADLINE_EXCEEDED. gax also reports its own total-timeout expiry with this code, which is
  // the same fact about the call from one layer up.
  if (code === 4) {
    return new OcrEngineError(`Cloud Vision did not answer within ${timeoutMs} ms`, {
      timedOut: true,
      cause: error,
    });
  }

  // UNAUTHENTICATED, plus the auth library's own failures, which arrive with an unrelated code or
  // none at all: a key file whose contents are malformed surfaces as
  // `2 UNKNOWN: Getting metadata from plugin failed…`, which is a credential problem wearing a
  // transport error's clothes. Measured, not guessed - see the note in `realAnnotate`.
  if (
    code === 16 ||
    /credential|ENOENT|invalid_grant|API key|metadata from plugin/iu.test(message)
  ) {
    return new OcrEngineError(`Cloud Vision rejected the credentials: ${message}`, {
      cause: error,
    });
  }

  // PERMISSION_DENIED is **not** the same fact as a bad key, and calling it one would file the wrong
  // reason in the attempt row. It also covers billing being off on the project, the API not being
  // enabled, and a key belonging to a different project - all of which the first run against the
  // real API on 2026-08-03 produced: "This API method requires billing to be enabled". So the code
  // is named and Google's own sentence is kept verbatim, which is the part an operator can act on.
  if (code === 7) {
    return new OcrEngineError(`Cloud Vision refused the call (PERMISSION_DENIED): ${message}`, {
      cause: error,
    });
  }

  return new OcrEngineError(`Cloud Vision failed: ${message}`, { cause: error });
}

export function createGcvEngine(options: GcvOptions): OcrEngine {
  const annotate = options.annotate ?? realAnnotate(options.credentialsPath ?? null);

  return {
    name: ENGINE_NAME,
    /**
     * **`input.signal` is ignored, deliberately.** The interface makes it optional so an engine that
     * cannot cancel says so rather than pretending, and this one cannot: the SDK's promise exposes
     * no cancellation, and there would be little to reclaim if it did. The sidecar honours it
     * because an abandoned inference holds one of the box's two cores and inflates the next
     * request's `engineMs`; an abandoned call to Google occupies a socket. Google bills a completed
     * annotation either way, so dropping it early would not even save the cost.
     */
    async recognise(input) {
      const bytes = await fs.readFile(input.path);

      // The header only - `sharp` does not decode the pixels for this. It is the fallback for the
      // dimensions; Vision's own page size wins where it reports one, see below.
      const metadata = await sharp(bytes).metadata();

      const request: protos.google.cloud.vision.v1.IAnnotateImageRequest = {
        // Base64, which is what the SDK's own helper produces for a buffer, and what the REST
        // transport requires if this client is ever built in fallback mode.
        image: { content: bytes.toString('base64') },
        // The pinned model travels with the feature. No `imageContext`: no language hints, no crop
        // hints, nothing tuned for this engine - every engine sees the same bytes.
        features: [{ type: 'DOCUMENT_TEXT_DETECTION', model: GCV_MODEL }],
      };

      const stopEngineTimer = startTimer();

      let raw: protos.google.cloud.vision.v1.IAnnotateImageResponse;
      try {
        raw = await annotate(request, { timeout: options.timeoutMs });
      } catch (error: unknown) {
        throw classify(error, options.timeoutMs);
      }

      // Stopped once the answer is in hand and before it is picked apart: the measurement is the
      // cost of the call, not of this file's mapping.
      const engineMs = stopEngineTimer();

      const parsed = annotateResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new OcrEngineError(
          `Cloud Vision answered with an unexpected shape: ${z.prettifyError(parsed.error)}`,
        );
      }

      const { fullTextAnnotation, error } = parsed.data;

      if (error !== null && error !== undefined) {
        throw new OcrEngineError(
          `Cloud Vision could not process the image: ${error.message ?? 'no reason given'} (code ${error.code ?? 'none'})`,
        );
      }

      const pages = fullTextAnnotation?.pages ?? [];
      const blocks: Block[] = pages.flatMap((page) => (page.blocks ?? []).map(toBlock));

      /**
       * Vision's own page dimensions where it reports them, `sharp`'s where it does not.
       *
       * ADR-5 fixes `bbox` in pixels of **the image the engine actually processed**, and these two
       * disagree exactly when Vision rotates an image its EXIF says is rotated. Reporting the
       * stored dimensions then would leave every box unnormalisable against the picture it came
       * from. A photograph is one page; the first is the one the boxes belong to.
       *
       * A zero falls back too, rather than being recorded: protobuf omits a default, so `0` here
       * means "not reported" in every case that matters, and an image is never zero pixels wide.
       */
      const page = pages[0];
      const imageWidth = positive(page?.width) ?? metadata.width;
      const imageHeight = positive(page?.height) ?? metadata.height;

      return {
        engine: ENGINE_NAME,
        // Vision's own joined string, verbatim, exactly as ML Kit's `rawText` is its own. An empty
        // one with no blocks is a legitimate answer: an engine that read nothing is a measurement.
        rawText: fullTextAnnotation?.text ?? '',
        blocks,
        engineMs,
        // The SDK cannot separate Google's inference from the trip to it, and pretending otherwise
        // would make this figure look comparable with the sidecar's when it is not - ADR-10.
        engineMsScope: 'inference+network',
        // Only the handler can measure its own wall time, so the route fills this in - ADR-10.
        serverTotalMs: null,
        imageWidth,
        imageHeight,
        // No tokens are involved. `null` is "not applicable here", not "not measured".
        usage: null,
        // One image is one billable unit, read from the shared table rather than written here, so
        // the one place a price can be wrong stays the one place it is defined - ADR-11.
        costEstimateUsd: imageCostUsd(ENGINE_NAME),
        pricingVersion: PRICING_VERSION,
      } satisfies OcrResponse;
    },
  };
}
