/**
 * SPEC 27 / M7 - `mdv fmt --check` is idempotent over the corpus.
 *
 * The milestone is a claim about a loop a CI job runs: format, then check, and
 * the check must pass. Two things can break it and neither shows up in a unit
 * test of `toMarkdown`. The formatter can be unstable - a second pass moves
 * text a first pass wrote - which makes `--check` fail on its own output. Or
 * `--check` and the rewrite can disagree about what "formatted" means, so a
 * clean tree still reports work to do. Both are tested here against the same
 * Appendix E corpus the parser round-trips, driven through the real argv path.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_CODES, run } from '../src/index.js';
import { PROSE_DOCUMENT, SIMPLE_DOCUMENT, TWO_BLOCK_DOCUMENT, workspace } from './harness.js';
import type { Workspace } from './harness.js';

/** The corpus the parser's round-trip suite reads, exercised through the CLI. */
const APPENDIX_E = fileURLToPath(
  new URL('../../parser/test/fixtures/appendix-e.mdv', import.meta.url),
);

let ws: Workspace;

beforeEach(async () => {
  ws = await workspace();
});

afterEach(async () => {
  await ws.cleanup();
});

/** Every document the workspace is seeded with, by file name. */
async function seed(): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    'simple.mdv': SIMPLE_DOCUMENT,
    'two-block.mdv': TWO_BLOCK_DOCUMENT,
    'prose.mdv': PROSE_DOCUMENT,
    'appendix-e.mdv': await readFile(APPENDIX_E, 'utf8'),
  };
  for (const [name, text] of Object.entries(files)) await ws.write(name, text);
  return files;
}

describe('mdv fmt --check (SPEC 27, M7)', () => {
  it('formats the corpus, then passes its own check', async () => {
    const files = await seed();
    expect(await run(['fmt', '.'], ws.io)).toBe(EXIT_CODES.ok);

    const checked = await workspace();
    try {
      // A fresh io: the check must pass on the tree `fmt` just wrote, and name
      // no file as needing work. The list of files goes to stdout, the summary
      // to stderr, so a CI job can pipe one without the other.
      const io = checked.io;
      expect(await run(['fmt', ws.dir, '--check'], io)).toBe(EXIT_CODES.ok);
      for (const name of Object.keys(files)) expect(io.out).not.toContain(name);
      expect(io.err).toContain('4 files, all formatted');
    } finally {
      await checked.cleanup();
    }
  });

  it('is a fixed point: a second format changes nothing on disk', async () => {
    const files = await seed();
    expect(await run(['fmt', '.'], ws.io)).toBe(EXIT_CODES.ok);
    const once: Record<string, string> = {};
    for (const name of Object.keys(files)) once[name] = await ws.read(name);

    expect(await run(['fmt', '.'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.err).toContain('nothing to do');
    for (const name of Object.keys(files)) expect(await ws.read(name)).toBe(once[name]);
  });

  it('reports unformatted files by name and exits non-zero, without writing', async () => {
    // Attribute order is the smallest thing the formatter is allowed to move.
    const unformatted = '```mdv bar zeta=1 alpha=2\ntitle: T\n```\n';
    await ws.write('messy.mdv', unformatted);

    expect(await run(['fmt', 'messy.mdv', '--check'], ws.io)).toBe(EXIT_CODES.diagnostics);
    expect(ws.io.out).toContain('messy.mdv');
    expect(ws.io.err).toContain('1 file, 1 would be reformatted');
    // `--check` is read-only: CI must not leave a dirty tree behind.
    expect(await ws.read('messy.mdv')).toBe(unformatted);
  });

  it('agrees with itself: what --check flags is exactly what fmt rewrites', async () => {
    await ws.write('messy.mdv', '```mdv bar zeta=1 alpha=2\ntitle: T\n```\n');
    await ws.write('clean.mdv', SIMPLE_DOCUMENT);
    // Whatever `fmt` leaves alone, `--check` must call clean, and the reverse.
    const before = await ws.read('clean.mdv');

    expect(await run(['fmt', '.'], ws.io)).toBe(EXIT_CODES.ok);
    expect(await ws.read('messy.mdv')).toContain('alpha=2 zeta=1');
    expect(await ws.read('clean.mdv')).toBe(before);
  });
});
