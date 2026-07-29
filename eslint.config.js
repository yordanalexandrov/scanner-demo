import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      'app/android/**',
      'app/ios/**',
      '.husky/_/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Metro's config is loaded by Node, in CommonJS, before any bundling happens - it cannot be an
    // ES module. Declaring the globals here rather than installing `globals` keeps the exception as
    // small as the one file that needs it.
    files: ['**/metro.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { __dirname: 'readonly', module: 'writable', require: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    rules: {
      // Durations must come from packages/shared/src/timing.ts. Date.now() is for wall-clock
      // timestamps that get ordered, never subtracted - ADR-10, global constraint.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            'Do not use Date.now() for durations. Use now()/elapsed() from @scanner-demo/shared (ADR-10). For a wall-clock timestamp field, add an eslint-disable with a reason.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);
