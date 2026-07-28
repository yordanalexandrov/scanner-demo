import { createRequire } from 'node:module';

/**
 * The version `/health` reports.
 *
 * Read from `package.json` at runtime rather than inlined at build time, so a deployed container
 * cannot claim a version that its own manifest disagrees with. `createRequire` is used because a
 * JSON import attribute would tie this file to a different module resolution mode than the rest of
 * the repository. The relative path holds for both `src/` and the mirrored `dist/` layout.
 */
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const SERVER_VERSION: string = pkg.version;
