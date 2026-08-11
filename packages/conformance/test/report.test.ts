/**
 * Turning results into a report, and a report into Markdown (SPEC 16.3).
 *
 * Every function under test is pure, so the results here are written by hand
 * rather than run: that is the only way to describe a build broken in exactly
 * one interesting way, and it keeps the report's rules — coverage counts only
 * passing cases, a level is substantiated only when every requirement under it
 * is reached — testable without a corpus that can produce each shape.
 */

import { describe, expect, it } from 'vitest';

import { buildReport, renderReport } from '../src/report.js';
import type { CaseResult, ConformanceReport, Corpus } from '../src/types.js';

import { caseResult, fixtureCase } from './harness.js';

/** Level 1 has 22 requirements; these three are enough to reason about. */
const L1 = ['syntax.frontmatter', 'syntax.base', 'syntax.blocks'] as const;

function corpusOf(results: readonly CaseResult[], issues: Corpus['issues'] = []): Corpus {
  return {
    root: '/corpus',
    issues,
    cases: results.map((result) => result.fixture),
  };
}

function report(
  results: readonly CaseResult[],
  level: 1 | 2 | 3 = 1,
  issues: Corpus['issues'] = [],
) {
  return buildReport(corpusOf(results, issues), results, level);
}

/** The coverage row for a requirement, or a readable failure. */
function rowFor(built: ConformanceReport, id: string) {
  const row = built.coverage.find((candidate) => candidate.requirement.id === id);
  if (row === undefined) throw new Error(`no coverage row for ${id}`);
  return row;
}

describe('buildReport', () => {
  it('stamps the spec version the level table was built from', () => {
    expect(report([]).specVersion).toBe('1.0-draft.1');
  });

  it('carries the level asked for, the root, and the results through unchanged', () => {
    const results = [caseResult()];
    const built = report(results, 2);

    expect(built.level).toBe(2);
    expect(built.root).toBe('/corpus');
    expect(built.results).toBe(results);
  });

  it('lists every requirement up to the level asked for, and none above it', () => {
    expect(report([], 1).coverage).toHaveLength(22);
    expect(report([], 2).coverage).toHaveLength(47);
    expect(report([], 3).coverage).toHaveLength(55);
    expect(report([], 1).coverage.every((row) => row.requirement.level === 1)).toBe(true);
  });

  it('is ok when nothing failed', () => {
    expect(report([caseResult()]).ok).toBe(true);
  });

  it('is not ok when a check failed', () => {
    const built = report([
      caseResult({ status: 'fail', checks: [{ check: 'parse', status: 'fail', reason: 'boom' }] }),
    ]);

    expect(built.ok).toBe(false);
  });

  it('is not ok when the corpus itself is broken, however well the cases ran', () => {
    const built = report([caseResult()], 1, [{ path: 'render/bar', message: 'no meta.json' }]);

    expect(built.ok).toBe(false);
    expect(built.issues).toEqual([{ path: 'render/bar', message: 'no meta.json' }]);
  });

  it('has an empty report, which is not ok to call a level, but is ok as a run', () => {
    const built = report([]);

    expect(built.ok).toBe(true);
    expect(built.substantiated).toBeUndefined();
    expect(built.totals.cases).toBe(0);
  });
});

describe('coverage', () => {
  it('credits a requirement to the cases that reached it', () => {
    const built = report([
      caseResult({ fixture: fixtureCase({ id: 'syntax/a' }), covered: [L1[0]] }),
      caseResult({ fixture: fixtureCase({ id: 'syntax/b' }), covered: [L1[0], L1[1]] }),
    ]);

    expect(rowFor(built, L1[0]).cases).toEqual(['syntax/a', 'syntax/b']);
    expect(rowFor(built, L1[1]).cases).toEqual(['syntax/b']);
    expect(rowFor(built, L1[2]).cases).toEqual([]);
  });

  it('sorts the case ids, so the report does not move when the corpus is reordered', () => {
    const built = report([
      caseResult({ fixture: fixtureCase({ id: 'syntax/z' }), covered: [L1[0]] }),
      caseResult({ fixture: fixtureCase({ id: 'syntax/a' }), covered: [L1[0]] }),
    ]);

    expect(rowFor(built, L1[0]).cases).toEqual(['syntax/a', 'syntax/z']);
  });

  it('ignores what a failing case reached, because a broken build cannot claim a level', () => {
    const built = report([
      caseResult({ status: 'fail', covered: [L1[0]] }),
      caseResult({ status: 'skip', covered: [L1[1]] }),
    ]);

    expect(rowFor(built, L1[0]).cases).toEqual([]);
    expect(rowFor(built, L1[1]).cases).toEqual([]);
  });

  it('drops a requirement above the level asked for, even when a case reached it', () => {
    const built = report([caseResult({ covered: ['type.map'] })], 1);

    expect(built.coverage.map((row) => row.requirement.id)).not.toContain('type.map');
  });
});

