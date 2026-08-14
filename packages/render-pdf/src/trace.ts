/**
 * The operator trace (SPEC 28.10).
 *
 * Fixtures compare a trace, not bytes, so a `pdf-lib` upgrade does not fail
 * every golden file while a real geometry change still does. The trace is built
 * from the *same* operator list the writer serialises — not a re-derivation —
 * which is the only way a passing fixture can mean anything about the file.
 */

import { standardFontName } from './fonts.js';
import { argToTrace } from './ops.js';
import type { PdfBuild } from './document.js';
import type { StructElement } from './render.js';

/** One entry of a PDF operator trace. */
export interface PdfOperation {
  op: string;
  args: readonly (number | string)[];
}

/** A font resource name and the face the page allocated it for. */
export interface PdfFontTrace {
  /** Resource name, e.g. `F0`. */
  resource: string;
  /** The `BaseFont` the writer embeds for it, e.g. `Helvetica-Oblique`. */
  base: string;
}

/** A normalised operator trace for one page. */
export interface PdfPageTrace {
  pageIndex: number;
  width: number;
  height: number;
  operations: readonly PdfOperation[];
  /** Resource names referenced by the page, sorted. */
  resources: readonly string[];
  /**
   * The face behind every font resource, in allocation order.
   *
   * `resources` alone cannot catch a swapped face. Pools are per page, so `F1`
   * means whatever that page reached for second, and a regression that resolved
   * a run to Courier where it used to resolve to Helvetica would leave the rest
   * of the trace identical — same names, same widths only by luck (SPEC 11.1).
   */
  fonts: readonly PdfFontTrace[];
}

/** A flattened structure tree entry. */
export interface PdfStructTrace {
  tag: string;
  depth: number;
  alt?: string;
}

/** A normalised operator trace (SPEC 28.10). */
export interface PdfTrace {
  pages: readonly PdfPageTrace[];
  /** The tagged structure tree, flattened (SPEC 28.8). */
  structure: readonly PdfStructTrace[];
}

/** Pre-order flattening: the reading order, which is what a fixture asserts. */
function flatten(node: StructElement, depth: number, out: PdfStructTrace[]): void {
  const entry: PdfStructTrace = { tag: node.type, depth };
  if (node.alt !== undefined) entry.alt = node.alt;
  out.push(entry);
  for (const kid of node.kids) {
    if (kid.kind !== 'mcid') flatten(kid, depth + 1, out);
  }
}

/** Build the trace for a document that has already been flowed and rendered. */
export function buildTrace(build: PdfBuild): PdfTrace {
  const pages: PdfPageTrace[] = build.rendered.pages.map((page) => ({
    pageIndex: page.index,
    width: page.widthPt,
    height: page.heightPt,
    operations: page.ops.map((operation) => ({
      op: operation.op,
      args: operation.args.map(argToTrace),
    })),
    resources: page.pool.names(),
    fonts: page.pool.fonts.map(({ resource, key }) => ({
      resource,
      base: standardFontName(key) as string,
    })),
  }));

  const structure: PdfStructTrace[] = [];
  flatten(build.rendered.structure, 0, structure);

  return { pages, structure };
}
