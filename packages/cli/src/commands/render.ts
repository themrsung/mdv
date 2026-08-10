/**
 * `mdv render` (SPEC 27).
 *
 * ```text
 * mdv render report.mdv              # the text backend, in the terminal
 * mdv render report.mdv -o chart.svg # one SVG per visual block
 * ```
 *
 * The terminal form is a real backend, not a summary: it prints the accessible
 * name, the generated description and the table view *off the same `Scene`* the
 * SVG and the PDF draw (SPEC 12, SPEC 20). If a chart reads badly here, a screen
 * reader user is hearing the same thing.
 */

import { extname } from 'node:path';

import { toSvgString } from '@mdv/render-svg';
import type { A11yTable, ResolvedBlock, Scene } from '@mdv/core';

import type { GlobalFlags } from '../args.js';
import { usageError } from '../exit.js';
import { displayPath, writeTextFile } from '../io.js';
import type { CliIo } from '../io.js';
import { loadDocument, outcomeFor, singleInput } from '../pipeline.js';
import { DEFAULT_WIDTH, sceneFor, selectBlocks } from '../scene.js';
import { countDiagnostics, summarise } from '../report.js';
import { createTerm } from '../term.js';
import type { Term } from '../term.js';

/** Flags `mdv render` accepts on top of the global ones. */
export interface RenderFlags extends GlobalFlags {
  out?: string;
  width?: number;
  block?: string;
  /** Rows of the table view to print in the terminal. @defaultValue 10 */
  rows?: number;
}

/** Longest display width in a column, counting codepoints. */
function widthOf(text: string): number {
  return [...text].length;
}

function pad(text: string, width: number, right: boolean): string {
  const gap = ' '.repeat(Math.max(0, width - widthOf(text)));
  return right ? `${gap}${text}` : `${text}${gap}`;
}

/**
 * The table view as aligned text.
 *
 * The cells are already formatted strings (SPEC 12.3 — "the exporter and the DOM
 * renderer must not re-format"), so this only aligns them.
 */
function tableView(table: A11yTable, maxRows: number): string[] {
  if (table.columns.length === 0) return [];
  const shown = table.rows.slice(0, maxRows);
  const widths = table.columns.map((column, index) => {
    let width = widthOf(column.name);
    for (const row of shown) width = Math.max(width, widthOf(row[index] ?? ''));
    return width;
  });
  const right = table.columns.map((column) => column.align === 'right');

  const lines: string[] = [];
  lines.push(
    `  ${table.columns.map((c, i) => pad(c.name, widths[i] ?? 0, right[i] === true)).join('  ')}`,
  );
  lines.push(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const row of shown) {
    lines.push(
      `  ${table.columns.map((_, i) => pad(row[i] ?? '', widths[i] ?? 0, right[i] === true)).join('  ')}`,
    );
  }
  const hidden = table.rows.length - shown.length;
  if (hidden > 0) lines.push(`  … ${hidden} more row${hidden === 1 ? '' : 's'}`);
  return lines;
}

/** One block, rendered as text. */
function renderBlockText(term: Term, block: ResolvedBlock, scene: Scene, rows: number): string {
  const head =
    `${term.bold(block.id)}  ${term.blue(block.blockType)}  ` +
    `${term.dim(`${Math.round(scene.width)}×${Math.round(scene.height)}`)}` +
    (block.failed ? `  ${term.red('failed')}` : '');

  const lines: string[] = [head, `  ${scene.a11y.name}`];
  const desc = scene.a11y.desc;
  if (desc !== undefined && desc !== '') {
    lines.push(`  ${term.dim(desc)}${scene.a11y.descGenerated ? term.dim(' (generated)') : ''}`);
  }
  if (rows > 0) {
    const view = tableView(scene.a11y.table, rows);
    if (view.length > 0) {
      lines.push('');
      lines.push(...view);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** `mdv render` — the text backend, or SVG when `-o` names a file (SPEC 23.4). */
export async function renderCommand(
  io: CliIo,
  files: readonly string[],
  flags: RenderFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  const input = singleInput(files, 'render');
  const loaded = await loadDocument(io, flags, input, term);
  const width = flags.width ?? DEFAULT_WIDTH;
  const blocks = selectBlocks(loaded.resolved, flags.block);

  const out = flags.out;
  if (out !== undefined && out !== '-') {
    const ext = extname(out).toLowerCase();
    if (ext !== '.svg' && ext !== '') {
      throw usageError(
        `mdv render writes SVG; \`${out}\` is not an .svg file`,
        'Use `mdv export` for other targets: mdv export doc.mdv -o doc.pdf',
      );
    }
    if (blocks.length === 0) {
      throw usageError(`${loaded.display} has no visual blocks to render`);
    }
    if (blocks.length === 1) {
      const only = blocks[0] as ResolvedBlock;
      await writeTextFile(io, out, toSvgString(sceneFor(loaded.resolved, only, width)));
      term.status(`Wrote ${displayPath(io, out)}`);
    } else {
      const suffix = ext === '' ? '.svg' : ext;
      const stem = out.slice(0, out.length - ext.length);
      for (const block of blocks) {
        const path = `${stem}-${block.id}${suffix}`;
        await writeTextFile(io, path, toSvgString(sceneFor(loaded.resolved, block, width)));
        term.status(`Wrote ${displayPath(io, path)}`);
      }
    }
  } else if (out === '-') {
    for (const block of blocks) {
      term.out(toSvgString(sceneFor(loaded.resolved, block, width)));
      term.out('\n');
    }
  } else {
    const rows = flags.rows ?? 10;
    if (blocks.length === 0) {
      term.line(term.dim(`${loaded.display}: no visual blocks`));
    }
    for (const block of blocks) {
      term.out(renderBlockText(term, block, sceneFor(loaded.resolved, block, width), rows));
    }
  }

  const diagnostics = [...loaded.doc.diagnostics, ...loaded.resolved.diagnostics];
  if (diagnostics.length > 0) {
    term.status(
      `${loaded.display}: ${summarise(countDiagnostics(diagnostics))} (run \`mdv lint ${loaded.display}\` for detail)`,
    );
  }
  return outcomeFor(loaded, term);
}
