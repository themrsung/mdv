/**
 * Minting goldens (SPEC 16.2).
 *
 * Everything here is about the three rules that keep `--update` honest: it
 * writes only what a case asked for, a case that gives out writes nothing at
 * all, and every file it touched is named in the report. The corpus is a real
 * directory under `mkdtemp`, because what is under test is which bytes ended up
 * on disk.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GOLDEN_FILE_OF } from '../src/corpus.js';
import { updateCorpus } from '../src/update.js';
import type { GoldenWrite, UpdateReport } from '../src/update.js';

import { astGolden, BAR_CASE, NO_DATA_CASE, PROSE_CASE, tempCorpus } from './harness.js';
import type { TempCorpus } from './harness.js';

let corpus: TempCorpus | undefined;

afterEach(async () => {
  await corpus?.cleanup();
  corpus = undefined;
});

/** A corpus root the caller then fills. */
async function fresh(): Promise<TempCorpus> {
  corpus = await tempCorpus();
  return corpus;
}

/** `meta.json` for a case that pins `names`. */
function pinning(...names: readonly string[]): unknown {
  return { level: 1, pin: names };
}

/** The paths an update wrote, in report order. */
function paths(report: UpdateReport): readonly string[] {
  return report.writes.map((write) => write.path);
}

/** One case's file, or `undefined` when it is not there. */
async function read(temp: TempCorpus, id: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(temp.root, id, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** The write for one golden, by the path it names. */
function writeOf(report: UpdateReport, path: string): GoldenWrite {
  const found = report.writes.find((write) => write.path === path);
  if (found === undefined) throw new Error(`no write for ${path} in ${paths(report).join(', ')}`);
  return found;
}

describe('what an update mints', () => {
  it('creates the golden a case pinned and has yet to produce', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', { meta: pinning('ast') });

    const report = await updateCorpus(temp.root);

    expect(paths(report)).toEqual(['syntax/bar/simple/expected.ast.json']);
    expect(writeOf(report, 'syntax/bar/simple/expected.ast.json').status).toBe('created');
    expect(await read(temp, 'syntax/bar/simple', GOLDEN_FILE_OF.ast)).toBe(
      `${await astGolden(BAR_CASE)}\n`,
    );
    expect(report.ok).toBe(true);
  });

  it('writes nothing for a case that pinned nothing and ships nothing', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple');

    const report = await updateCorpus(temp.root);

    expect(report.writes).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('refreshes a golden already beside the case, pinned or not', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', {
      files: { [GOLDEN_FILE_OF.ast]: '{ "type": "stale" }\n' },
    });

    const report = await updateCorpus(temp.root);

    expect(writeOf(report, 'syntax/bar/simple/expected.ast.json').status).toBe('updated');
    expect(await read(temp, 'syntax/bar/simple', GOLDEN_FILE_OF.ast)).toBe(
      `${await astGolden(BAR_CASE)}\n`,
    );
  });

  it('leaves a golden that already says the same thing unchanged', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', {
      files: { [GOLDEN_FILE_OF.ast]: `${await astGolden(BAR_CASE)}\n` },
    });
    const before = await stat(join(temp.root, 'syntax/bar/simple', GOLDEN_FILE_OF.ast));

    const report = await updateCorpus(temp.root);
    const after = await stat(join(temp.root, 'syntax/bar/simple', GOLDEN_FILE_OF.ast));

    expect(writeOf(report, 'syntax/bar/simple/expected.ast.json').status).toBe('unchanged');
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('compares on the normalised text, so a missing newline is not a change', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', {
      files: { [GOLDEN_FILE_OF.ast]: await astGolden(BAR_CASE) },
    });

    const report = await updateCorpus(temp.root);

    expect(writeOf(report, 'syntax/bar/simple/expected.ast.json').status).toBe('unchanged');
  });

  it('mints diagnostics as the fingerprints the runner compares', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/dataset/no-data', {
      meta: pinning('diagnostics'),
      source: NO_DATA_CASE,
    });

    await updateCorpus(temp.root);
    const text = await read(temp, 'syntax/dataset/no-data', GOLDEN_FILE_OF.diagnostics);

    expect(JSON.parse(text ?? 'null')).toEqual([
      expect.objectContaining({ code: 'MDV2100', severity: 'warning' }),
    ]);
  });

  it('does not widen what the corpus asserts: an unpinned golden is not created', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple', { meta: pinning('ast') });

    const report = await updateCorpus(temp.root);

    expect(paths(report)).not.toContain('render/bar/simple/expected.svg');
    expect(await read(temp, 'render/bar/simple', GOLDEN_FILE_OF.svg)).toBeUndefined();
  });

  it('skips the pdf trace unless it is asked for, as a run does', async () => {
    const temp = await fresh();
    await temp.addCase('pdf/bar/simple', { meta: pinning('ast', 'pdf') });

    const report = await updateCorpus(temp.root, { pdf: false });

    expect(paths(report)).toEqual(['pdf/bar/simple/expected.ast.json']);
  });
});

