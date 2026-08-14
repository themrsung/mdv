/**
 * PDF/UA validation of the corpus, through veraPDF (SPEC 28.8, F.2 M6).
 *
 * The corpus (SPEC 16.2) answers *does this build render what it promised*, and
 * it answers it against goldens this repository mints. That is exactly the wrong
 * instrument for an accessibility claim: a golden minted by the exporter agrees
 * with the exporter by construction, so a tagged-PDF bug that is consistent is a
 * bug every golden will happily pin. SPEC 28.8's promise — that the accessible
 * name, description and table view survive into the PDF — is a claim about a
 * file being readable by software this repository did not write, and only a
 * third-party validator can substantiate it. That validator is veraPDF, and the
 * flavour is `ua1` (PDF/UA-1, ISO 14289-1).
 *
 * ## Why this is not a corpus check
 *
 * `runCase` is deliberately hermetic — "a fixture that reaches the network or
 * the disk is a fixture that fails on a plane" — and veraPDF is a JVM program
 * that has to be installed. Wiring it into the corpus would make `pnpm test`
 * depend on a toolchain most contributors do not have, and the usual way that
 * ends is a check that silently skips and reports green. So this is a separate
 * harness with a separate report, and a run without the validator is a *usage*
 * failure, not a pass.
 *
 * ## What a verdict here means
 *
 * - **PASS** — veraPDF found no failed PDF/UA-1 check in the file. It does not
 *   mean the document is *usable*; ISO 14289 has requirements no machine can
 *   check (is the alt text a description or the word "chart"?), and veraPDF says
 *   so itself. A human still has to read {@link https://verapdf.org} output.
 * - **FAIL** — a machine-checkable requirement is broken. This is unambiguous
 *   and is the half worth automating.
 * - **REFUSED** — the exporter would not produce the file at all, because the
 *   document asks for a figure with no accessible description (`MDV5110`, SPEC
 *   28.5). That is the exporter keeping its promise rather than breaking it
 *   silently, so it is reported as its own outcome rather than as a failure: a
 *   corpus case that legitimately has an undescribed figure would otherwise make
 *   this harness permanently red for doing the right thing.
 *
 * ## Reading veraPDF's output
 *
 * The text report is parsed rather than the XML MRR, because `--format text`
 * emits exactly one `PASS <file>` / `FAIL <file>` line per file and that is a
 * shape a regex can own honestly. The parse is checked against the file list
 * ({@link parseVeraPdfText} throws when the two disagree) so a validator whose
 * output shape changed under us fails loudly instead of reporting a green run
 * over files it never looked at.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';

import type { ResolvedDocument } from '@mdv/core';
import { createLayoutContext, parse, resolve } from '@mdv/core';
import type { Diagnostic } from '@mdv/parser';
import type { PdfExportContext } from '@mdv/render-pdf';
import { PdfProfileError, createStandardFontMetrics, exportPdf } from '@mdv/render-pdf';
import { getBuiltinTheme } from '@mdv/themes';

import { INPUT_FILE } from './corpus.js';
import { conformanceConfig } from './run.js';
import type { Corpus, FixtureCase } from './types.js';

const run = promisify(execFile);

/** The veraPDF flavour identifier for PDF/UA-1 (ISO 14289-1). */
export const PDFUA_FLAVOUR = 'ua1';

/** Names veraPDF is installed under, in the order they are tried. */
const VALIDATOR_NAMES: readonly string[] = ['verapdf', 'verapdf-gui'];

// ─────────────────────────────────────────────────────────────────────────────
// Exporting the corpus
// ─────────────────────────────────────────────────────────────────────────────

/** What became of one case on the way to a file. */
export interface PdfUaExport {
  /** {@link FixtureCase.id}. */
  readonly id: string;
  /** Absolute path written, when the exporter produced a file. */
  readonly file?: string;
  /** Size of that file in bytes. */
  readonly bytes?: number;
  /**
   * Why no file exists. `MDV5110` — a figure without an accessible description
   * — is the expected reason and the profile working as specified; anything
   * else is this build failing to export a document it renders.
   */
  readonly refused?: string;
  /** Export-stage diagnostic codes, deduplicated, in first-seen order. */
  readonly diagnostics: readonly string[];
}

