/**
 * `mdv lint` (SPEC 27).
 *
 * ```text
 * mdv lint 'docs/**\/*.mdv' --max-severity warning
 * mdv lint report.mdv --format sarif > mdv.sarif
 * ```
 *
 * Reports stages 1–3: parse diagnostics, resolve diagnostics, and
 * `validateBlock` per block. Exit 1 when anything is at or above
 * `--max-severity` (default `error`); a document that only trips `info` still
 * exits 0, which is what makes the flag useful in CI.
 */

import {
  applyStrict,
  compareDiagnostics,
  parse,
  registryFromPlugins,
  resolve as resolveDocument,
  validateBlock,
} from '@mdv/core';
import type { Diagnostic } from '@mdv/core';

import type { GlobalFlags } from '../args.js';
import { EXIT_CODES, usageError } from '../exit.js';
import { displayPath, expandInputs, readTextFile } from '../io.js';
import type { CliIo } from '../io.js';
import { buildConfig, CLI_VERSION } from '../pipeline.js';
import {
  atOrAbove,
  countDiagnostics,
  formatJson,
  formatPretty,
  formatSarif,
  parseSeverity,
  summarise,
} from '../report.js';
import type { FileDiagnostics } from '../report.js';
import { createTerm } from '../term.js';

/** Diagnostic output formats for `mdv lint`. */
export type LintFormat = 'json' | 'pretty' | 'sarif';

/** Flags `mdv lint` accepts on top of the global ones. */
export interface LintFlags extends GlobalFlags {
  maxSeverity?: string;
  format?: string;
}

/** Collect every diagnostic for one document, deduplicated and in source order. */
async function lintOne(
  io: CliIo,
  file: string,
  flags: GlobalFlags,
  term: ReturnType<typeof createTerm>,
): Promise<FileDiagnostics> {
  const source = await readTextFile(io, file);
  const config = await buildConfig(io, flags, file, term);
  const doc = parse(source);
  const resolved = await resolveDocument(doc, config);
  const strict = resolved.config.strict;

  // `resolve` starts at stage 2, so the parser's own diagnostics are not in
  // `resolved.diagnostics`. A lint that dropped them would call a document with
  // a broken fence clean.
  const found: Diagnostic[] = [
    ...doc.diagnostics.map((d) => applyStrict(d, strict)),
    ...resolved.diagnostics,
  ];
  // Stage 3 needs the registry: `validateBlock` with no registry has nothing to
  // validate against and honestly returns `[]`.
  const registry = registryFromPlugins(config);
  for (const block of resolved.blocks) {
    for (const d of validateBlock(block, registry)) found.push(applyStrict(d, strict));
  }

  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const d of found) {
    const key = `${d.code} ${d.range.start.offset} ${d.range.end.offset} ${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  unique.sort(compareDiagnostics);

  return { file: displayPath(io, file), source, diagnostics: unique };
}

/** `mdv lint` — exits 1 when any diagnostic is at or above `maxSeverity`. */
export async function lintCommand(
  io: CliIo,
  globs: readonly string[],
  flags: LintFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);

  const format = (flags.format ?? 'pretty') as LintFormat;
  if (format !== 'pretty' && format !== 'json' && format !== 'sarif') {
    throw usageError(
      `Unknown --format \`${flags.format ?? ''}\``,
      '--format accepts pretty, json, sarif',
    );
  }
  const threshold = parseSeverity(flags.maxSeverity ?? 'error');
  if (threshold === undefined) {
    throw usageError(
      `Unknown --max-severity \`${flags.maxSeverity ?? ''}\``,
      '--max-severity accepts error, warning, info',
    );
  }

  const patterns = globs.length > 0 ? globs : ['.'];
  const files = await expandInputs(io, patterns);
  if (files.length === 0) {
    throw usageError(
      `No documents matched ${patterns.join(' ')}`,
      'A bare directory expands to the .mdv and .md files beneath it.',
    );
  }

  const reports: FileDiagnostics[] = [];
  for (const file of files) reports.push(await lintOne(io, file, flags, term));

  switch (format) {
    case 'pretty': {
      const text = formatPretty(reports, term);
      if (text !== '') term.out(text);
      const all = reports.flatMap((r) => r.diagnostics);
      term.status(
        `${files.length} file${files.length === 1 ? '' : 's'}, ${summarise(countDiagnostics(all))}`,
      );
      break;
    }
    case 'json':
      term.out(formatJson(reports));
      break;
    case 'sarif':
      term.out(formatSarif(reports, CLI_VERSION));
      break;
  }

  return reports.some((r) => atOrAbove(r.diagnostics, threshold))
    ? EXIT_CODES.diagnostics
    : EXIT_CODES.ok;
}
