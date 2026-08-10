import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Test config for the editor engine.
//
// The repo-root `vitest.config.ts` only collects `apps/*/test/**`, and the
// engine's tests live beside its source (they are its specification, so they
// belong next to what they specify). This config exists so the engine can be
// verified in isolation:
//
//     pnpm exec vitest run --config apps/editor/src/engine/vitest.config.ts
//
// Integration can fold `apps/*/src/**/*.test.ts` into the root config instead;
// nothing here depends on this file.
//
// Line comments, not a block comment: the globs above contain `*/`, which would
// close a block comment early. This previously relied on invisible U+200B
// separators, which `no-irregular-whitespace` rejects and a reader cannot see.
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    root: here,
    include: ['__tests__/**/*.test.ts'],
  },
});