/** How to export, for the two knobs a PDF/UA run can reasonably want. */
export interface PdfUaExportOptions {
  /** Attach the `.mdv` source as an embedded file (SPEC 28.9). Default false. */
  readonly embedSource?: boolean;
  /** Deflate the streams, as a real export does. Default true. */
  readonly compress?: boolean;
}

/**
 * The export context, pinned exactly as {@link traceOf} pins it.
 *
 * The same print theme and the same standard-14 metrics, so a file validated
 * here is the file the corpus traces — a validator run against a differently
 * configured export would be validating a document this repository never
 * produces.
 */
function contextOf(
  doc: ResolvedDocument,
  source: string,
  onDiagnostic: (d: Diagnostic) => void,
): PdfExportContext {
  const first = doc.blocks[0];
  const registry = first === undefined ? undefined : createLayoutContext(doc, first).registry;
  return {
    fonts: [],
    metrics: createStandardFontMetrics(),
    buildTime: doc.config.buildTime,
    onDiagnostic,
    printTheme: getBuiltinTheme('print'),
    source,
    sourceName: INPUT_FILE,
    ...(registry === undefined ? {} : { registry }),
  };
}

/** File name for a case: the id, flattened, so one directory holds the corpus. */
export function pdfNameOf(id: string): string {
  return `${id.replace(/[/\\]/g, '__')}.pdf`;
}

/**
 * Export one case under `profile: 'pdf-ua-1'`.
 *
 * Never throws for anything the document does: a refusal is a result, and the
 * caller reports it. A throw from here is the harness itself being broken.
 */
export async function exportCase(
  fixture: FixtureCase,
  outDir: string,
  options: PdfUaExportOptions = {},
): Promise<PdfUaExport> {
  const seen = new Set<string>();
  const collect = (d: Diagnostic): void => {
    seen.add(d.code);
  };
  try {
    const doc = await resolve(parse(fixture.source), conformanceConfig(fixture.meta.level));
    const bytes = await exportPdf(doc, contextOf(doc, fixture.source, collect), {
      profile: 'pdf-ua-1',
      embedSource: options.embedSource ?? false,
      compress: options.compress ?? true,
    });
    const file = join(outDir, pdfNameOf(fixture.id));
    await writeFile(file, bytes);
    return { id: fixture.id, file, bytes: bytes.length, diagnostics: [...seen] };
  } catch (error) {
    // A profile refusal throws before the build flushes its diagnostics, so the
    // code that caused it is taken from the error rather than from the
    // collector — a refusal whose report said "no diagnostics" would be
    // describing the one thing that happened as nothing.
    if (error instanceof PdfProfileError) {
      for (const d of error.diagnostics) seen.add(d.code);
      seen.add(error.code);
      return { id: fixture.id, refused: error.message, diagnostics: [...seen] };
    }
    const refused = error instanceof Error ? error.message : String(error);
    return { id: fixture.id, refused, diagnostics: [...seen] };
  }
}

