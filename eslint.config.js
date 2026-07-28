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
