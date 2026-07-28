import { defineConfig } from 'tsup';

// Dual output so Metro and Node both resolve this package without either side special-casing
// the other - ADR-14. ESM lands on .js because package.json declares "type": "module".
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
});