/** Export every case of a corpus into `outDir`, in corpus order. */
export async function exportCorpus(
  corpus: Corpus,
  outDir: string,
  options: PdfUaExportOptions = {},
): Promise<readonly PdfUaExport[]> {
  await mkdir(outDir, { recursive: true });
  const out: PdfUaExport[] = [];
  for (const fixture of corpus.cases) out.push(await exportCase(fixture, outDir, options));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Running the validator
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when veraPDF ran but this harness cannot trust what it said. */
export class VeraPdfError extends Error {
  override readonly name = 'VeraPdfError';
  /** The validator's own output, so the failure is diagnosable. */
  readonly output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

/** One file's verdict. */
export interface PdfUaVerdict {
  /** Absolute path, as the validator printed it. */
  readonly file: string;
  readonly compliant: boolean;
}

/** A whole validator run. */
export interface PdfUaRun {
  /** The binary that ran. */
  readonly validator: string;
  /** Its `--version` line, so a report says what judged it. */
  readonly version: string;
  readonly flavour: string;
  readonly verdicts: readonly PdfUaVerdict[];
  /** Everything the validator printed, kept verbatim for the log file. */
  readonly output: string;
}

/**
 * Find veraPDF: `MDV_VERAPDF` wins, then `PATH`, then the two paths its own
 * installer uses on a Mac and on Linux.
 */
export async function findVeraPdf(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const explicit = env['MDV_VERAPDF'];
  if (explicit !== undefined && explicit !== '') return explicit;
  for (const name of VALIDATOR_NAMES) {
    try {
      const { stdout } = await run('command', ['-v', name], { shell: '/bin/sh' });
      const found = stdout.trim().split('\n')[0];
      if (found !== undefined && found !== '') return found;
    } catch {
      // Not on PATH under that name; try the next.
    }
  }
  return undefined;
}

/**
 * Split veraPDF's `--format text` output into verdicts.
 *
 * `expected` is the file list the run was given. Every file must appear exactly
 * once and no line may name a file that was not asked about, because the only
 * failure mode worth guarding against here is a silent one: a parse that
 * matches nothing returns no verdicts, and no verdicts must never read as no
 * failures.
 *
 * @throws VeraPdfError when the output does not account for every file.
 */
export function parseVeraPdfText(
  output: string,
  expected: readonly string[],
): readonly PdfUaVerdict[] {
  const wanted = new Set(expected.map((f) => resolvePath(f)));
  const found = new Map<string, boolean>();
  for (const line of output.split(/\r?\n/)) {
    // Both orders are accepted — `PASS <file>` is what the tool prints, and a
    // trailing verdict is the other shape a reasonable CLI might use. Anything
    // else (the failed-check detail lines that `-v` adds) is not a verdict line
    // and is skipped, which is why the count is checked afterwards.
    const lead = /^\s*(PASS|FAIL)\s+(.+?)\s*$/.exec(line);
    const trail = /^\s*(.+?)\s+(PASS|FAIL)\s*$/.exec(line);
    const hit = lead ?? trail;
    if (hit === null) continue;
    const [verdict, file] = lead !== null ? [hit[1], hit[2]] : [hit[2], hit[1]];
    if (file === undefined || verdict === undefined) continue;
    const path = resolvePath(file);
    if (!wanted.has(path)) continue;
    if (found.has(path)) {
      throw new VeraPdfError(`veraPDF reported ${file} twice`, output);
    }
    found.set(path, verdict === 'PASS');
  }
  const missing = [...wanted].filter((f) => !found.has(f));
  if (missing.length > 0) {
    throw new VeraPdfError(
      `veraPDF did not report a verdict for ${missing.length} of ${wanted.size} file(s): ` +
        `${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`,
      output,
    );
  }
  return expected.map((f) => ({
    file: resolvePath(f),
    compliant: found.get(resolvePath(f)) === true,
  }));
}

/**
 * Validate `files` against PDF/UA-1.
 *
 * The exit code is not consulted for the verdicts — veraPDF's return codes are
 * not documented alongside its option list, and a verdict inferred from an
 * undocumented code is a verdict this harness cannot defend. The per-file lines
 * are the contract, and {@link parseVeraPdfText} enforces that they cover every
 * file.
 */
export async function runVeraPdf(
  validator: string,
  files: readonly string[],
  options: { readonly flavour?: string; readonly maxFailures?: number } = {},
): Promise<PdfUaRun> {
  const flavour = options.flavour ?? PDFUA_FLAVOUR;
  const version = await versionOf(validator);
  const args = [
    '--format',
    'text',
    '--flavour',
    flavour,
    '--verbose',
    '--maxfailuresdisplayed',
    String(options.maxFailures ?? 5),
    ...files,
  ];
  // A non-compliant file is a non-zero exit, so a rejection is expected and the
  // output is what matters either way.
  const output = await capture(validator, args);
  return { validator, version, flavour, verdicts: parseVeraPdfText(output, files), output };
}

/** Run a command and return stdout + stderr, whatever the exit code. */
async function capture(command: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(command, [...args], { maxBuffer: 64 * 1024 * 1024 });
    return `${stdout}${stderr}`;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: unknown; message?: string };
    if (typeof e.stdout === 'string' || typeof e.stderr === 'string') {
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    throw new VeraPdfError(
      `could not run ${command}: ${e.message ?? String(error)}`,
      String(e.message ?? ''),
    );
  }
}

/** The validator's version line, or `unknown` if it will not say. */
async function versionOf(validator: string): Promise<string> {
  const text = await capture(validator, ['--version']);
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  return line ?? 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a report needs, so rendering it stays a pure function. */
export interface PdfUaReport {
  readonly exports: readonly PdfUaExport[];
  readonly run?: PdfUaRun;
  /** ISO instant the run finished. */
  readonly generated: string;
}

/**
 * Passed / failed / refused / unvalidated, for the summary line and the exit
 * code.
 *
 * A file the validator never saw is counted apart from a file it rejected. They
 * are both "not known to be compliant", but only one of them is a defect, and a
 * summary that conflated them would make `--no-validate` report a corpus-wide
 * failure for having exported cleanly.
 */
export function tallyPdfUa(report: PdfUaReport): {
  readonly passed: number;
  readonly failed: number;
  readonly refused: number;
  readonly unvalidated: number;
} {
  const validated = report.run !== undefined;
  const byFile = new Map((report.run?.verdicts ?? []).map((v) => [v.file, v.compliant]));
  let passed = 0;
  let failed = 0;
  let refused = 0;
  let unvalidated = 0;
  for (const e of report.exports) {
    if (e.file === undefined) refused += 1;
    else if (!validated || !byFile.has(resolvePath(e.file))) unvalidated += 1;
    else if (byFile.get(resolvePath(e.file)) === true) passed += 1;
    else failed += 1;
  }
  return { passed, failed, refused, unvalidated };
}

/** Render the Markdown report. */
export function renderPdfUaReport(report: PdfUaReport): string {
  const { passed, failed, refused, unvalidated } = tallyPdfUa(report);
  const byFile = new Map((report.run?.verdicts ?? []).map((v) => [v.file, v.compliant]));
  const lines: string[] = [];
  lines.push('# PDF/UA conformance');
  lines.push('');
  lines.push(
    'Every case of the fixture corpus (SPEC 16.2), exported under',
    '`profile: "pdf-ua-1"` (SPEC 28.5) and validated against PDF/UA-1 (ISO 14289-1)',
    'by veraPDF. Generated by `pnpm pdfua` — do not edit.',
  );
  lines.push('');
  lines.push(`- **Validator**: ${report.run?.version ?? '_not run_'}`);
  lines.push(`- **Flavour**: \`${report.run?.flavour ?? PDFUA_FLAVOUR}\``);
  lines.push(`- **Generated**: ${report.generated}`);
  lines.push('');
  lines.push(
    `**${passed} passed, ${failed} failed, ${refused} refused` +
      `${unvalidated > 0 ? `, ${unvalidated} not validated` : ''}** of ${report.exports.length} cases.`,
  );
  lines.push('');
  lines.push('| Case | Result | Bytes | Export diagnostics |');
  lines.push('| --- | --- | ---: | --- |');
  for (const e of report.exports) {
    const result =
      e.file === undefined
        ? 'refused'
        : !byFile.has(resolvePath(e.file))
          ? 'not validated'
          : byFile.get(resolvePath(e.file)) === true
            ? 'pass'
            : 'FAIL';
    const codes =
      e.diagnostics.length === 0 ? '—' : e.diagnostics.map((c) => `\`${c}\``).join(', ');
    lines.push(`| \`${e.id}\` | ${result} | ${e.bytes === undefined ? '—' : e.bytes} | ${codes} |`);
  }
  lines.push('');
  const refusals = report.exports.filter((e) => e.refused !== undefined);
  if (refusals.length > 0) {
    lines.push('## Refused');
    lines.push('');
    lines.push(
      'The exporter would not write these files. `MDV5110` — a figure with no',
      'accessible description — is the profile keeping its promise (SPEC 28.5),',
      'not a validation failure.',
    );
    lines.push('');
    for (const e of refusals) lines.push(`- \`${e.id}\` — ${e.refused ?? ''}`);
    lines.push('');
  }
  lines.push('## What this does not say');
  lines.push('');
  lines.push(
    'A machine can check that a figure carries an `/Alt`, not that the text in it',
    'describes the figure. PDF/UA has requirements only a human can judge, and a',
    'green table here is the machine-checkable half of the claim.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}
