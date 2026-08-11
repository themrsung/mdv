/**
 * `mdv-conformance` — run the corpus, write the report, exit with the verdict.
 *
 * Everything the command does is a call into the library; what it adds is the
 * argument table, the exit code, and the decision of where the bytes go. It
 * takes its world as a parameter ({@link ConformanceIo}) and returns a code
 * rather than calling `process.exit`, so the whole command is testable in
 * process — the binary in `bin.ts` is the only part that touches `process`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { ConformanceLevel } from '@mdv/spec';

import { DEFAULT_ROOT, loadCorpus } from './corpus.js';
import { buildReport, renderReport } from './report.js';
import { runCorpus } from './run.js';
import type { ConformanceReport } from './types.js';
import { updateCorpus } from './update.js';
import type { GoldenWrite, UpdateOptions, UpdateReport } from './update.js';

/** Where a stream of text goes. */
export interface TextSink {
  write(chunk: string): void;
}

/** The world the command runs in. */
export interface ConformanceIo {
  readonly stdout: TextSink;
  readonly stderr: TextSink;
  readonly cwd: string;
}

/**
 * Exit codes. Part of the contract with CI: changing one is a breaking change.
 */
export const EXIT_CODES = Object.freeze({
  /** The corpus is sound and every check that ran passed. */
  ok: 0,
  /** A check failed, or the corpus itself is malformed. */
  failed: 1,
  /** The invocation was wrong. */
  usage: 2,
  /** The report could not be written. */
  io: 3,
});

const OPTIONS = {
  root: { type: 'string' },
  out: { type: 'string', short: 'o' },
  level: { type: 'string' },
  json: { type: 'boolean' },
  tag: { type: 'string', multiple: true },
  'no-pdf': { type: 'boolean' },
  update: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} as const;

const USAGE = `mdv-conformance — run the MDV fixture corpus (SPEC 16.2)

Usage: mdv-conformance [options]

Options:
      --root <dir>   Corpus root (default: ${DEFAULT_ROOT})
  -o, --out <file>   Write the Markdown report here (default: stdout)
      --level <1|2|3>  Substantiate this level; cases above it are skipped
      --json         Emit the report as JSON instead of Markdown
      --tag <tag>    Only cases carrying this tag. Repeatable.
      --no-pdf       Skip the PDF checks
      --update       Mint the goldens each case asks for instead of checking them
      --dry-run      With --update: list what would change, write nothing
  -q, --quiet        Do not print the one-line summary to stderr
  -h, --help         Show this message

Exit codes: 0 pass, 1 failed check or corpus issue, 2 usage, 3 I/O.
`;

/**
 * Run the command.
 *
 * A coverage gap is reported but does not fail the run: the corpus not yet
 * reaching a requirement is a fact about the corpus, and a build should not go
 * red for it. A *failed* check, or a corpus that could not be read, does.
 */
export async function main(argv: readonly string[], io: ConformanceIo): Promise<number> {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values'];
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: false }));
  } catch (error) {
    io.stderr.write(`${errorText(error)}\n\n${USAGE}`);
    return EXIT_CODES.usage;
  }

  if (values.help === true) {
    io.stdout.write(USAGE);
    return EXIT_CODES.ok;
  }

  const level = readLevel(values.level);
  if (level === 'bad') {
    io.stderr.write(`--level must be 1, 2 or 3, got ${JSON.stringify(values.level)}\n`);
    return EXIT_CODES.usage;
  }

  const selection: UpdateOptions = {
    ...(level === undefined ? {} : { level }),
    ...(values.tag === undefined ? {} : { tags: values.tag }),
    ...(values['no-pdf'] === true ? { pdf: false } : {}),
  };
  const root = resolve(io.cwd, values.root ?? DEFAULT_ROOT);

  if (values.update === true) {
    // A report is a statement about goldens; minting them is what makes the
    // statement true. Writing both in one command would report on the corpus
    // this run had just rewritten, which says nothing.
    if (values.out !== undefined || values.json === true) {
      io.stderr.write('--update writes goldens, not a report: drop --out and --json\n');
      return EXIT_CODES.usage;
    }
    const dryRun = values['dry-run'] === true;
    return update(root, { ...selection, ...(dryRun ? { dryRun } : {}) }, io, values.quiet === true);
  }
  if (values['dry-run'] === true) {
    io.stderr.write('--dry-run only means something with --update\n');
    return EXIT_CODES.usage;
  }

  const corpus = await loadCorpus(root);
  const results = await runCorpus(corpus, selection);
  const report = buildReport(corpus, results, level ?? 3);

  const text =
    values.json === true ? `${JSON.stringify(report, replacer, 2)}\n` : renderReport(report);
  const out = values.out;
  if (out === undefined) {
    io.stdout.write(text);
  } else {
    const path = isAbsolute(out) ? out : resolve(io.cwd, out);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    } catch (error) {
      io.stderr.write(`cannot write ${out}: ${errorText(error)}\n`);
      return EXIT_CODES.io;
    }
  }

  if (values.quiet !== true) io.stderr.write(summary(report));
  return report.ok ? EXIT_CODES.ok : EXIT_CODES.failed;
}

