import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { elapsed, now } from '@scanner-demo/shared';
import type { Millis } from '@scanner-demo/shared';
import type { OcrEngine } from '../engines/types.js';

/**
 * One inference over a dummy image at startup, so the first real request is not a model load.
 *
 * The measured penalty it removes is large: 3.4-3.9 s cold against a 1.85 s warm median on the
 * deployment box - docs/spikes/07-ocr-sidecar.md § 4. Without this, the first `engineMs` of every
 * deploy is roughly twice the truth and lands in whatever average happens to include it.
 *
 * **A warm-up only warms the size it used.** The spike found cold start is per input size as well as
 * per process: on a container already warm on 1200x1600, the first 3000x4000 image took 6.50 s and
 * the next four took 3.16-3.46 s. So the dummy is the size the app actually uploads - the downscaled
 * upload variant - and a re-run over an archived original still pays a one-off cost that no warm-up
 * here removes. The README says so next to the figure rather than leaving it to be discovered.
 */

/** The upload variant's long edge, as phase 05 produces it. */
const WARMUP_WIDTH = 1200;
const WARMUP_HEIGHT = 1600;

export interface WarmupOptions {
  engine: OcrEngine;
  /** The sidecar loads its models in about five seconds, and the server is ready before that. */
  attempts?: number;
  delayMs?: number;
}

export interface WarmupResult {
  ok: boolean;
  /** How long the successful call took - the cold-start figure the README reports. */
  ms: Millis | null;
  attempts: number;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one dummy inference, retrying while the sidecar is still loading.
 *
 * It never throws. A benchmark server that refused to start because its optional warm-up failed
 * would be trading a slow first measurement for no measurements at all; the failure is logged and
 * the first real request pays the cold cost instead.
 */
export async function warmUpEngine(options: WarmupOptions): Promise<WarmupResult> {
  const { engine, attempts = 5, delayMs = 3_000 } = options;

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-demo-warmup-'));
  const file = path.join(directory, 'warmup.jpg');

  try {
    // Flat grey with no text in it. The point is to make ONNX Runtime build its sessions and
    // allocate its arenas, which detection does whether or not it finds anything.
    await sharp({
      create: {
        width: WARMUP_WIDTH,
        height: WARMUP_HEIGHT,
        channels: 3,
        background: { r: 210, g: 210, b: 210 },
      },
    })
      .jpeg()
      .toFile(file);

    let lastError = 'The warm-up never ran';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = now();

      try {
        await engine.recognise({ imageId: 'warmup', path: file });
        return { ok: true, ms: elapsed(startedAt), attempts: attempt, error: null };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : 'The warm-up failed';

        if (attempt < attempts) {
          await sleep(delayMs);
        }
      }
    }

    return { ok: false, ms: null, attempts, error: lastError };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
