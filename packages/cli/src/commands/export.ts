/**
 * `mdv export` (SPEC 27, SPEC 28.11).
 *
 * ```text
 * mdv export report.mdv -o report.pdf
 * mdv export report.mdv --to svg -o out/chart.svg
 * mdv export report.mdv --to json | jq '.blocks[0].scene.meta'
 * ```
 *
 * The PDF path is the direct exporter of SPEC 28.1: `@mdv/render-pdf` flows the
 * document, paginates it, and lays every block out through the *same*
 * `layoutBlock` the screen uses. There is no browser and no second layout engine,
 * which is why pagination cannot disagree with the viewport about whether a label
 * fits.
 */

import { basename, extname, join } from 'node:path';

import { createStandardFontMetrics, exportPdf } from '@mdv/render-pdf';
import type { PdfExportOptions } from '@mdv/render-pdf';
import { createLayoutContext } from '@mdv/core';
import type { Diagnostic } from '@mdv/core';
import { toSvgString } from '@mdv/render-svg';

import type { GlobalFlags } from '../args.js';
import { usageError } from '../exit.js';
import { absolute, displayPath, writeBinaryFile, writeTextFile } from '../io.js';
import type { CliIo } from '../io.js';
import { loadDocument, outcomeFor, printTheme, singleInput } from '../pipeline.js';
import type { LoadedDocument } from '../pipeline.js';
import { DEFAULT_WIDTH, sceneFor, selectBlock, selectBlocks } from '../scene.js';
import { tableToCsv } from '../table.js';
import { createTerm } from '../term.js';
import type { Term } from '../term.js';
import { countDiagnostics, summarise } from '../report.js';

/** Export targets (SPEC 28.11). */
export type ExportTarget = 'pdf' | 'html' | 'svg' | 'png' | 'md' | 'json' | 'csv';

/** Every target name, for error messages. */
export const EXPORT_TARGETS: readonly ExportTarget[] = [
  'pdf',
  'html',
  'svg',
  'png',
  'md',
  'json',
  'csv',
];

/** Targets this build actually writes. */
const IMPLEMENTED: readonly ExportTarget[] = ['pdf', 'svg', 'json', 'csv'];

/** Why the other three are refused rather than half-written. */
const UNIMPLEMENTED_REASON: Readonly<Record<string, string>> = {
  html: 'a self-contained HTML document is prose plus blocks, and the Markdown-to-HTML half is not built yet; `--to svg` exports the blocks',
  png: 'PNG needs the Canvas backend (@mdv/render-canvas), which is not in this build; export SVG and rasterise it',
  md: 'degraded Markdown (SPEC 5.6) replaces every chart with a pre-rendered image, which needs the PNG target',
};

/** Flags `mdv export` accepts on top of the global ones. */
export interface ExportFlags extends GlobalFlags {
  out?: string;
  to?: string;
  width?: number;
  block?: string;
  scale?: number;
  paginate?: boolean;
  compress?: boolean;
  embedSource?: boolean;
  profile?: string;
  pageSize?: string;
  orientation?: string;
}

/** Map a file extension onto a target. */
function targetFromPath(path: string): ExportTarget | undefined {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.svg':
      return 'svg';
    case '.html':
    case '.htm':
      return 'html';
    case '.png':
      return 'png';
    case '.md':
      return 'md';
    case '.json':
      return 'json';
    case '.csv':
      return 'csv';
    default:
      return undefined;
  }
}

/**
 * Decide what to write: `--to` wins, then the `-o` extension, then PDF.
 *
 * @throws CliError (exit 2) for an unknown target, or for one this build refuses
 * to fake
 */
