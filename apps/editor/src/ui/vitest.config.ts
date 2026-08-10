import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Test config for the editor UI.
//
// The repo-root `vitest.config.ts` only collects `apps/*/test/**`, and the UI's
// tests live beside the modules they specify, so this config exists to run them
// in isolation:
//
//     pnpm exec vitest run --config apps/editor/src/ui/vitest.config.ts
//
// Everything under test here is deliberately DOM-free or DOM-shaped-but-injected:
// the pure helpers take a minimal node interface, so no jsdom is required (and
// none is installed). Anything that genuinely needs a browser is listed in
// `__tests__/README.md` rather than faked.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

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

const alias = WORKSPACE_PACKAGES.flatMap((pkg) => [
  {
    find: new RegExp(`^@mdv/${pkg}/(.*)$`),
    replacement: resolve(repoRoot, `packages/${pkg}/src/$1`),
  },
  {
    find: new RegExp(`^@mdv/${pkg}$`),
    replacement: resolve(repoRoot, `packages/${pkg}/src/index.ts`),
  },
]);

export default defineConfig({
  // Vitest would otherwise put its cache in `node_modules/.vite` *next to the
  // config*, i.e. inside `src/ui`. Source directories should not grow a
  // `node_modules`.
  cacheDir: resolve(repoRoot, 'node_modules/.vite/editor-ui'),
  resolve: { alias },
  esbuild: { jsx: 'automatic' },
  test: {
    globals: false,
    environment: 'node',
    root: here,
    include: ['__tests__/**/*.test.ts', '__tests__/**/*.test.tsx'],
  },
});
