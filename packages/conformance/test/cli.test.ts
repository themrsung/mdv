/**
 * The command (SPEC 16.3): arguments in, a report and an exit code out.
 *
 * `main(argv, io)` is called in process against a corpus built under `mkdtemp`,
 * which is the whole reason it takes an {@link ConformanceIo} and returns a
 * number instead of calling `process.exit`. What is under test is the argument
 * table, where the bytes go, and the code CI reads — never the renderer.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_CODES, main } from '../src/cli.js';
import { GOLDEN_FILES } from '../src/corpus.js';
import type { ConformanceReport } from '../src/types.js';

import { BAR_CASE, PROSE_CASE, tempCorpus, type TempCorpus } from './harness.js';

let corpus: TempCorpus | undefined;

afterEach(async () => {
  await corpus?.cleanup();
  corpus = undefined;
});

/** A corpus root with one passing case, unless `cases` says otherwise. */
async function fresh(): Promise<TempCorpus> {
  corpus = await tempCorpus();
  return corpus;
}

/** Run against `--root <temp root>`, which is where every test's corpus lives. */
async function run(temp: TempCorpus, ...argv: readonly string[]): Promise<number> {
  return main(['--root', temp.root, ...argv], temp.io);
}

/** The JSON a `--json` run wrote to stdout. */
function parsed(text: string): ConformanceReport {
  return JSON.parse(text) as ConformanceReport;
}

describe('exit codes', () => {
  it('freezes the contract with CI, because changing one is a breaking change', () => {
    expect(EXIT_CODES).toEqual({ ok: 0, failed: 1, usage: 2, io: 3 });
    expect(Object.isFrozen(EXIT_CODES)).toBe(true);
  });

  it('is 0 when every check that ran passed', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');

    expect(await run(temp)).toBe(EXIT_CODES.ok);
  });

  it('is 1 when a check failed', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple', {
      files: { [GOLDEN_FILES.ast]: '{"type":"not the ast"}\n' },
    });

    expect(await run(temp)).toBe(EXIT_CODES.failed);
  });

  it('is 1 when the corpus is broken, however well its cases ran', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await temp.write('not-a-category/case/input.mdv', BAR_CASE);

    expect(await run(temp)).toBe(EXIT_CODES.failed);
  });

  it('is 1, not a crash, when the root does not exist', async () => {
    const temp = await fresh();
    const code = await main(['--root', join(temp.root, 'nowhere'), '--json'], temp.io);

    expect(code).toBe(EXIT_CODES.failed);
    expect(parsed(temp.io.out).issues[0]?.message).toContain('cannot read corpus root');
  });

  it('is 0 for an empty corpus: nothing failed, and nothing is claimed', async () => {
    const temp = await fresh();

    expect(await run(temp, '--json')).toBe(EXIT_CODES.ok);
    expect(parsed(temp.io.out).substantiated).toBeUndefined();
  });
});

describe('usage', () => {
  it('prints the usage to stdout and succeeds when asked for help', async () => {
    const temp = await fresh();
    const code = await main(['--help'], temp.io);

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.out).toContain('Usage: mdv-conformance');
    expect(temp.io.out).toContain('--root <dir>');
    expect(temp.io.err).toBe('');
  });

  it('does not run the corpus when asked for help', async () => {
    const temp = await fresh();
    await main(['--root', join(temp.root, 'nowhere'), '--help'], temp.io);

    expect(temp.io.out).not.toContain('# MDV conformance report');
  });

  it('rejects an unknown option, with the usage to say what it takes instead', async () => {
    const temp = await fresh();
    const code = await main(['--nope'], temp.io);

    expect(code).toBe(EXIT_CODES.usage);
    expect(temp.io.err).toContain('--nope');
    expect(temp.io.err).toContain('Usage: mdv-conformance');
    expect(temp.io.out).toBe('');
  });

  it('rejects a positional, which is always a mistyped flag', async () => {
    const temp = await fresh();

    expect(await main(['corpus'], temp.io)).toBe(EXIT_CODES.usage);
  });

  it('rejects a level that is not a level, and names what it got', async () => {
    const temp = await fresh();
    const code = await run(temp, '--level', '4');

    expect(code).toBe(EXIT_CODES.usage);
    expect(temp.io.err).toContain('--level must be 1, 2 or 3, got "4"');
  });

  it('rejects a level that is not a number at all', async () => {
    const temp = await fresh();

    expect(await run(temp, '--level', 'core')).toBe(EXIT_CODES.usage);
  });
});

