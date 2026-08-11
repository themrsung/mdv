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
  'lsp',
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

/**
 * The extension host's own modules, doubled (SPEC 29).
 *
 * `vscode` is supplied by the running host and `vscode-languageclient` forks a
 * process or a worker the moment it starts; neither exists under vitest. The
 * doubles in `apps/vscode/test/double` stand in for both. `tsc` still resolves
 * the real declarations, so only the runtime is swapped, and nothing outside
 * `apps/vscode` imports either specifier.
 */
const hostAlias = [
  { find: /^vscode$/, module: 'vscode' },
  { find: /^vscode-languageclient\/node$/, module: 'languageclient-node' },
  { find: /^vscode-languageclient\/browser$/, module: 'languageclient-browser' },
].map(({ find, module }) => ({
  find,
  replacement: resolve(root, `apps/vscode/test/double/${module}.ts`),
}));

export default defineConfig({
  resolve: { alias: [...alias, ...hostAlias] },
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.tsx',
      'packages/*/src/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
      // The editor's tests live beside the modules they specify, not in a
      // top-level `test/` dir. Without these two globs the whole of
      // `apps/editor` (530 tests) is silently absent from the root run.
      'apps/*/src/**/__tests__/**/*.test.ts',
      'apps/*/src/**/__tests__/**/*.test.tsx',
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