describe('substantiated level', () => {
  /** A run that covers every requirement of `level` and below. */
  function covering(level: 1 | 2 | 3): CaseResult[] {
    const ids = buildReport(corpusOf([]), [], level).coverage.map((row) => row.requirement.id);
    return [caseResult({ covered: ids })];
  }

  it('is undefined when nothing was covered', () => {
    expect(report([caseResult()], 3).substantiated).toBeUndefined();
  });

  it('is the level whose every requirement was reached', () => {
    expect(report(covering(1), 3).substantiated).toBe(1);
    expect(report(covering(2), 3).substantiated).toBe(2);
    expect(report(covering(3), 3).substantiated).toBe(3);
  });

  it('stops at the first gap rather than skipping over it', () => {
    const all = buildReport(corpusOf([]), [], 3).coverage.map((row) => row.requirement.id);
    const holed = all.filter((id) => id !== L1[2]);

    expect(report([caseResult({ covered: holed })], 3).substantiated).toBeUndefined();
  });

  it('does not claim a level the run did not ask about', () => {
    // Every Level 1 requirement is covered, but the run only asked for Level 1,
    // so nothing is known about Level 2 and the report may not guess.
    const built = report(covering(1), 1);

    expect(built.substantiated).toBe(1);
    expect(built.coverage.every((row) => row.requirement.level === 1)).toBe(true);
  });

  it('is one level below the gap when the gap is higher up', () => {
    const upToTwo = buildReport(corpusOf([]), [], 2).coverage.map((row) => row.requirement.id);

    expect(report([caseResult({ covered: upToTwo })], 3).substantiated).toBe(2);
  });
});

describe('totals', () => {
  it('counts cases and checks separately, because a case is not a check', () => {
    const built = report([
      caseResult({
        checks: [
          { check: 'parse', status: 'pass' },
          { check: 'render', status: 'skip', reason: 'no visual blocks' },
        ],
      }),
      caseResult({
        status: 'fail',
        checks: [
          { check: 'parse', status: 'pass' },
          { check: 'ast', status: 'fail', reason: 'boom' },
        ],
      }),
      caseResult({ status: 'skip', checks: [] }),
    ]);

    expect(built.totals).toEqual({
      cases: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      checks: 4,
      checksPassed: 2,
      checksFailed: 1,
      checksSkipped: 1,
    });
  });

  it('is all zeroes for an empty run', () => {
    expect(report([]).totals).toEqual({
      cases: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      checks: 0,
      checksPassed: 0,
      checksFailed: 0,
      checksSkipped: 0,
    });
  });
});