describe('--root', () => {
  it('resolves a relative root against the working directory, not the process one', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    const code = await main(['--root', 'render', '--json'], temp.io);

    // `render` under the temp root is not a category, so resolving it against
    // `io.cwd` is visible in the issue the load reports.
    expect(code).toBe(EXIT_CODES.failed);
    expect(parsed(temp.io.out).root).toBe(join(temp.root, 'render'));
  });

  it('defaults to the corpus in the repository', async () => {
    const temp = await fresh();
    // The default is relative, so a corpus at that path under `cwd` is found.
    await temp.write(`packages/spec/tests/syntax/prose/input.mdv`, PROSE_CASE);
    await temp.write(`packages/spec/tests/syntax/prose/meta.json`, '{"level":1}\n');
    const code = await main(['--json'], temp.io);

    expect(code).toBe(EXIT_CODES.ok);
    expect(parsed(temp.io.out).results.map((result) => result.fixture.id)).toEqual([
      'syntax/prose',
    ]);
  });
});

describe('--out', () => {
  it('writes the report to the file and leaves stdout clean', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    const code = await run(temp, '--out', 'report/CONFORMANCE.md');

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.out).toBe('');
    // The parent directory did not exist: the command made it.
    const written = await readFile(join(temp.root, 'report/CONFORMANCE.md'), 'utf8');
    expect(written).toContain('# MDV conformance report');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('honours an absolute path as given', async () => {
    const temp = await fresh();
    const path = join(temp.root, 'elsewhere', 'report.md');
    await run(temp, '--out', path);

    expect(await readFile(path, 'utf8')).toContain('# MDV conformance report');
  });

  it('writes JSON when asked for JSON', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp, '--json', '--out', 'report.json');
    const written = await readFile(join(temp.root, 'report.json'), 'utf8');

    expect(parsed(written).specVersion).toBe('1.0-draft.1');
  });

  it('exits 3 when the report cannot be written, and says which path', async () => {
    const temp = await fresh();
    await writeFile(join(temp.root, 'blocker'), 'not a directory\n', 'utf8');
    const code = await run(temp, '--out', 'blocker/report.md');

    expect(code).toBe(EXIT_CODES.io);
    expect(temp.io.err).toContain('cannot write blocker/report.md');
  });

  it('reports an I/O failure rather than the verdict, even when the run passed', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await writeFile(join(temp.root, 'blocker'), '', 'utf8');

    expect(await run(temp, '--out', 'blocker/report.md')).not.toBe(EXIT_CODES.ok);
  });
});

describe('--json', () => {
  it('emits the report itself, not a rendering of it', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp, '--json');
    const report = parsed(temp.io.out);

    expect(report.specVersion).toBe('1.0-draft.1');
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.totals.cases).toBe(1);
  });

  it('drops the absolute case directory, which differs between two machines', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp, '--json');

    expect(temp.io.out).not.toContain('"dir"');
    expect(parsed(temp.io.out).results[0]?.fixture.id).toBe('render/bar/simple');
  });

  it('ends with a newline, so the stream is a line', async () => {
    const temp = await fresh();
    await run(temp, '--json');

    expect(temp.io.out.endsWith('\n')).toBe(true);
  });

  it('emits Markdown otherwise', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp);

    expect(temp.io.out.startsWith('# MDV conformance report\n')).toBe(true);
    expect(temp.io.out).toContain('| `render/bar/simple` | 1 | pass |');
  });
});