export function resolveTarget(flags: ExportFlags): ExportTarget {
  const requested = flags.to;
  if (requested !== undefined) {
    const lower = requested.toLowerCase();
    if (!(EXPORT_TARGETS as readonly string[]).includes(lower)) {
      throw usageError(
        `Unknown export target \`${requested}\``,
        `--to accepts ${EXPORT_TARGETS.join(', ')}`,
      );
    }
    return lower as ExportTarget;
  }
  const fromOut =
    flags.out === undefined || flags.out === '-' ? undefined : targetFromPath(flags.out);
  return fromOut ?? 'pdf';
}

/** Default output path: the input's basename with the target's extension. */
function defaultOut(io: CliIo, input: string, target: ExportTarget): string {
  const stem = basename(input, extname(input));
  return join(io.cwd, `${stem}.${target}`);
}

/** `12.3 kB`, in fixed units so two runs print the same string. */
function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Report the document's diagnostics, briefly, on stderr. */
function reportDiagnostics(term: Term, loaded: LoadedDocument, extra: readonly Diagnostic[]): void {
  const all = [...loaded.resolved.diagnostics, ...extra];
  if (all.length === 0) return;
  const counts = countDiagnostics(all);
  term.status(
    `${loaded.display}: ${summarise(counts)} (run \`mdv lint ${loaded.display}\` for detail)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Targets
// ─────────────────────────────────────────────────────────────────────────────

async function exportToPdf(
  io: CliIo,
  loaded: LoadedDocument,
  flags: ExportFlags,
  out: string,
  term: Term,
): Promise<Diagnostic[]> {
  if (out === '-') {
    throw usageError(
      'PDF cannot be written to stdout',
      'Give a file path: mdv export doc.mdv -o doc.pdf',
    );
  }

  const options: PdfExportOptions = {};
  if (flags.compress !== undefined) options.compress = flags.compress;
  if (flags.embedSource !== undefined) options.embedSource = flags.embedSource;
  if (flags.pageSize !== undefined) options.pageSize = flags.pageSize;
  if (flags.orientation !== undefined) {
    if (flags.orientation !== 'portrait' && flags.orientation !== 'landscape') {
      throw usageError(`--orientation must be portrait or landscape, got \`${flags.orientation}\``);
    }
    options.orientation = flags.orientation;
  }
  if (flags.profile !== undefined) {
    if (
      flags.profile !== 'pdf-1.7' &&
      flags.profile !== 'pdf-a-3b' &&
      flags.profile !== 'pdf-ua-1'
    ) {
      throw usageError(
        `Unknown PDF profile \`${flags.profile}\``,
        '--profile accepts pdf-1.7, pdf-a-3b, pdf-ua-1',
      );
    }
    options.profile = flags.profile;
  }

  const collected: Diagnostic[] = [];
  // The registry the document was resolved under, so a chart type reaches the
  // exporter's own layout pass. `createLayoutContext` builds it from the plugins
  // on the resolved config, which is where `builtinsPlugin()` put them.
  const first = loaded.resolved.blocks[0];
  const registry =
    first === undefined ? undefined : createLayoutContext(loaded.resolved, first).registry;

  const bytes = await exportPdf(
    loaded.resolved,
    {
      fonts: [],
      metrics: createStandardFontMetrics(),
      buildTime: loaded.resolved.config.buildTime,
      onDiagnostic: (d) => collected.push(d),
      // SPEC 28.5: `theme: print` by default. An explicit --theme is the author
      // overriding that, so it is left alone.
      ...(flags.theme === undefined ? { printTheme: printTheme() } : {}),
      ...(registry === undefined ? {} : { registry }),
      source: loaded.source,
      sourceName: basename(loaded.path),
    },
    options,
  );

  await writeBinaryFile(io, out, bytes);
  term.status(`Wrote ${displayPath(io, out)} (${byteSize(bytes.byteLength)})`);
  return collected;
}