describe('renderReport', () => {
  it('leads with the verdict, so a reader knows in one line', () => {
    const lines = renderReport(report([caseResult()])).split('\n');

    expect(lines[0]).toBe('# MDV conformance report');
    expect(lines).toContain('- Result: **pass**');
    expect(lines).toContain('- Spec version: `1.0-draft.1`');
    expect(lines).toContain('- Corpus root: `/corpus`');
  });

  it('says fail when the run failed', () => {
    const built = report([
      caseResult({ status: 'fail', checks: [{ check: 'parse', status: 'fail', reason: 'boom' }] }),
    ]);

    expect(renderReport(built)).toContain('- Result: **fail**');
  });

  it('says which level the run substantiated, not just which it asked for', () => {
    const ids = buildReport(corpusOf([]), [], 1).coverage.map((row) => row.requirement.id);
    const text = renderReport(report([caseResult({ covered: ids })], 1));

    expect(text).toContain('- Level asked for: 1 (Core)');
    expect(text).toContain('- Level substantiated: 1 (Core)');
  });

  it('says none when no level was substantiated', () => {
    expect(renderReport(report([caseResult()]))).toContain('- Level substantiated: none');
  });

  it('writes one row per case, with a column per check', () => {
    const text = renderReport(
      report([
        caseResult({
          fixture: fixtureCase({ id: 'render/bar/simple' }),
          checks: [
            { check: 'parse', status: 'pass' },
            { check: 'render', status: 'skip', reason: 'no visual blocks' },
          ],
        }),
      ]),
    );

    expect(text).toContain('| `render/bar/simple` | 1 | pass |');
  });

  it('marks a check the case never ran as absent, which is not the same as skipped', () => {
    const text = renderReport(
      report([
        caseResult({
          checks: [
            { check: 'parse', status: 'pass' },
            { check: 'render', status: 'skip', reason: 'no visual blocks' },
          ],
        }),
      ]),
    );
    const row = text.split('\n').find((line) => line.includes('`render/bar/simple`')) ?? '';
    // `| id | level | status | parse | round-trip | … |`, split on the pipes.
    const cells = row
      .split('|')
      .slice(4, -1)
      .map((cell) => cell.trim());

    expect(cells[0]).toBe('✓'); // parse ran and passed
    expect(cells[5]).toBe('–'); // render ran and skipped
    expect(cells[3]).toBe(''); // ast never ran at all
  });

  it('says so plainly when there were no cases at all', () => {
    expect(renderReport(report([]))).toContain('_No cases._');
  });

  it('quotes a failure in full underneath, since the table only has room for a mark', () => {
    const text = renderReport(
      report([
        caseResult({
          fixture: fixtureCase({ id: 'render/bar/broken' }),
          status: 'fail',
          checks: [
            {
              check: 'ast',
              status: 'fail',
              reason: 'output does not match the golden',
              detail: 'first difference at line 3 of 9\n- want\n+ got',
            },
          ],
        }),
      ]),
    );

    expect(text).toContain('## Failures');
    expect(text).toContain('### `render/bar/broken`');
    expect(text).toContain('**ast** — output does not match the golden');
    expect(text).toContain('```\nfirst difference at line 3 of 9\n- want\n+ got\n```');
  });

  it('keeps the failures section out of a passing report', () => {
    expect(renderReport(report([caseResult()]))).not.toContain('## Failures');
  });

  it('lists corpus issues, which are not case failures', () => {
    const text = renderReport(
      report([], 1, [{ path: 'render/bar', message: 'unreadable meta.json' }]),
    );

    expect(text).toContain('## Corpus issues');
    expect(text).toContain('- `render/bar` — unreadable meta.json');
  });

  it('names the requirements nothing reached, which is the point of the coverage table', () => {
    const text = renderReport(report([caseResult({ covered: [L1[0]] })], 1));

    expect(text).toContain('## Coverage');
    // The label rides along with the id: a reader should not need `levels.json`.
    expect(text).toContain('| `syntax.frontmatter` Front matter | 1 | 3.4 | `render/bar/simple` |');
    expect(text).toContain('| `syntax.base` Base syntax | 1 | 4 | **none** |');
    expect(text).toContain('21 requirements up to level 1 are not substantiated by a passing case');
    expect(text).toContain('- `syntax.base` — Base syntax');
  });

  it('says nothing about gaps when there are none', () => {
    const ids = buildReport(corpusOf([]), [], 1).coverage.map((row) => row.requirement.id);
    const text = renderReport(report([caseResult({ covered: ids })], 1));

    expect(text).not.toContain('not substantiated by a passing case');
  });

  it('agrees with itself in singular', () => {
    const all = buildReport(corpusOf([]), [], 1).coverage.map((row) => row.requirement.id);
    const text = renderReport(report([caseResult({ covered: all.slice(1) })], 1));

    expect(text).toContain('1 requirement up to level 1 is not substantiated by a passing case');
  });

  it('ends with exactly one trailing newline, so the file is diffable', () => {
    const text = renderReport(report([caseResult()]));

    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('renders the same bytes twice, which is what lets CONFORMANCE.md be committed', () => {
    const results = [caseResult({ covered: [L1[0]] }), caseResult({ status: 'skip', checks: [] })];

    expect(renderReport(report(results))).toBe(renderReport(report(results)));
  });
});