describe('--level', () => {
  it('is the level the report is written against', async () => {
    const temp = await fresh();
    await run(temp, '--level', '2', '--json');

    expect(parsed(temp.io.out).level).toBe(2);
  });

  it('reports against the top level when none was asked for, so gaps are visible', async () => {
    const temp = await fresh();
    await run(temp, '--json');

    expect(parsed(temp.io.out).level).toBe(3);
  });

  it('skips a case pinned above the level asked for', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await temp.addCase('data/map/world', { meta: { level: 3 }, source: PROSE_CASE });
    await run(temp, '--level', '1', '--json');
    const report = parsed(temp.io.out);

    expect(report.totals.skipped).toBe(1);
    expect(report.results.find((result) => result.fixture.id === 'data/map/world')?.reason).toBe(
      'level 3 case, run is level 1',
    );
  });
});

describe('--tag', () => {
  it('runs only the cases carrying the tag', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/tagged', { meta: { level: 1, tags: ['a11y'] } });
    await temp.addCase('render/bar/plain');
    await run(temp, '--tag', 'a11y', '--json');
    const report = parsed(temp.io.out);
    const passed = report.results.filter((result) => result.status === 'pass');

    expect(passed.map((result) => result.fixture.id)).toEqual(['render/bar/tagged']);
  });

  it('takes any of several tags, because the flag repeats', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/one', { meta: { level: 1, tags: ['a11y'] } });
    await temp.addCase('render/bar/two', { meta: { level: 1, tags: ['dark'] } });
    await run(temp, '--tag', 'a11y', '--tag', 'dark', '--json');
    const report = parsed(temp.io.out);

    expect(report.totals.passed).toBe(2);
    expect(report.totals.skipped).toBe(0);
  });
});

describe('--no-pdf', () => {
  it('skips the PDF check and says why, rather than passing it silently', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp, '--no-pdf', '--json');
    const checks = parsed(temp.io.out).results[0]?.checks ?? [];

    expect(checks.find((check) => check.check === 'pdf')).toEqual({
      check: 'pdf',
      status: 'skip',
      reason: 'pdf checks disabled',
    });
  });

  it('runs the PDF check when not asked to skip it', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp, '--json');
    const checks = parsed(temp.io.out).results[0]?.checks ?? [];

    expect(checks.find((check) => check.check === 'pdf')?.status).toBe('pass');
  });
});

describe('the summary line', () => {
  it('goes to stderr, so a piped report stays a report', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    await run(temp);

    expect(temp.io.err).toContain('1 case, 1 passed, 0 failed, 0 skipped');
    expect(temp.io.err.endsWith('\n')).toBe(true);
    expect(temp.io.out).not.toContain('1 case, 1 passed');
  });

  it('agrees with itself about plurals', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/one');
    await temp.addCase('render/bar/two');
    await run(temp);

    expect(temp.io.err).toContain('2 cases,');
  });

  it('says no level was substantiated when none was', async () => {
    const temp = await fresh();
    await run(temp);

    expect(temp.io.err).toContain('no level substantiated');
  });

  it('counts corpus issues, which no case failure would mention', async () => {
    const temp = await fresh();
    await temp.write('not-a-category/case/input.mdv', BAR_CASE);
    await run(temp);

    expect(temp.io.err).toContain('1 corpus issues');
  });

  it('counts the requirements nothing reached', async () => {
    const temp = await fresh();
    await run(temp, '--level', '1');

    expect(temp.io.err).toContain('22 uncovered requirements');
  });

  it('is suppressed by --quiet, and nothing else is', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple');
    const code = await run(temp, '--quiet');

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.err).toBe('');
    expect(temp.io.out).toContain('# MDV conformance report');
  });
});

