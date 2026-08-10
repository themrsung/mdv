import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Workspace packages, in dependency order. Keep in sync with the `paths` block in
 * `tsconfig.base.json` — the two together are the "no build step" contract: every
 * package imports every other package by its published name and resolves to source.
 */
const WORKSPACE_PACKAGES = [
  'spec',
  'parser',
  'core',
  'charts',
  'render-svg',
  'render-pdf',
  'themes',
  'react',
  'cli',
] as const;

/**
 * Vite alias entries. The deep-import entry (`@mdv/core/types/scene`) must come
 * before the bare entry (`@mdv/core`) because Vite tests aliases in order.
 */
const alias = WORKSPACE_PACKAGES.flatMap((pkg) => [
  {
    find: new RegExp(`^@mdv/${pkg}/(.*)$`),
    replacement: resolve(root, `packages/${pkg}/src/$1`),
  },
  {
    find: new RegExp(`^@mdv/${pkg}$`),
    replacement: resolve(root, `packages/${pkg}/src/index.ts`),
  },
]);

export default defineConfig({
  resolve: { alias },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.tsx',
      'packages/*/src/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'packages/spec/tests/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: resolve(root, 'coverage'),
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/types/**'],
    },
  },
});
