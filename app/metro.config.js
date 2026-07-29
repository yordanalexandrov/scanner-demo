// Metro in a pnpm workspace - ADR-14.
//
// `@scanner-demo/shared` lives outside this package and is linked in as a symlink, so Metro has to
// be told two things: watch the workspace root (or an edit to the shared package never triggers a
// reload), and look for modules in the root `node_modules` as well as this package's.
//
// `disableHierarchicalLookup` is deliberately NOT set. Expo's monorepo guide sets it for hoisted
// npm/yarn layouts; under pnpm every transitive dependency resolves through a nested
// `node_modules/.pnpm` path, and disabling the upward lookup breaks exactly that. If resolution
// still proves unreliable, the recorded fallback is `node-linker=hoisted` for this package -
// docs/phases/03-app-shell.md.

const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
