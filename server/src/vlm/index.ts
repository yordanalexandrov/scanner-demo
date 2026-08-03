import { createOpenAiProvider } from './openai.js';
import { VlmError } from './types.js';
import type { VlmProvider, VlmProviderConfig } from './types.js';

/**
 * Provider selection, from one environment variable - phase 09 item 1.
 *
 * **This file is the entire registration surface.** Adding a provider is: write the file, add one
 * line to the table below, add its variables to `server/.env.example`. Nothing in `app/`, in the
 * routes, in the schemas or in the other three engines changes, and `server/src/env.ts` does not
 * either - which is why `VLM_PROVIDER` is a plain string there rather than an enum, and why a
 * provider reads its own credential out of the environment it is handed - see `VlmProviderConfig`.
 * That is criterion 4, and it is checkable with `git diff --name-only`.
 */
const PROVIDERS: Readonly<Record<string, (config: VlmProviderConfig) => VlmProvider>> = {
  openai: createOpenAiProvider,
};

/**
 * The provider named by `VLM_PROVIDER`, or one that fails with a sentence saying why.
 *
 * **An unknown name does not stop the server**, and that is the same rule phase 08 settled for a
 * missing Google key file: the VLM endpoint answers 502, the phone records an attempt with `error`
 * set, and the three methods that have nothing to do with this one keep working. A typo in a
 * deployment variable is a bad measurement of one method, not an outage of the harness.
 *
 * `id` and `model` still come back filled in, so the engine string stays well formed even on this
 * path - a route that answered with a bare `vlm` would break criterion 2 in exactly the case where
 * the record most needs to say what was misconfigured.
 */
export function selectVlmProvider(config: VlmProviderConfig & { provider: string }): VlmProvider {
  const create = PROVIDERS[config.provider];

  if (create === undefined) {
    const known = Object.keys(PROVIDERS).join(', ');

    return {
      id: config.provider,
      model: config.model,
      extract() {
        return Promise.reject(
          new VlmError(
            `No VLM provider is registered under VLM_PROVIDER="${config.provider}" (known: ${known})`,
          ),
        );
      },
    };
  }

  return create(config);
}

export type { VlmProvider, VlmProviderConfig } from './types.js';
