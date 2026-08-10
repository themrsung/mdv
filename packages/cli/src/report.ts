/**
 * Diagnostic reporting: `pretty`, `json`, and `sarif` (SPEC 14, SPEC 27).
 *
 * The pretty form is the one a human reads, so it shows the offending source
 * line with a caret under the exact range (SPEC 14.4 exists precisely so this is
 * possible). The other two are for machines and are stable: keys in a fixed
 * order, no timestamps, no absolute paths unless the caller passed one.
 */

import type { Diagnostic, DiagnosticSeverity } from '@mdv/core';

import type { Term } from './term.js';

/** `info` < `warning` < `error`. */
const RANK: Readonly<Record<DiagnosticSeverity, number>> = { info: 0, warning: 1, error: 2 };

/** Numeric rank of a severity, for `--max-severity`. */
export function severityRank(severity: DiagnosticSeverity): number {
  return RANK[severity];
}

/** Parse a `--max-severity` value. */
export function parseSeverity(value: string): DiagnosticSeverity | undefined {
  return value === 'error' || value === 'warning' || value === 'info' ? value : undefined;
}

/** How many of each severity, in a fixed key order. */
export interface DiagnosticCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

/** Count by severity. */
export function countDiagnostics(diagnostics: readonly Diagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { error: 0, warning: 0, info: 0, total: diagnostics.length };
  for (const d of diagnostics) counts[d.severity] += 1;
  return counts;
}

/** `true` when any diagnostic is at or above `threshold`. */
export function atOrAbove(
  diagnostics: readonly Diagnostic[],
  threshold: DiagnosticSeverity,
): boolean {
  const limit = RANK[threshold];
  return diagnostics.some((d) => RANK[d.severity] >= limit);
}

/** English for a count: `1 error`, `2 errors`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** `3 errors, 1 warning` — omits the zeroes, says `no problems` when empty. */
export function summarise(counts: DiagnosticCounts): string {
  const parts: string[] = [];
  if (counts.error > 0) parts.push(plural(counts.error, 'error'));
  if (counts.warning > 0) parts.push(plural(counts.warning, 'warning'));
  if (counts.info > 0) parts.push(plural(counts.info, 'info'));
  return parts.length === 0 ? 'no problems' : parts.join(', ');
}

function colourise(term: Term, severity: DiagnosticSeverity): string {
  switch (severity) {
    case 'error':
      return term.red('error');
    case 'warning':
      return term.yellow('warning');
    case 'info':
      return term.blue('info');
  }
}

/**
 * The source line a diagnostic points at, with a caret run under its range.
 *
 * Tabs are expanded to a single space each so the caret lands under the right
 * column; a tab-indented block otherwise draws the underline in the wrong place.
 */
function excerpt(source: string, diagnostic: Diagnostic, term: Term): string[] {
  const lines = source.split('\n');
  const lineNumber = diagnostic.range.start.line;
  const raw = lines[lineNumber - 1];
  if (raw === undefined) return [];

  const text = raw.replace(/\t/g, ' ');
  const gutter = String(lineNumber);
  const pad = ' '.repeat(gutter.length);
  const startColumn = Math.max(1, diagnostic.range.start.column);
  const endColumn =
    diagnostic.range.end.line === lineNumber
      ? Math.max(startColumn + 1, diagnostic.range.end.column)
      : text.length + 1;
  const width = Math.max(1, Math.min(endColumn - startColumn, text.length - startColumn + 1));

  return [
    `${term.dim(`${pad} |`)}`,
    `${term.dim(`${gutter} |`)} ${text}`,
    `${term.dim(`${pad} |`)} ${' '.repeat(startColumn - 1)}${term.red('^'.repeat(width))}`,
  ];
}

/** One file's diagnostics, and the source they point into. */
export interface FileDiagnostics {
  /** How the file should be named in the report. */
  file: string;
  source: string;
  diagnostics: readonly Diagnostic[];
}

/** Human-readable report. Returns `''` when there is nothing to say. */
export function formatPretty(
  files: readonly FileDiagnostics[],
  term: Term,
  options?: { excerpts?: boolean },
): string {
  const withExcerpts = options?.excerpts !== false;
  const out: string[] = [];
  for (const entry of files) {
    for (const d of entry.diagnostics) {
      const where = `${entry.file}:${d.range.start.line}:${d.range.start.column}`;
      out.push(
        `${term.bold(where)} ${colourise(term, d.severity)} ${term.dim(d.code)}  ${d.message}`,
      );
      if (withExcerpts) out.push(...excerpt(entry.source, d, term));
      if (d.detail !== undefined && d.detail !== '') out.push(`  ${term.dim(d.detail)}`);
      for (const fix of d.fixes ?? []) out.push(`  ${term.dim(`fix: ${fix.title}`)}`);
      out.push('');
    }
  }
  return out.join('\n');
}

/** Machine-readable report: one JSON array, keys in a fixed order. */
export function formatJson(files: readonly FileDiagnostics[]): string {
  const rows = files.flatMap((entry) =>
    entry.diagnostics.map((d) => ({
      file: entry.file,
      code: d.code,
      severity: d.severity,
      message: d.message,
      ...(d.detail === undefined ? {} : { detail: d.detail }),
      ...(d.blockId === undefined ? {} : { blockId: d.blockId }),
      source: d.source,
      range: {
        start: {
          line: d.range.start.line,
          column: d.range.start.column,
          offset: d.range.start.offset,
        },
        end: { line: d.range.end.line, column: d.range.end.column, offset: d.range.end.offset },
      },
    })),
  );
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** SARIF 2.1.0, for GitHub code scanning and the like. */
export function formatSarif(files: readonly FileDiagnostics[], toolVersion: string): string {
  const levelOf = (severity: DiagnosticSeverity): string =>
    severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'note';

  // One rule per distinct code, in first-appearance order — stable, and never a
  // set iterated in hash order (SPEC 24.3 rule 5).
  const rules: { id: string; shortDescription: { text: string } }[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    for (const d of entry.diagnostics) {
      if (seen.has(d.code)) continue;
      seen.add(d.code);
      rules.push({ id: d.code, shortDescription: { text: d.message } });
    }
  }

  const results = files.flatMap((entry) =>
    entry.diagnostics.map((d) => ({
      ruleId: d.code,
      level: levelOf(d.severity),
      message: { text: d.detail === undefined ? d.message : `${d.message}. ${d.detail}` },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: entry.file },
            region: {
              startLine: d.range.start.line,
              startColumn: d.range.start.column,
              endLine: d.range.end.line,
              endColumn: d.range.end.column,
            },
          },
        },
      ],
    })),
  );

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'mdv', informationUri: 'https://mdv.dev', version: toolVersion, rules } },
        results,
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
