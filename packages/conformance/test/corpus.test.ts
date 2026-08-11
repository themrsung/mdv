/**
 * The loader (SPEC 16.2): a directory tree in, a {@link Corpus} out.
 *
 * The loader's contract is that a broken case never stops the run — it loads
 * with a defaulted level and its problems are reported as issues, so one
 * mistyped `meta.json` cannot hide the state of every other case.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOT,
  DIAGNOSTICS_FILE,
  FIXTURE_CATEGORIES,
  GOLDEN_FILES,
  INPUT_FILE,
  META_FILE,
  caseIdOf,
  loadCorpus,
  normaliseGolden,
  readDiagnostics,
  readMeta,
} from '@mdv/conformance';

import { BAR_CASE, PROSE_CASE, tempCorpus, type TempCorpus } from './harness.js';

let corpus: TempCorpus | undefined;

afterEach(async () => {
  await corpus?.cleanup();
  corpus = undefined;
});

async function fresh(): Promise<TempCorpus> {
  corpus = await tempCorpus();
  return corpus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('the corpus skeleton', () => {
  it('points at the corpus in the repository', () => {
    expect(DEFAULT_ROOT).toBe('packages/spec/tests');
  });

  it('names every SPEC 16.2 category once', () => {
    expect([...FIXTURE_CATEGORIES]).toEqual([...new Set(FIXTURE_CATEGORIES)]);
    expect(FIXTURE_CATEGORIES).toContain('render');
    expect(FIXTURE_CATEGORIES).toContain('syntax');
  });

  it('names one file per golden check', () => {
    expect(GOLDEN_FILES).toEqual({
      ast: 'expected.ast.json',
      svg: 'expected.svg',
      dark: 'expected.dark.svg',
      pdf: 'expected.pdf.json',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

describe('loadCorpus', () => {
  it('finds cases across categories, in sorted order', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/second');
    await dir.addCase('render/bar/first');
    await dir.addCase('syntax/prose/only', { source: PROSE_CASE });

    const loaded = await loadCorpus(dir.root);

    expect(loaded.issues).toEqual([]);
    expect(loaded.cases.map((fixture) => fixture.id)).toEqual([
      'render/bar/first',
      'render/bar/second',
      'syntax/prose/only',
    ]);
    expect(loaded.cases.map((fixture) => fixture.category)).toEqual(['render', 'render', 'syntax']);
    expect(loaded.root).toBe(dir.root);
  });

  it('orders by id, not by the order the filesystem hands them back', async () => {
    const dir = await fresh();
    await dir.addCase('render/zzz');
    await dir.addCase('render/bar/deep/case');
    await dir.addCase('render/aaa');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases.map((fixture) => fixture.id)).toEqual([
      'render/aaa',
      'render/bar/deep/case',
      'render/zzz',
    ]);
  });

  it('reads the source and the level of each case', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple', { meta: { level: 2, tags: ['bar'] } });

    const [fixture] = (await loadCorpus(dir.root)).cases;

    expect(fixture?.source).toBe(BAR_CASE);
    expect(fixture?.meta.level).toBe(2);
    expect(fixture?.meta.tags).toEqual(['bar']);
    expect(fixture?.meta.covers).toEqual([]);
  });

  it('is empty, not broken, for a root that holds only the category skeleton', async () => {
    const dir = await fresh();
    await dir.write('render/.gitkeep', '');
    await dir.write('syntax/.gitkeep', '');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toEqual([]);
    expect(loaded.issues).toEqual([]);
  });

  it('reports a root it cannot read, rather than throwing', async () => {
    const dir = await fresh();

    const loaded = await loadCorpus(`${dir.root}/no-such-root`);

    expect(loaded.cases).toEqual([]);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.message).toContain('cannot read corpus root');
  });

  it('ignores files at the root and dot-directories anywhere', async () => {
    const dir = await fresh();
    await dir.write('README.md', '# corpus\n');
    await dir.addCase('render/bar/simple');
    await dir.write('.git/objects/whatever', 'not a case');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases.map((fixture) => fixture.id)).toEqual(['render/bar/simple']);
    expect(loaded.issues).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issues
// ─────────────────────────────────────────────────────────────────────────────

describe('a corpus that is malformed', () => {
  it('reports a top-level directory that is not a category', async () => {
    const dir = await fresh();
    await dir.addCase('rendering/bar/simple');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toEqual([]);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.path).toBe('rendering');
    expect(loaded.issues[0]?.message).toContain('not a SPEC 16.2 category');
  });

  it('reports a golden that sits beside no input', async () => {
    const dir = await fresh();
    await dir.write(`render/bar/orphan/${GOLDEN_FILES.svg}`, '<svg></svg>');
    await dir.write(`render/bar/orphan/${META_FILE}`, '{ "level": 1 }');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toEqual([]);
    expect(loaded.issues.map((issue) => issue.message).join('\n')).toContain(
      `beside no ${INPUT_FILE}`,
    );
    expect(loaded.issues).toHaveLength(2);
  });

  it('reports a case directory that holds another case', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/outer');
    await dir.addCase('render/bar/outer/inner');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases.map((fixture) => fixture.id)).toEqual(['render/bar/outer']);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.message).toContain('must not contain sub-directories');
    expect(loaded.issues[0]?.message).toContain('inner');
  });

  it('reports an unrecognised `expected.` file inside a case', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple', { files: { 'expected.png': 'not a golden' } });

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.path).toBe('render/bar/simple');
    expect(loaded.issues[0]?.message).toContain('unrecognised golden');
  });

  it('still loads a case whose meta is unusable, at the default level', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple', { meta: { level: 9 } });

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0]?.meta.level).toBe(1);
    expect(loaded.issues.map((issue) => issue.message).join('\n')).toContain('"level" must be');
  });

  it('reports a case with no meta at all', async () => {
    const dir = await fresh();
    await dir.write(`render/bar/simple/${INPUT_FILE}`, BAR_CASE);

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.issues.map((issue) => issue.message)).toContain(`${META_FILE} is required`);
  });

  it('reports meta that is not JSON', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple');
    await dir.write(`render/bar/simple/${META_FILE}`, '{ nope');

    const loaded = await loadCorpus(dir.root);

    expect(loaded.cases).toHaveLength(1);
    expect(loaded.issues).toHaveLength(1);
    expect(loaded.issues[0]?.message).toContain(META_FILE);
  });

  it('reports diagnostics that are not an array', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple', { files: { [DIAGNOSTICS_FILE]: '{}' } });

    const loaded = await loadCorpus(dir.root);

    expect(loaded.issues.map((issue) => issue.message).join('\n')).toContain(
      `${DIAGNOSTICS_FILE} must be a JSON array`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Goldens
// ─────────────────────────────────────────────────────────────────────────────

describe('the goldens a case ships', () => {
  it('reads each one under the name of the check that compares it', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple', {
      files: {
        [GOLDEN_FILES.ast]: '{"kind":"document"}',
        [GOLDEN_FILES.svg]: '<svg id="light"></svg>',
        [GOLDEN_FILES.dark]: '<svg id="dark"></svg>',
        [GOLDEN_FILES.pdf]: '[]',
        [DIAGNOSTICS_FILE]: '["MDV2100"]',
      },
    });

    const [fixture] = (await loadCorpus(dir.root)).cases;

    expect(fixture?.goldens.ast).toBe('{"kind":"document"}');
    expect(fixture?.goldens.svg).toBe('<svg id="light"></svg>');
    expect(fixture?.goldens.dark).toBe('<svg id="dark"></svg>');
    expect(fixture?.goldens.pdf).toBe('[]');
    expect(fixture?.goldens.diagnostics).toEqual([{ code: 'MDV2100' }]);
  });

  it('leaves the ones the case does not ship undefined', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple');

    const [fixture] = (await loadCorpus(dir.root)).cases;

    expect(fixture?.goldens).toEqual({});
  });

  it('normalises the line ending and the final newline', async () => {
    const dir = await fresh();
    await dir.addCase('render/bar/simple', {
      files: { [GOLDEN_FILES.svg]: '<svg>\r\n</svg>\n\n\n' },
    });

    const [fixture] = (await loadCorpus(dir.root)).cases;

    expect(fixture?.goldens.svg).toBe('<svg>\n</svg>');
  });
});

describe('normaliseGolden', () => {
  it('is the identity on text that is already normal', () => {
    expect(normaliseGolden('a\nb')).toBe('a\nb');
  });

  it('folds CRLF and strips every trailing newline', () => {
    expect(normaliseGolden('a\r\nb\r\n\r\n')).toBe('a\nb');
  });

  it('keeps interior blank lines, which are part of the output', () => {
    expect(normaliseGolden('a\n\nb\n')).toBe('a\n\nb');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// meta.json
// ─────────────────────────────────────────────────────────────────────────────

describe('readMeta', () => {
  it('accepts the minimum: a level', () => {
    expect(readMeta({ level: 3 })).toEqual({
      meta: { level: 3, tags: [], covers: [], pin: [] },
      errors: [],
    });
  });

  it('keeps tags, note, covers and pin', () => {
    const { meta, errors } = readMeta({
      level: 1,
      tags: ['bar'],
      note: 'why this case exists',
      covers: ['type.bar'],
      pin: ['ast', 'svg'],
    });

    expect(errors).toEqual([]);
    expect(meta).toEqual({
      level: 1,
      tags: ['bar'],
      note: 'why this case exists',
      covers: ['type.bar'],
      pin: ['ast', 'svg'],
    });
  });

  it('sorts covers, so two orderings of the same claim are one claim', () => {
    expect(readMeta({ level: 1, covers: ['type.line', 'type.bar'] }).meta.covers).toEqual([
      'type.bar',
      'type.line',
    ]);
  });

  it('rejects a body that is not an object', () => {
    const { meta, errors } = readMeta([]);

    expect(meta.level).toBe(1);
    expect(errors).toEqual([`${META_FILE} must be a JSON object`]);
  });

  it('rejects an unknown key, because a typo silently disables a claim', () => {
    expect(readMeta({ level: 1, cover: ['type.bar'] }).errors.join('\n')).toContain('unknown key');
  });

  it('rejects a level outside 1..3', () => {
    for (const level of [0, 4, '2', null]) {
      expect(readMeta({ level }).errors.join('\n')).toContain('"level" must be 1, 2 or 3');
    }
  });

  it('rejects tags that are not non-empty strings', () => {
    expect(readMeta({ level: 1, tags: 'bar' }).errors.join('\n')).toContain(
      '"tags" must be an array',
    );
    expect(readMeta({ level: 1, tags: [''] }).errors.join('\n')).toContain('"tags"');
  });

  it('rejects a note that is not a string', () => {
    expect(readMeta({ level: 1, note: 7 }).errors.join('\n')).toContain('"note"');
  });

  it('rejects a requirement that levels.json does not define', () => {
    expect(readMeta({ level: 1, covers: ['type.nope'] }).errors.join('\n')).toContain(
      'levels.json does not define',
    );
  });

  it('rejects a repeated requirement', () => {
    expect(readMeta({ level: 1, covers: ['type.bar', 'type.bar'] }).errors.join('\n')).toContain(
      'repeats',
    );
  });

  it('reports every problem at once, not the first', () => {
    expect(readMeta({ level: 9, tags: 'bar', note: 7 }).errors.length).toBeGreaterThan(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diagnostics.json
// ─────────────────────────────────────────────────────────────────────────────

describe('readDiagnostics', () => {
  it('reads a bare code as a fingerprint that pins only the code', () => {
    expect(readDiagnostics(['MDV2100'])).toEqual({
      diagnostics: [{ code: 'MDV2100' }],
      errors: [],
    });
  });

  it('reads the fields an object declares, and only those', () => {
    const { diagnostics, errors } = readDiagnostics([
      { code: 'MDV2100', severity: 'warning', source: 'data', range: [0, 35] },
    ]);

    expect(errors).toEqual([]);
    expect(diagnostics).toEqual([
      { code: 'MDV2100', severity: 'warning', source: 'data', range: [0, 35] },
    ]);
  });

  it('reads a Range as its two offsets', () => {
    const { diagnostics } = readDiagnostics([
      { code: 'MDV2100', range: { start: { offset: 4 }, end: { offset: 9 } } },
    ]);

    expect(diagnostics[0]?.range).toEqual([4, 9]);
  });

  it('rejects a body that is not an array', () => {
    expect(readDiagnostics({}).errors).toEqual([`${DIAGNOSTICS_FILE} must be a JSON array`]);
  });

  it('says which entry is wrong', () => {
    expect(readDiagnostics(['MDV2100', 7]).errors.join('\n')).toContain(`${DIAGNOSTICS_FILE}[1]`);
  });

  it('rejects a range that is not two offsets', () => {
    expect(readDiagnostics([{ code: 'MDV2100', range: [1] }]).errors.join('\n')).toContain('range');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ids
// ─────────────────────────────────────────────────────────────────────────────

describe('caseIdOf', () => {
  it('is the path below the root, in slash form', () => {
    expect(caseIdOf('/corpus', '/corpus/render/bar/simple')).toBe('render/bar/simple');
  });

  it('is stable whether or not the root has a trailing separator', () => {
    expect(caseIdOf('/corpus/', '/corpus/render/bar/simple')).toBe('render/bar/simple');
  });

  it('is the whole path when the directory is not below the root', () => {
    expect(caseIdOf('/corpus', '/elsewhere/render/bar')).toContain('render/bar');
  });
});