async function exportToSvg(
  io: CliIo,
  loaded: LoadedDocument,
  flags: ExportFlags,
  out: string,
  term: Term,
): Promise<void> {
  const blocks = selectBlocks(loaded.resolved, flags.block);
  if (blocks.length === 0) {
    throw usageError(
      `${loaded.display} has no visual blocks to export`,
      'An SVG export writes one file per visual block; this document has none.',
    );
  }

  const width = flags.width ?? DEFAULT_WIDTH;

  if (out === '-') {
    for (const block of blocks) {
      term.out(toSvgString(sceneFor(loaded.resolved, block, width)));
      term.out('\n');
    }
    return;
  }

  // One block, one file. Several blocks share the `-o` stem with the block id
  // appended, which keeps the names stable across runs and legible in a diff.
  if (blocks.length === 1) {
    const only = blocks[0] as (typeof blocks)[number];
    await writeTextFile(io, out, toSvgString(sceneFor(loaded.resolved, only, width)));
    term.status(`Wrote ${displayPath(io, out)}`);
    return;
  }

  const ext = extname(out) === '' ? '.svg' : extname(out);
  const stem = out.slice(0, out.length - ext.length);
  for (const block of blocks) {
    const path = `${stem}-${block.id}${ext}`;
    await writeTextFile(io, path, toSvgString(sceneFor(loaded.resolved, block, width)));
    term.status(`Wrote ${displayPath(io, path)}`);
  }
}

/** The resolved document as JSON: front matter, blocks, scenes, diagnostics. */
function documentJson(loaded: LoadedDocument, width: number): string {
  const payload = {
    source: basename(loaded.path),
    frontmatter: loaded.resolved.frontmatter ?? null,
    theme: loaded.resolved.theme.name,
    locale: loaded.resolved.config.locale,
    timezone: loaded.resolved.config.timezone,
    blocks: loaded.resolved.blocks.map((block) => ({
      id: block.id,
      index: block.index,
      type: block.blockType,
      level: block.level,
      failed: block.failed,
      attrs: block.attrs,
      table: { fields: block.table.fields, rows: block.table.rows },
      scene: sceneFor(loaded.resolved, block, width),
    })),
    diagnostics: [...loaded.doc.diagnostics, ...loaded.resolved.diagnostics].map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
      range: d.range,
      source: d.source,
    })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/** `mdv export --to <target>` (SPEC 28.11). */
export async function exportCommand(
  io: CliIo,
  files: readonly string[],
  flags: ExportFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  const input = singleInput(files, 'export');
  const target = resolveTarget(flags);

  if (!IMPLEMENTED.includes(target)) {
    const reason = UNIMPLEMENTED_REASON[target] ?? 'not implemented in this build';
    throw usageError(`\`--to ${target}\` is not implemented in this build`, `Why: ${reason}.`);
  }

  const loaded = await loadDocument(io, flags, input, term);
  const out = flags.out ?? defaultOut(io, absolute(io, input), target);

  let extra: readonly Diagnostic[] = [];
  switch (target) {
    case 'pdf':
      extra = await exportToPdf(io, loaded, flags, out, term);
      break;
    case 'svg':
      await exportToSvg(io, loaded, flags, out, term);
      break;
    case 'json': {
      const json = documentJson(loaded, flags.width ?? DEFAULT_WIDTH);
      if (out === '-') term.out(json);
      else {
        await writeTextFile(io, out, json);
        term.status(`Wrote ${displayPath(io, out)}`);
      }
      break;
    }
    case 'csv': {
      const block = selectBlock(loaded.resolved, flags.block ?? '0');
      const csv = tableToCsv(block.table);
      if (out === '-') term.out(csv);
      else {
        await writeTextFile(io, out, csv);
        term.status(`Wrote ${displayPath(io, out)} (${block.table.rows.length} rows)`);
      }
      break;
    }
    default:
      throw usageError(`\`--to ${target}\` is not implemented in this build`);
  }

  reportDiagnostics(term, loaded, extra);
  // Exit 4 when the document asked for data the policy refused: the file was
  // still written (with error cards, SPEC 14.1 principle 2), but CI must know.
  return outcomeFor(loaded, term);
}