describe('a case that cannot be minted', () => {
  it('is reported by the stage that gave out, and writes nothing', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/prose/only', {
      meta: pinning('ast', 'svg'),
      source: PROSE_CASE,
    });

    const report = await updateCorpus(temp.root);

    expect(report.failures).toEqual([
      { case: 'syntax/prose/only', stage: 'render', reason: expect.stringContaining('no visual') },
    ]);
    expect(report.writes).toEqual([]);
    expect(await read(temp, 'syntax/prose/only', GOLDEN_FILE_OF.ast)).toBeUndefined();
    expect(report.ok).toBe(false);
  });

  it('leaves the golden a failing case already ships alone', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/prose/only', {
      meta: pinning('svg'),
      source: PROSE_CASE,
      files: { [GOLDEN_FILE_OF.ast]: '{ "kept": true }\n' },
    });

    await updateCorpus(temp.root);

    expect(await read(temp, 'syntax/prose/only', GOLDEN_FILE_OF.ast)).toBe('{ "kept": true }\n');
  });

  it('does not stop the cases after it', async () => {
    const temp = await fresh();
    await temp.addCase('a11y/prose/only', { meta: pinning('svg'), source: PROSE_CASE });
    await temp.addCase('data/bar/simple', { meta: pinning('ast') });

    const report = await updateCorpus(temp.root);

    expect(report.failures).toHaveLength(1);
    expect(paths(report)).toEqual(['data/bar/simple/expected.ast.json']);
  });
});

describe('the report', () => {
  it('is sorted by path, whatever order the corpus was visited in', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/z/last', { meta: pinning('ast') });
    await temp.addCase('syntax/a/first', { meta: pinning('ast', 'diagnostics') });

    const report = await updateCorpus(temp.root);

    expect(paths(report)).toEqual([...paths(report)].sort());
    expect(paths(report)).toEqual([
      'syntax/a/first/diagnostics.json',
      'syntax/a/first/expected.ast.json',
      'syntax/z/last/expected.ast.json',
    ]);
  });

  it('names the case each write belongs to', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', { meta: pinning('ast') });

    const report = await updateCorpus(temp.root);

    expect(report.writes[0]).toMatchObject({ case: 'syntax/bar/simple', name: 'ast' });
  });

  it('is not ok when the corpus itself is unsound, and reports the issue', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', { meta: pinning('ast') });
    await temp.write('syntax/broken/input.mdv', BAR_CASE);

    const report = await updateCorpus(temp.root);

    expect(report.issues).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it('carries the root the corpus was loaded from', async () => {
    const temp = await fresh();

    expect((await updateCorpus(temp.root)).root).toBe(temp.root);
  });
});

describe('a dry run', () => {
  it('reports the writes it would make and touches nothing', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', { meta: pinning('ast') });

    const report = await updateCorpus(temp.root, { dryRun: true });

    expect(writeOf(report, 'syntax/bar/simple/expected.ast.json').status).toBe('created');
    expect(await read(temp, 'syntax/bar/simple', GOLDEN_FILE_OF.ast)).toBeUndefined();
  });

  it('says which of the files already there would change', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/bar/simple', {
      files: {
        [GOLDEN_FILE_OF.ast]: '{ "type": "stale" }\n',
        [GOLDEN_FILE_OF.diagnostics]: JSON.stringify([{ code: 'MDV2101' }]),
      },
    });

    const report = await updateCorpus(temp.root, { dryRun: true });

    expect(writeOf(report, 'syntax/bar/simple/expected.ast.json').status).toBe('updated');
    expect(await read(temp, 'syntax/bar/simple', GOLDEN_FILE_OF.ast)).toBe('{ "type": "stale" }\n');
  });
});

describe('selection', () => {
  it('mints only the cases a level covers', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/one/low', { meta: { level: 1, pin: ['ast'] } });
    await temp.addCase('syntax/two/high', { meta: { level: 3, pin: ['ast'] } });

    const report = await updateCorpus(temp.root, { level: 1 });

    expect(paths(report)).toEqual(['syntax/one/low/expected.ast.json']);
  });

  it('mints only the cases a tag selects', async () => {
    const temp = await fresh();
    await temp.addCase('syntax/one/tagged', { meta: { level: 1, tags: ['bar'], pin: ['ast'] } });
    await temp.addCase('syntax/two/other', { meta: { level: 1, tags: ['line'], pin: ['ast'] } });

    const report = await updateCorpus(temp.root, { tags: ['bar'] });

    expect(paths(report)).toEqual(['syntax/one/tagged/expected.ast.json']);
  });
});
