/**
 * Turning results into a report, and a report into Markdown (SPEC 16.3).
 *
 * The report is the artefact; the run is just how it was obtained. Everything
 * here is a pure function of {@link Corpus} and {@link CaseResult}[], so a
 * report can be rebuilt from stored results without re-running the corpus, and
 * two runs of the same build serialise byte-for-byte.
 */

import { CONFORMANCE_LEVELS, LEVEL_TABLE, levelName, requirementsUpTo } from '@mdv/spec';
import type { ConformanceLevel, LevelRequirement } from '@mdv/spec';

import { CHECK_ORDER } from './types.js';
import type {
  CaseResult,
  CheckName,
  ConformanceReport,
  Corpus,
  CoverageRow,
  Totals,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the report.
 *
 * Coverage counts only cases that passed: a requirement reached by a failing
 * case is not substantiated by it, and saying otherwise would let a broken
 * implementation claim a level. {@link CaseResult.covered} is already empty for
 * those, but the filter is here too because it is the rule, not an accident.
 */
export function buildReport(
  corpus: Corpus,
  results: readonly CaseResult[],
  level: ConformanceLevel,
): ConformanceReport {
  const reached = new Map<string, string[]>();
  for (const result of results) {
    if (result.status !== 'pass') continue;
    for (const id of result.covered) {
      const cases = reached.get(id);
      if (cases === undefined) reached.set(id, [result.fixture.id]);
      else cases.push(result.fixture.id);
    }
  }

  const coverage: CoverageRow[] = requirementsUpTo(level).map((requirement) => ({
    requirement,
    cases: [...(reached.get(requirement.id) ?? [])].sort(),
  }));

  const totals = totalsOf(results);
  const ok = totals.checksFailed === 0 && corpus.issues.length === 0;
  const substantiated = substantiatedLevel(reached);

  return {
    specVersion: LEVEL_TABLE.specVersion,
    level,
    root: corpus.root,
    results,
    issues: corpus.issues,
    coverage,
    totals,
    ...(substantiated === undefined ? {} : { substantiated }),
    ok,
  };
}

/** Cases and checks are counted separately — a case is not a check. */
function totalsOf(results: readonly CaseResult[]): Totals {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let checks = 0;
  let checksPassed = 0;
  let checksFailed = 0;
  let checksSkipped = 0;

  for (const result of results) {
    if (result.status === 'pass') passed++;
    else if (result.status === 'fail') failed++;
    else skipped++;

    for (const check of result.checks) {
      checks++;
      if (check.status === 'pass') checksPassed++;
      else if (check.status === 'fail') checksFailed++;
      else checksSkipped++;
    }
  }

  return {
    cases: results.length,
    passed,
    failed,
    skipped,
    checks,
    checksPassed,
    checksFailed,
    checksSkipped,
  };
}

/**
 * The highest level whose every requirement was reached by a passing case.
 *
 * Levels nest (SPEC 16.1), so this walks up and stops at the first gap: a hole
 * in level 1 is not repaired by a full level 2.
 */
function substantiatedLevel(
  reached: ReadonlyMap<string, readonly string[]>,
): ConformanceLevel | undefined {
  let best: ConformanceLevel | undefined;
  for (const level of CONFORMANCE_LEVELS) {
    const complete = requirementsUpTo(level).every(
      (requirement) => (reached.get(requirement.id) ?? []).length > 0,
    );
    if (!complete) break;
    best = level;
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown (SPEC 16.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `CONFORMANCE.md`.
 *
 * Written to be read as a diff: one line per case, one line per requirement,
 * failures quoted in full underneath. Nothing in it varies between two runs of
 * the same build, so a change in the file is a change in behaviour.
 */
export function renderReport(report: ConformanceReport): string {
  const out: string[] = [];

  out.push('# MDV conformance report');
  out.push('');
  out.push(`- Spec version: \`${report.specVersion}\``);
  out.push(`- Level asked for: ${report.level} (${levelName(report.level)})`);
  out.push(`- Level substantiated: ${substantiatedText(report)}`);
  out.push(`- Corpus root: \`${report.root}\``);
  out.push(`- Result: ${report.ok ? '**pass**' : '**fail**'}`);
  out.push('');

  const t = report.totals;
  out.push('## Totals');
  out.push('');
  out.push('| | Total | Passed | Failed | Skipped |');
  out.push('| --- | ---: | ---: | ---: | ---: |');
  out.push(`| Cases | ${t.cases} | ${t.passed} | ${t.failed} | ${t.skipped} |`);
  out.push(`| Checks | ${t.checks} | ${t.checksPassed} | ${t.checksFailed} | ${t.checksSkipped} |`);
  out.push('');

  renderIssues(report, out);
  renderCases(report, out);
  renderFailures(report, out);
  renderCoverage(report, out);

  // Each section closes with a blank line so the next one can start without
  // knowing what came before; the file itself wants a single trailing newline.
  while (out.at(-1) === '') out.pop();
  return `${out.join('\n')}\n`;
}

function substantiatedText(report: ConformanceReport): string {
  const level = report.substantiated;
  if (level === undefined) return 'none';
  return `${level} (${levelName(level)})`;
}

/** A corpus that cannot be trusted cannot substantiate a level, so these lead. */
function renderIssues(report: ConformanceReport, out: string[]): void {
  if (report.issues.length === 0) return;
  out.push('## Corpus issues');
  out.push('');
  for (const issue of report.issues) {
    out.push(`- \`${issue.path}\` — ${issue.message}`);
  }
  out.push('');
}

/** One row per case, in corpus order, with a column per check in run order. */
function renderCases(report: ConformanceReport, out: string[]): void {
  out.push('## Cases');
  out.push('');
  if (report.results.length === 0) {
    out.push('_No cases._');
    out.push('');
    return;
  }

  out.push(`| Case | Level | Status | ${CHECK_ORDER.join(' | ')} |`);
  out.push(`| --- | ---: | --- |${' :-: |'.repeat(CHECK_ORDER.length)}`);
  for (const result of report.results) {
    const cells = CHECK_ORDER.map((name) => checkCell(result, name));
    out.push(
      `| \`${result.fixture.id}\` | ${result.fixture.meta.level} | ${statusWord(result)} | ${cells.join(' | ')} |`,
    );
  }
  out.push('');
}

const MARK: Readonly<Record<string, string>> = {
  pass: '✓',
  fail: '✗',
  skip: '–',
};

/** Absent means the case does not pin that check — not the same as skipped. */
function checkCell(result: CaseResult, name: CheckName): string {
  const check = result.checks.find((candidate) => candidate.check === name);
  if (check === undefined) return '';
  return MARK[check.status] ?? '';
}

function statusWord(result: CaseResult): string {
  if (result.status === 'pass') return 'pass';
  if (result.status === 'fail') return '**fail**';
  return `skip (${result.reason ?? 'no reason given'})`;
}

/**
 * The diffs, in full.
 *
 * A report that says "3 failed" and makes the reader run the suite to find out
 * why has kept the interesting half to itself.
 */
function renderFailures(report: ConformanceReport, out: string[]): void {
  const failed = report.results.filter((result) => result.status === 'fail');
  if (failed.length === 0) return;

  out.push('## Failures');
  out.push('');
  for (const result of failed) {
    out.push(`### \`${result.fixture.id}\``);
    out.push('');
    for (const check of result.checks) {
      if (check.status !== 'fail') continue;
      out.push(`**${check.check}** — ${check.reason ?? 'failed'}`);
      out.push('');
      if (check.detail !== undefined && check.detail !== '') {
        out.push('```');
        out.push(check.detail);
        out.push('```');
        out.push('');
      }
    }
  }
}

/** Every requirement up to the level asked for, in `levels.json` order. */
function renderCoverage(report: ConformanceReport, out: string[]): void {
  out.push('## Coverage');
  out.push('');
  out.push('| Requirement | Level | SPEC | Cases |');
  out.push('| --- | ---: | --- | --- |');
  for (const row of report.coverage) {
    out.push(
      `| ${label(row.requirement)} | ${row.requirement.level} | ${row.requirement.spec} | ${casesCell(row)} |`,
    );
  }
  out.push('');

  const gaps = report.coverage.filter((row) => row.cases.length === 0);
  if (gaps.length === 0) return;
  out.push(
    `${gaps.length} requirement${gaps.length === 1 ? '' : 's'} up to level ${report.level} ${gaps.length === 1 ? 'is' : 'are'} not substantiated by a passing case:`,
  );
  out.push('');
  for (const gap of gaps) out.push(`- \`${gap.requirement.id}\` — ${gap.requirement.label}`);
  out.push('');
}

function label(requirement: LevelRequirement): string {
  return `\`${requirement.id}\` ${requirement.label}`;
}

/** Cases are listed, not counted: a reader wants to know which ones. */
function casesCell(row: CoverageRow): string {
  if (row.cases.length === 0) return '**none**';
  return row.cases.map((id) => `\`${id}\``).join(', ');
}
