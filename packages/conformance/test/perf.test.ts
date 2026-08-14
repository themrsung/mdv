/**
 * The perf harness (SPEC 24.1).
 *
 * A perf suite cannot assert timings — a number measured on a loaded CI runner
 * is not a fact about this build — so nothing here asserts a duration. What it
 * asserts is everything a timing depends on and that a slow machine cannot
 * change: that a `budget.json` is validated rather than trusted, that growing a
 * fixture really produces the document the spec row names (a "1 MB parse"
 * measured over 4 KB is the failure this file exists to catch), that the timed
 * region excludes setup, and that the committed corpus still covers all nine
 * document rows of the SPEC 24.1 table.
 */

import { fileURLToPath } from 'node:url';

import { resolve as resolveDoc, parse } from '@mdv/core';
import { describe, expect, it } from 'vitest';

import { loadCorpus } from '../src/corpus.js';
import {
  MEASURED_RUNS,
  PERF_OPERATIONS,
  TOLERANCE,
  WARMUP_RUNS,
  growRows,
  measure,
  measureCase,
  median,
  perfCasesOf,
  readBudget,
  renderPerfReport,
  repeatBody,
  shapeSource,
  splitFrontMatter,
  verdictOf,
} from '../src/perf.js';
import type { Measurement, PerfBudget, PerfHost } from '../src/perf.js';
import { conformanceConfig } from '../src/run.js';
import { tempCorpus } from './harness.js';

/** The committed corpus, by path rather than by cwd. */
const CORPUS_ROOT = fileURLToPath(new URL('../../spec/tests', import.meta.url));

const BUDGET: PerfBudget = {
  operation: 'parse',
  spec: 'Parse 100 KB document (≈50 blocks)',
  budget: 30,
};

const ONE_BLOCK = `---
mdv: "1.0"
title: Perf fixture
---

# Heading

\`\`\`mdv line
x: month
y: revenue
---
month,revenue
2024-01,100
2024-02,140
\`\`\`
`;

/** The host row is furniture; every report test needs one and none is about it. */
const HOST: PerfHost = {
  cpu: 'Test CPU',
  cores: 4,
  memoryGb: 16,
  platform: 'Test 0.0',
  arch: 'x64',
  runtime: 'Node test',
};

function measurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    id: 'perf/parse-100kb',
    spec: 'Parse 100 KB document (≈50 blocks)',
    budget: 30,
    measured: 12.5,
    unit: 'ms',
    shape: '101 KB, 50 blocks',
    runs: MEASURED_RUNS,
    verdict: 'pass',
    ...overrides,
  };
}

/** Rows of the first visual block, after the shaping a budget asks for. */
async function rowsOf(source: string): Promise<number> {
  const doc = await resolveDoc(parse(source), conformanceConfig(1));
  const block = doc.blocks[0];
  if (block === undefined) throw new Error('no visual block');
  return block.table.rows.length;
}

async function blocksOf(source: string): Promise<number> {
  const doc = await resolveDoc(parse(source), conformanceConfig(1));
  return doc.blocks.length;
}

describe('readBudget', () => {
  it('accepts a well-formed budget', () => {
    const { budget, errors } = readBudget({
      operation: 'parse',
      spec: 'Parse 1 MB document',
      budget: 250,
      repeat: 500,
      rows: 60,
      note: 'stage 1 only',
    });
    expect(errors).toEqual([]);
    expect(budget).toEqual({
      operation: 'parse',
      spec: 'Parse 1 MB document',
      budget: 250,
      repeat: 500,
      rows: 60,
      note: 'stage 1 only',
    });
  });

  it('omits the optional keys rather than defaulting them', () => {
    const { budget } = readBudget({ operation: 'parse', spec: 'Parse', budget: 30 });
    expect(budget).toEqual({ operation: 'parse', spec: 'Parse', budget: 30 });
    expect(Object.keys(budget ?? {})).not.toContain('repeat');
  });

  it('rejects a body that is not an object', () => {
    expect(readBudget([]).errors).toHaveLength(1);
    expect(readBudget(null).budget).toBeUndefined();
  });

  it('reports every problem at once', () => {
    const { budget, errors } = readBudget({
      operation: 'render',
      spec: '',
      budget: -1,
      repeat: 0,
      rows: 1.5,
      note: 7,
      extra: true,
    });
    expect(budget).toBeUndefined();
    expect(errors).toHaveLength(7);
    expect(errors.join('\n')).toContain('unknown key "extra"');
  });

  it('names the operations it will accept', () => {
    const { errors } = readBudget({ operation: 'sprint', spec: 'x', budget: 1 });
    for (const operation of PERF_OPERATIONS) expect(errors.join('\n')).toContain(operation);
  });
});