describe('--update', () => {
  it('mints the goldens and names every file it touched', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple', { meta: { level: 1, pin: ['ast'] } });
    const code = await run(temp, '--update');

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.out).toBe('created render/bar/simple/expected.ast.json\n');
    expect(
      await readFile(join(temp.root, 'render/bar/simple', GOLDEN_FILES.ast), 'utf8'),
    ).toContain('"type"');
  });

  it('leaves a corpus already in step silent, because there is no diff to review', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple', { meta: { level: 1, pin: ['ast'] } });
    await run(temp, '--update');
    temp.io.out = '';
    const code = await run(temp, '--update');

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.out).toBe('');
  });

  it('says what it would write under --dry-run, and writes nothing', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple', { meta: { level: 1, pin: ['ast'] } });
    const code = await run(temp, '--update', '--dry-run');

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.out).toContain('created render/bar/simple/expected.ast.json');
    expect(temp.io.err).toContain('dry run, nothing written');
    await expect(
      readFile(join(temp.root, 'render/bar/simple', GOLDEN_FILES.ast), 'utf8'),
    ).rejects.toThrow();
  });

  it('is 1, and names the case, when a golden could not be minted', async () => {
    const temp = await fresh();
    await temp.addCase('a11y/prose/only', { meta: { level: 1, pin: ['svg'] }, source: PROSE_CASE });
    const code = await run(temp, '--update');

    expect(code).toBe(EXIT_CODES.failed);
    expect(temp.io.err).toContain('a11y/prose/only: render failed, left alone');
    expect(temp.io.err).toContain('1 could not be minted');
  });

  it('refuses to write a report in the same run that rewrote the corpus', async () => {
    const temp = await fresh();

    expect(await run(temp, '--update', '--json')).toBe(EXIT_CODES.usage);
    expect(await run(temp, '--update', '--out', join(temp.root, 'r.md'))).toBe(EXIT_CODES.usage);
    expect(temp.io.err).toContain('drop --out and --json');
    expect(temp.io.out).toBe('');
  });

  it('rejects --dry-run on a read-only run, where it would mean nothing', async () => {
    const temp = await fresh();
    const code = await run(temp, '--dry-run');

    expect(code).toBe(EXIT_CODES.usage);
    expect(temp.io.err).toContain('--dry-run only means something with --update');
  });

  it('honours the selection flags, so one case can be re-minted alone', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/one', { meta: { level: 1, tags: ['bar'], pin: ['ast'] } });
    await temp.addCase('render/bar/two', { meta: { level: 1, tags: ['line'], pin: ['ast'] } });
    await run(temp, '--update', '--tag', 'bar');

    expect(temp.io.out).toBe('created render/bar/one/expected.ast.json\n');
  });

  it('is suppressed by --quiet, except for the file list itself', async () => {
    const temp = await fresh();
    await temp.addCase('render/bar/simple', { meta: { level: 1, pin: ['ast'] } });
    const code = await run(temp, '--update', '--quiet');

    expect(code).toBe(EXIT_CODES.ok);
    expect(temp.io.err).toBe('');
    expect(temp.io.out).toContain('created render/bar/simple/expected.ast.json');
  });

  it('reports a corpus it cannot read exactly as a read-only run does', async () => {
    const temp = await fresh();
    const code = await main(['--root', join(temp.root, 'nowhere'), '--update'], temp.io);

    expect(code).toBe(EXIT_CODES.failed);
    expect(temp.io.err).toContain('cannot read corpus root');
    expect(temp.io.out).toBe('');
  });

  it('mints nothing when the corpus is unsound, and says which path is wrong', async () => {
    const temp = await fresh();
    await temp.write('not-a-category/case/input.mdv', BAR_CASE);
    const code = await run(temp, '--update');

    expect(code).toBe(EXIT_CODES.failed);
    expect(temp.io.err).toContain('corpus: not-a-category');
    expect(temp.io.err).toContain('1 corpus issues');
  });
});
