import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/**
 * Workspace packages resolved to **source**, mirroring the `paths` block in
 * `tsconfig.base.json`. No build step: editing `packages/core/src` hot-reloads
 * the editor.
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

export default defineConfig(({ mode }) => ({
  base: '/',
  plugins: [react()],
  resolve: { alias },
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // A fully static bundle: no SSR, no server entry, no API routes.
    ssr: false,
    // Maps are for the machine that built the bundle. Because the aliases above
    // resolve to workspace *source*, a published map is the whole repository —
    // so the hosted build ships without them, and every other mode keeps them.
    sourcemap: mode !== 'production',
    target: 'es2022',
  },
}));