describe('splitFrontMatter', () => {
  it('splits a document at its closing separator', () => {
    const { front, body } = splitFrontMatter(ONE_BLOCK);
    expect(front).toContain('mdv: "1.0"');
    expect(body.startsWith('\n# Heading')).toBe(true);
  });

  it('leaves a document with no front matter alone', () => {
    const source = '# Heading\n\nBody.\n';
    expect(splitFrontMatter(source)).toEqual({ front: '', body: source });
  });

  it('does not treat a separator inside a fence as front matter', () => {
    const source = '```mdv bar\nx: a\n---\na,b\n1,2\n```\n';
    expect(splitFrontMatter(source).front).toBe('');
  });
});

describe('repeatBody', () => {
  it('is the identity at one', () => {
    expect(repeatBody(ONE_BLOCK, 1)).toBe(ONE_BLOCK);
  });

  it('repeats the body without repeating the front matter', () => {
    const grown = repeatBody(ONE_BLOCK, 3);
    expect(grown.match(/^mdv: "1\.0"$/gm)).toHaveLength(1);
    expect(grown.match(/^```mdv line$/gm)).toHaveLength(3);
  });

  it('produces a document the parser reads as that many blocks', async () => {
    await expect(blocksOf(repeatBody(ONE_BLOCK, 50))).resolves.toBe(50);
  });

  it('keeps block ids distinct so resolution does not collapse them', async () => {
    const doc = await resolveDoc(parse(repeatBody(ONE_BLOCK, 4)), conformanceConfig(1));
    expect(new Set(doc.blocks.map((block) => block.id)).size).toBe(4);
  });
});

describe('growRows', () => {
  it('grows the data section to the asked-for row count', async () => {
    await expect(rowsOf(growRows(ONE_BLOCK, 1000))).resolves.toBe(1000);
  });

  it('is deterministic (SPEC 24.3): the same growth twice is the same bytes', () => {
    expect(growRows(ONE_BLOCK, 500)).toBe(growRows(ONE_BLOCK, 500));
  });

  it('keeps the header row, and grows a categorical column from its own values', () => {
    const grown = growRows(ONE_BLOCK, 50);
    expect(grown).toContain('month,revenue');
    expect(grown).toContain('\n2024-01,');
    expect(grown).toContain('\n2024-02,');
    expect(grown).not.toContain('2024-03');
  });

  it('keeps a numeric column inside the range the sample gave it', () => {
    for (const line of growRows(ONE_BLOCK, 200).split('\n')) {
      const match = /^2024-\d\d,(\d+)$/.exec(line);
      if (match === null) continue;
      expect(Number(match[1])).toBeGreaterThanOrEqual(100);
      expect(Number(match[1])).toBeLessThanOrEqual(140);
    }
  });

  it('leaves a document with no data section alone', () => {
    const prose = '# Heading\n\nNothing to grow.\n';
    expect(growRows(prose, 100)).toBe(prose);
  });
});

describe('shapeSource', () => {
  it('grows rows before repeating blocks, so every block is the grown one', async () => {
    const shaped = shapeSource(ONE_BLOCK, { ...BUDGET, rows: 60, repeat: 10 });
    await expect(blocksOf(shaped)).resolves.toBe(10);
    await expect(rowsOf(shaped)).resolves.toBe(60);
  });

  it('is the source itself when the budget asks for no shaping', () => {
    expect(shapeSource(ONE_BLOCK, BUDGET)).toBe(ONE_BLOCK);
  });
});

describe('measure', () => {
  it('times the body and not the setup, and drops the warm-up runs', async () => {
    let setups = 0;
    let bodies = 0;
    const samples = await measure(
      {
        setup(): number {
          setups += 1;
          return setups;
        },
        body(): void {
          bodies += 1;
        },
      },
      5,
      2,
    );
    expect(samples).toHaveLength(5);
    expect(setups).toBe(7);
    expect(bodies).toBe(7);
    for (const sample of samples) expect(sample).toBeGreaterThanOrEqual(0);
  });

  it('gives each run its own state, because resolve mutates the document', async () => {
    const seen: number[] = [];
    let next = 0;
    await measure(
      {
        setup: (): number => (next += 1),
        body: (state: number): void => void seen.push(state),
      },
      3,
      0,
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('defaults to the runs SPEC 24.1 asks for', () => {
    expect(MEASURED_RUNS).toBe(20);
    expect(WARMUP_RUNS).toBeGreaterThan(0);
  });
});

describe('median', () => {
  it('averages the two middle values of an even sample', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('takes the middle value of an odd sample', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it('is NaN for no samples rather than zero', () => {
    expect(median([])).toBeNaN();
  });
});

describe('verdictOf', () => {
  it('passes under budget and at it', () => {
    expect(verdictOf(29, 30)).toBe('pass');
    expect(verdictOf(30, 30)).toBe('pass');
  });

  it('is over inside the SPEC 24.1 tolerance', () => {
    expect(verdictOf(30 * (1 + TOLERANCE), 30)).toBe('over');
  });

  it('fails beyond it', () => {
    expect(verdictOf(30 * (1 + TOLERANCE) + 0.01, 30)).toBe('fail');
  });
});

describe('perfCasesOf', () => {
  it('reads the budget of every perf case and ignores the other categories', async () => {
    const corpus = await tempCorpus();
    try {
      await corpus.addCase('perf/parse-small', {
        source: ONE_BLOCK,
        files: { 'budget.json': JSON.stringify({ ...BUDGET, repeat: 4 }) },
      });
      await corpus.addCase('render/bar/simple');
      const { cases, issues } = await perfCasesOf(await loadCorpus(corpus.root));
      expect(issues).toEqual([]);
      expect(cases.map((input) => input.id)).toEqual(['perf/parse-small']);
      expect(cases[0]?.budget.repeat).toBe(4);
      expect(cases[0]?.level).toBe(1);
    } finally {
      await corpus.cleanup();
    }
  });

  it('reports a perf case that ships no budget rather than skipping it', async () => {
    const corpus = await tempCorpus();
    try {
      await corpus.addCase('perf/unbudgeted', { source: ONE_BLOCK });
      const { cases, issues } = await perfCasesOf(await loadCorpus(corpus.root));
      expect(cases).toEqual([]);
      expect(issues).toEqual(['perf/unbudgeted: a perf case must ship budget.json (SPEC 24.1)']);
    } finally {
      await corpus.cleanup();
    }
  });

  it('reports a budget that is not JSON, and one that is invalid', async () => {
    const corpus = await tempCorpus();
    try {
      await corpus.addCase('perf/broken-json', {
        source: ONE_BLOCK,
        files: { 'budget.json': '{' },
      });
      await corpus.addCase('perf/broken-budget', {
        source: ONE_BLOCK,
        files: { 'budget.json': JSON.stringify({ operation: 'parse' }) },
      });
      const { cases, issues } = await perfCasesOf(await loadCorpus(corpus.root));
      expect(cases).toEqual([]);
      expect(
        issues.some((issue) => issue.startsWith('perf/broken-json: budget.json is not JSON')),
      ).toBe(true);
      expect(issues.some((issue) => issue.startsWith('perf/broken-budget:'))).toBe(true);
    } finally {
      await corpus.cleanup();
    }
  });
});

describe('the committed corpus (SPEC 24.1)', () => {
  it('carries a valid budget on every perf case', async () => {
    const { cases, issues } = await perfCasesOf(await loadCorpus(CORPUS_ROOT));
    expect(issues).toEqual([]);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('covers all nine document rows of the budget table', async () => {
    const { cases } = await perfCasesOf(await loadCorpus(CORPUS_ROOT));
    const operations = cases.map((input) => input.budget.operation);
    for (const operation of PERF_OPERATIONS) expect(operations).toContain(operation);
    // Two rows share the `parse` operation: 100 KB and 1 MB.
    expect(cases).toHaveLength(PERF_OPERATIONS.length + 1);
  });

  /** What each row's own wording claims about the document it is measured on. */
  const CLAIMS: Readonly<Record<string, { bytes?: number; blocks?: number; rows?: number }>> = {
    'perf/parse-100kb': { bytes: 100 * 1024, blocks: 50 },
    'perf/parse-1mb': { bytes: 1024 * 1024 },
    'perf/first-chart-50-blocks': { blocks: 50 },
    'perf/resize-20-blocks': { blocks: 20 },
    'perf/pdf-50-pages': { blocks: 40 },
    'perf/line-1000-rows': { rows: 1000 },
    'perf/scatter-10000-points': { rows: 10000 },
    'perf/interaction-frame': { rows: 600 },
    'perf/incremental-attr': { rows: 60 },
  };

  it.each(Object.entries(CLAIMS))(
    'grows %s to the shape its row names',
    async (id, claim) => {
      const { cases } = await perfCasesOf(await loadCorpus(CORPUS_ROOT));
      const input = cases.find((entry) => entry.id === id);
      expect(input).toBeDefined();
      const shaped = shapeSource(
        (input as NonNullable<typeof input>).source,
        (input as NonNullable<typeof input>).budget,
      );
      if (claim.bytes !== undefined) {
        expect(Buffer.byteLength(shaped, 'utf8')).toBeGreaterThanOrEqual(claim.bytes);
      }
      if (claim.blocks !== undefined) await expect(blocksOf(shaped)).resolves.toBe(claim.blocks);
      if (claim.rows !== undefined) await expect(rowsOf(shaped)).resolves.toBe(claim.rows);
    },
    20_000,
  );

  it('names a fixture for every row, and a row for every fixture', async () => {
    const { cases } = await perfCasesOf(await loadCorpus(CORPUS_ROOT));
    expect(cases.map((input) => input.id).sort()).toEqual(Object.keys(CLAIMS).sort());
  });

  it('measures a case end to end, in the unit its budget is written in', async () => {
    const { cases } = await perfCasesOf(await loadCorpus(CORPUS_ROOT));
    const input = cases.find((entry) => entry.budget.operation === 'prepare-encode-layout');
    expect(input).toBeDefined();
    const row = await measureCase(input as NonNullable<typeof input>, { runs: 1, warmup: 0 });
    expect(row.unit).toBe('ms');
    expect(row.runs).toBe(1);
    expect(Number.isFinite(row.measured)).toBe(true);
    expect(row.measured).toBeGreaterThan(0);
    expect(row.spec).toBe(input?.budget.spec);
    expect(row.shape).toContain('1,000 rows');
    expect(['pass', 'over', 'fail']).toContain(row.verdict);
  });
});

describe('renderPerfReport', () => {
  it('writes one table row per measurement, quoting the spec cell', () => {
    const text = renderPerfReport([measurement()], HOST);
    expect(text).toContain('| Operation (SPEC 24.1) | Measured shape | Budget | Median | Verdict |');
    expect(text).toContain(
      '| Parse 100 KB document (≈50 blocks) | 101 KB, 50 blocks | ≤ 30 ms | 12.50 ms | within budget |',
    );
  });

  it('says how many budgets hold, and how many fail', () => {
    expect(renderPerfReport([measurement()], HOST)).toContain('All 1 budgets hold.');
    expect(renderPerfReport([measurement({ verdict: 'fail' })], HOST)).toContain(
      '**1 of 1 budgets fail.**',
    );
    expect(renderPerfReport([measurement({ verdict: 'over' })], HOST)).toContain(
      'inside the tolerance only',
    );
  });

  it('reports the runs the rows were measured over, not the runs the spec asks for', () => {
    expect(renderPerfReport([measurement({ runs: 3 })], HOST)).toContain('the median of 3 timed');
    expect(renderPerfReport([measurement()], HOST)).toContain(
      `the median of ${String(MEASURED_RUNS)} timed`,
    );
  });

  it('claims no more than its weakest row, and ignores the untimed rows', () => {
    const mixed = [measurement({ runs: 20 }), measurement({ id: 'perf/pdf-50-pages', runs: 4 })];
    expect(renderPerfReport(mixed, HOST)).toContain('the median of 4 timed');
    const bundleOnly = [measurement({ unit: 'KB', runs: 1, budget: 65, measured: 41.27 })];
    expect(renderPerfReport(bundleOnly, HOST)).toContain(
      `the median of ${String(MEASURED_RUNS)} timed`,
    );
  });

  it('prints seconds for a budget written in seconds, and KB for a bundle', () => {
    const pdf = measurement({ budget: 3000, measured: 1234.4 });
    expect(renderPerfReport([pdf], HOST)).toContain('| ≤ 3 s | 1234 ms |');
    const bundle = measurement({ unit: 'KB', budget: 65, measured: 41.27, runs: 1 });
    expect(renderPerfReport([bundle], HOST)).toContain('| ≤ 65 KB | 41.3 KB |');
  });

  it('lists every substitution under its own heading', () => {
    const noted = measurement({ note: 'measured through the SVG backend; there is no canvas yet.' });
    const text = renderPerfReport([noted], HOST);
    expect(text).toContain('## What these numbers leave out');
    expect(text).toContain('there is no canvas yet.');
    expect(renderPerfReport([measurement()], HOST)).not.toContain('## What these numbers leave out');
  });

  it('names the host the numbers came from', () => {
    const text = renderPerfReport([measurement()], HOST);
    expect(text).toContain('- **CPU** — Test CPU (4 cores)');
    expect(text).toContain('- **Runtime** — Node test');
  });

  it('escapes a pipe in a spec cell rather than breaking the table', () => {
    const text = renderPerfReport([measurement({ spec: 'a | b' })], HOST);
    expect(text).toContain('| a \\| b |');
  });

  it('lists the case behind every row', () => {
    expect(renderPerfReport([measurement()], HOST)).toContain(
      '- `perf/parse-100kb` — Parse 100 KB document (≈50 blocks) (20 runs)',
    );
  });
});
