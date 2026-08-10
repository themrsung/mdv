import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      // Build Output API v3 payload: a copy of `apps/editor/dist`, minified.
      '**/.vercel/**',
      '**/*.d.ts',
      'packages/spec/tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // SPEC 17.3 invariant 1 + SPEC 24.3: @mdv/core is pure. No DOM, no fs, no clock,
    // no randomness. Everything impure arrives through injected Capabilities (SPEC 25.2).
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'SPEC 17.3: @mdv/core must not touch the DOM' },
        { name: 'window', message: 'SPEC 17.3: @mdv/core must not touch the DOM' },
        { name: 'fetch', message: 'SPEC 25.2: use Capabilities.fetch' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'SPEC 24.3: no randomness' },
        { object: 'Date', property: 'now', message: 'SPEC 24.3: now() is config.buildTime' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'os', 'crypto'],
              message: 'SPEC 17.3: no Node built-ins in @mdv/core',
            },
          ],
        },
      ],
    },
  },
  {
    // Repo tooling runs in Node and reports to a terminal, not to a document.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