/**
 * `--update`: mint the goldens and say which files moved.
 *
 * Only the files that changed are listed. A corpus already in step prints
 * nothing at all, which is the right answer from a command whose job is to be
 * run before committing — the output *is* the diff you are about to make.
 */
async function update(
  root: string,
  options: UpdateOptions,
  io: ConformanceIo,
  quiet: boolean,
): Promise<number> {
  let report: UpdateReport;
  try {
    report = await updateCorpus(root, options);
  } catch (error) {
    io.stderr.write(`cannot update ${root}: ${errorText(error)}\n`);
    return EXIT_CODES.io;
  }
  for (const write of report.writes) {
    if (write.status !== 'unchanged') io.stdout.write(`${write.status.padEnd(7)} ${write.path}\n`);
  }
  for (const issue of report.issues) {
    io.stderr.write(`corpus: ${issue.path === '' ? '.' : issue.path}: ${issue.message}\n`);
  }
  for (const failure of report.failures) {
    io.stderr.write(`${failure.case}: ${failure.stage} failed, left alone: ${failure.reason}\n`);
  }
  if (!quiet) io.stderr.write(updateSummary(report, options.dryRun === true));
  return report.ok ? EXIT_CODES.ok : EXIT_CODES.failed;
}

/** One line for the same human, in the same place as {@link summary}. */
function updateSummary(report: UpdateReport, dryRun: boolean): string {
  const count = (status: GoldenWrite['status']): number =>
    report.writes.filter((write) => write.status === status).length;
  const parts = [
    `${count('created')} created`,
    `${count('updated')} updated`,
    `${count('unchanged')} unchanged`,
  ];
  if (report.failures.length > 0) parts.push(`${report.failures.length} could not be minted`);
  if (report.issues.length > 0) parts.push(`${report.issues.length} corpus issues`);
  return `${parts.join(', ')}${dryRun ? ' — dry run, nothing written' : ''}\n`;
}

/**
 * `fixture.dir` is an absolute path, and a report that embeds one is a report
 * that differs between two machines that agree about everything that matters.
 * The id says the same thing, relative to the root the report already names.
 */
function replacer(key: string, value: unknown): unknown {
  return key === 'dir' ? undefined : value;
}

/** `undefined` for "not given", `'bad'` for "given and not a level". */
function readLevel(raw: string | undefined): ConformanceLevel | 'bad' | undefined {
  if (raw === undefined) return undefined;
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  if (raw === '3') return 3;
  return 'bad';
}

/** One line for a human watching the build, on stderr so `--out -` stays clean. */
function summary(report: ConformanceReport): string {
  const t = report.totals;
  const gaps = report.coverage.filter((row) => row.cases.length === 0).length;
  const parts = [
    `${t.cases} case${t.cases === 1 ? '' : 's'}`,
    `${t.passed} passed`,
    `${t.failed} failed`,
    `${t.skipped} skipped`,
    `${t.checksFailed}/${t.checks} checks failed`,
  ];
  if (report.issues.length > 0) parts.push(`${report.issues.length} corpus issues`);
  if (gaps > 0) parts.push(`${gaps} uncovered requirements`);
  const level =
    report.substantiated === undefined
      ? 'no level substantiated'
      : `level ${report.substantiated} substantiated`;
  return `${parts.join(', ')} — ${level}\n`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
