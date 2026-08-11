/**
 * Running a case (SPEC 16.2, SPEC 16.3).
 *
 * The subject is the *runner*, not the renderer: these tests assert which checks
 * ran, in what order, and what a passing or failing one says — never what an SVG
 * looks like. Pinning real output is the corpus's job, and one test at the
 * bottom runs the real corpus to prove the two halves meet.
 */

import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadCorpus } from '../src/corpus.js';
import { conformanceConfig, diffOf, runCase, runCorpus } from '../src/run.js';
import { CHECK_ORDER } from '../src/types.js';
import type { CaseResult, CheckName, CheckStatus, Corpus } from '../src/types.js';

import {
  BAR_CASE,
  BAR_DIAGNOSTIC,
  NO_DATA_CASE,
  NO_DATA_CODE,
  PROSE_CASE,
  astGolden,
  fixtureCase,
  withGoldens,
} from './harness.js';

/** The checks a result recorded, as `name: status`, in report order. */
function marks(result: CaseResult): Record<string, CheckStatus> {
  return Object.fromEntries(result.checks.map((check) => [check.check, check.status]));
}

/** Which checks ran at all, in the order the result carries them. */
function ran(result: CaseResult): CheckName[] {
  return result.checks.map((check) => check.check);
}

function checkNamed(result: CaseResult, name: CheckName) {
  const found = result.checks.find((check) => check.check === name);
  if (found === undefined) throw new Error(`no ${name} check in ${ran(result).join(', ')}`);
  return found;
}

