/**
 * Materialise `.vercel/output` (Build Output API v3) from the editor's Vite
 * build, so the deploy can be `--prebuilt`.
 *
 * The editor is a fully static SPA, so the hosted build has nothing to do that
 * this machine cannot do first — and doing it here means the deploy carries no
 * opinion about which pnpm or Node the builder happens to ship. `vercel.json`
 * describes the same site for the git-connected path; the routes below are its
 * Build Output API spelling, and the two must be changed together.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(repoRoot, 'apps/editor/dist');
const out = resolve(repoRoot, '.vercel/output');

const config = {
  version: 3,
  routes: [
    {
      src: '/assets/(.*)',
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      continue: true,
    },
    {
      src: '/(.*)',
      headers: {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-frame-options': 'SAMEORIGIN',
      },
      continue: true,
    },
    // Static files win; anything left over is the SPA shell, not a 404.
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(dist, resolve(out, 'static'), { recursive: true });
await writeFile(resolve(out, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

console.log(`vercel build output ready: ${out}`);