describe('conformanceConfig', () => {
  it('pins every input a golden could depend on', () => {
    const config = conformanceConfig(2);

    expect(config.level).toBe(2);
    expect(config.locale).toBe('en-US');
    expect(config.timezone).toBe('UTC');
    expect(config.buildTime).toEqual(new Date(0));
    expect(config.capabilities).toEqual({});
  });

  it('refuses the network and the filesystem, so a case cannot depend on either', () => {
    expect(conformanceConfig(3).security).toEqual({
      allowExternal: false,
      allowFileUrls: false,
      allowHtml: false,
    });
  });

  it('renders light unless asked for dark', () => {
    expect(conformanceConfig(1).colorScheme).toBe('light');
    expect(conformanceConfig(1, 'dark').colorScheme).toBe('dark');
  });

  it('carries the built-in chart types and themes in, since a bare config has none', () => {
    const plugins = conformanceConfig(1).plugins ?? [];

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.chartTypes?.length ?? 0).toBeGreaterThan(0);
    expect(plugins[0]?.themes?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('runCase', () => {
  it('runs the whole pipeline for a case that pins nothing', async () => {
    const result = await runCase(fixtureCase());

    expect(result.status).toBe('pass');
    expect(marks(result)).toEqual({
      parse: 'pass',
      'round-trip': 'pass',
      resolve: 'pass',
      render: 'pass',
      pdf: 'pass',
    });
  });

  it('says a passing check with no golden proves only that the stage returned', async () => {
    const result = await runCase(fixtureCase());

    expect(checkNamed(result, 'render').reason).toBe(
      'ran without error; the case pins no golden for it',
    );
    expect(checkNamed(result, 'pdf').reason).toBe(
      'ran without error; the case pins no golden for it',
    );
  });

  it('omits the checks the case does not pin, rather than skipping them', async () => {
    const result = await runCase(fixtureCase());

    expect(ran(result)).not.toContain('ast');
    expect(ran(result)).not.toContain('diagnostics');
    expect(ran(result)).not.toContain('dark');
  });

  it('reports checks in CHECK_ORDER', async () => {
    const result = await runCase(
      withGoldens({
        ast: await astGolden(BAR_CASE),
        diagnostics: [{ code: BAR_DIAGNOSTIC }],
      }),
    );

    expect(result.status).toBe('pass');
    expect(ran(result)).toEqual([
      'parse',
      'round-trip',
      'resolve',
      'ast',
      'diagnostics',
      'render',
      'pdf',
    ]);
    const order = ran(result).map((name) => CHECK_ORDER.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('skips render for a document with nothing to draw', async () => {
    const result = await runCase(fixtureCase({ source: PROSE_CASE }));

    expect(result.status).toBe('pass');
    expect(checkNamed(result, 'render')).toEqual({
      check: 'render',
      status: 'skip',
      reason: 'no visual blocks',
    });
  });

  it('still runs pdf for a document with nothing to draw, because an empty export must work', async () => {
    const result = await runCase(fixtureCase({ source: PROSE_CASE }));

    expect(checkNamed(result, 'pdf').status).toBe('pass');
  });
});

describe('goldens', () => {
  it('passes an ast golden that matches', async () => {
    const result = await runCase(withGoldens({ ast: await astGolden(BAR_CASE) }));

    expect(result.status).toBe('pass');
    expect(checkNamed(result, 'ast').status).toBe('pass');
  });

  it('fails an ast golden that does not, and says where', async () => {
    const golden = await astGolden(BAR_CASE);
    const result = await runCase(withGoldens({ ast: golden.replace('bar', 'line') }));

    expect(result.status).toBe('fail');
    const ast = checkNamed(result, 'ast');
    expect(ast.status).toBe('fail');
    expect(ast.reason).toBe('output does not match the golden');
    expect(ast.detail).toMatch(/^first difference at line \d+ of \d+\n- .*\n\+ /u);
  });

  it('stops at the first failure, so one broken stage is not reported five times', async () => {
    const golden = await astGolden(BAR_CASE);
    const result = await runCase(
      withGoldens({ ast: golden.replace('bar', 'line'), svg: 'also wrong', pdf: 'also wrong' }),
    );

    expect(ran(result)).toEqual(['parse', 'round-trip', 'resolve', 'ast']);
  });

  it('fails a render golden that does not match, and does not go on to pdf', async () => {
    const result = await runCase(withGoldens({ svg: '<svg>not this</svg>' }));

    expect(result.status).toBe('fail');
    expect(checkNamed(result, 'render').status).toBe('fail');
    expect(ran(result)).not.toContain('pdf');
  });

  it('compares dark only when the case pins it', async () => {
    const plain = await runCase(fixtureCase());
    const pinned = await runCase(withGoldens({ dark: '<svg>not this either</svg>' }));

    expect(ran(plain)).not.toContain('dark');
    expect(checkNamed(pinned, 'dark').status).toBe('fail');
  });

  it('does not compare dark for a document with nothing to draw', async () => {
    const result = await runCase(
      withGoldens({ dark: '<svg>never read</svg>' }, { source: PROSE_CASE }),
    );

    expect(ran(result)).not.toContain('dark');
    expect(result.status).toBe('pass');
  });
});

describe('diagnostics golden', () => {
  it('passes when the codes line up', async () => {
    const result = await runCase(
      withGoldens({ diagnostics: [{ code: NO_DATA_CODE }] }, { source: NO_DATA_CASE }),
    );

    expect(checkNamed(result, 'diagnostics').status).toBe('pass');
    expect(result.status).toBe('pass');
  });

  it('compares only the fields the fingerprint declares', async () => {
    const result = await runCase(
      withGoldens(
        { diagnostics: [{ code: NO_DATA_CODE, severity: 'warning', source: 'data' }] },
        { source: NO_DATA_CASE },
      ),
    );

    expect(checkNamed(result, 'diagnostics').status).toBe('pass');
  });

  it('fails on a wrong code and names both sides', async () => {
    const result = await runCase(
      withGoldens({ diagnostics: [{ code: 'MDV9999' }] }, { source: NO_DATA_CASE }),
    );

    const check = checkNamed(result, 'diagnostics');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe(`[0] code: want MDV9999, got ${NO_DATA_CODE}`);
  });

  it('fails on a wrong severity', async () => {
    const result = await runCase(
      withGoldens(
        { diagnostics: [{ code: NO_DATA_CODE, severity: 'error' }] },
        { source: NO_DATA_CASE },
      ),
    );

    expect(checkNamed(result, 'diagnostics').detail).toBe('[0] severity: want error, got warning');
  });

  it('reports a diagnostic the golden did not expect', async () => {
    const result = await runCase(withGoldens({ diagnostics: [] }, { source: NO_DATA_CASE }));

    expect(checkNamed(result, 'diagnostics').detail).toBe(
      `[0] unexpected ${NO_DATA_CODE} (warning)`,
    );
  });

  it('reports a diagnostic the golden expected and did not get', async () => {
    const result = await runCase(
      withGoldens({ diagnostics: [{ code: 'MDV1000' }] }, { source: PROSE_CASE }),
    );

    expect(checkNamed(result, 'diagnostics').detail).toBe('[0] missing MDV1000');
  });

  it('holds the canonical case to the one diagnostic it does raise', async () => {
    const result = await runCase(withGoldens({ diagnostics: [{ code: BAR_DIAGNOSTIC }] }));

    expect(checkNamed(result, 'diagnostics').status).toBe('pass');
  });

  it('stops before render, so a diagnostics regression is reported once', async () => {
    const result = await runCase(
      withGoldens({ diagnostics: [{ code: 'MDV9999' }] }, { source: NO_DATA_CASE }),
    );

    expect(ran(result)).toEqual(['parse', 'round-trip', 'resolve', 'diagnostics']);
  });
});

describe('filtering', () => {
  it('skips a case above the level the run claims, rather than failing it', async () => {
    const result = await runCase(fixtureCase({ meta: { level: 3, tags: [], covers: [] } }), {
      level: 1,
    });

    expect(result.status).toBe('skip');
    expect(result.reason).toBe('level 3 case, run is level 1');
    expect(result.checks).toEqual([]);
    expect(result.covered).toEqual([]);
  });

  it('runs a case at the level the run claims', async () => {
    const result = await runCase(fixtureCase({ meta: { level: 1, tags: [], covers: [] } }), {
      level: 1,
    });

    expect(result.status).toBe('pass');
  });

  it('runs everything when no level is asked for', async () => {
    const result = await runCase(fixtureCase({ meta: { level: 3, tags: [], covers: [] } }));

    expect(result.status).toBe('pass');
  });

  it('skips a case carrying none of the wanted tags', async () => {
    const result = await runCase(fixtureCase({ meta: { level: 1, tags: ['bar'], covers: [] } }), {
      tags: ['stack', 'a11y'],
    });

    expect(result.status).toBe('skip');
    expect(result.reason).toBe('no tag in a11y, stack');
  });

  it('keeps a case carrying any one of them', async () => {
    const result = await runCase(
      fixtureCase({ meta: { level: 1, tags: ['bar', 'stack'], covers: [] } }),
      { tags: ['stack'] },
    );

    expect(result.status).toBe('pass');
  });

  it('treats an empty tag list as no filter at all', async () => {
    const result = await runCase(fixtureCase({ meta: { level: 1, tags: [], covers: [] } }), {
      tags: [],
    });

    expect(result.status).toBe('pass');
  });

  it('skips the pdf check on request, and says why', async () => {
    const result = await runCase(fixtureCase(), { pdf: false });

    expect(result.status).toBe('pass');
    expect(checkNamed(result, 'pdf')).toEqual({
      check: 'pdf',
      status: 'skip',
      reason: 'pdf checks disabled',
    });
  });

  it('is a skip, not a pass, so the report cannot claim export.pdf', async () => {
    const result = await runCase(fixtureCase(), { pdf: false });

    expect(result.covered).not.toContain('export.pdf');
  });
});

describe('coverage', () => {
  it('credits a passing case with what the document actually contains', async () => {
    const result = await runCase(fixtureCase());

    expect(result.covered).toContain('type.bar');
    expect(result.covered).toContain('syntax.frontmatter');
    expect(result.covered).toContain('render.marks');
    expect(result.covered).toContain('export.pdf');
  });

  it('credits a failing case with nothing, however far it got', async () => {
    const golden = await astGolden(BAR_CASE);
    const result = await runCase(withGoldens({ ast: golden.replace('bar', 'line') }));

    expect(result.status).toBe('fail');
    expect(result.covered).toEqual([]);
  });

  it('credits a skipped case with nothing', async () => {
    const result = await runCase(fixtureCase(), { level: 1, tags: ['nothing-has-this'] });

    expect(result.covered).toEqual([]);
  });
});

describe('runCorpus', () => {
  const corpus: Corpus = {
    root: '/corpus',
    issues: [],
    cases: [
      fixtureCase({ id: 'render/bar/one' }),
      fixtureCase({ id: 'syntax/prose', category: 'syntax', source: PROSE_CASE }),
      fixtureCase({ id: 'data/no-data', category: 'data', source: NO_DATA_CASE }),
    ],
  };

  it('returns one result per case, in corpus order', async () => {
    const results = await runCorpus(corpus);

    expect(results.map((result) => result.fixture.id)).toEqual([
      'render/bar/one',
      'syntax/prose',
      'data/no-data',
    ]);
  });

  it('passes the options through to every case', async () => {
    const results = await runCorpus(corpus, { pdf: false });

    for (const result of results) {
      expect(checkNamed(result, 'pdf').status).toBe('skip');
    }
  });

  it('produces the same results twice, which is the whole point of pinning the config', async () => {
    const first = await runCorpus(corpus);
    const second = await runCorpus(corpus);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('has nothing to do with an empty corpus', async () => {
    expect(await runCorpus({ root: '/corpus', cases: [], issues: [] })).toEqual([]);
  });
});

describe('diffOf', () => {
  it('points at the first differing line, counted from one', () => {
    expect(diffOf('a\nb\nc', 'a\nB\nc')).toBe('first difference at line 2 of 3\n- b\n+ B');
  });

  it('says so when the two agree', () => {
    expect(diffOf('a\nb', 'a\nb')).toBe('no textual difference');
  });

  it('reports a pure truncation as a length difference, not a line difference', () => {
    expect(diffOf('a\nb\nc', 'a\nb')).toBe('same 2 lines, then the golden continues');
    expect(diffOf('a\nb', 'a\nb\nc')).toBe('same 2 lines, then the output continues');
  });

  it('prefers a real difference to a length one when both are there', () => {
    expect(diffOf('a\nB\nc', 'a\nb')).toBe('first difference at line 2 of 3\n- B\n+ b');
  });

  it('clips a long line, because a report is read, not scrolled', () => {
    const detail = diffOf('x'.repeat(4000), 'y'.repeat(4000));

    for (const line of detail.split('\n').slice(1)) {
      expect(line).toMatch(/^[-+] .{200}…$/u);
    }
  });
});

describe('the real corpus', () => {
  it('runs clean, which is what the package exists to say', async () => {
    const corpus = await loadCorpus(fileURLToPath(new URL('../../spec/tests', import.meta.url)));

    expect(corpus.issues).toEqual([]);
    expect(corpus.cases.length).toBeGreaterThan(0);

    const results = await runCorpus(corpus);
    const failed = results.filter((result) => result.status === 'fail');

    expect(failed.map((result) => result.fixture.id)).toEqual([]);
  });
});
