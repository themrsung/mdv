/**
 * `@mdv/render-pdf` — scene graph + document flow → PDF (SPEC 28).
 *
 * The **direct** exporter is normative: the same `Scene` that draws the screen
 * emits the PDF operators, so a chart cannot look different in the export. There
 * is no headless browser and no CSS re-implementation, and — more importantly —
 * there is no second layout path, so pagination can never disagree with the
 * viewport about whether a label fits.
 *
 * Byte-identical output requires pinning (SPEC 28.10): `buildTime`, the document
 * `/ID` (a hash of content + buildTime, never random), object numbering
 * (allocation in a fixed traversal order), and a fixed deflate — or
 * `compress: false` for tests.
 *
 * ## What this build does not do
 *
 * **Fonts are the standard 14 faces (SPEC 28.6 is only partly implemented).**
 * No font binary is embedded or subsetted, so coverage is WinAnsi: a codepoint
 * outside it is reported as `MDV5100` and drawn as `?`, and a script needing
 * contextual shaping or bidi is reported as `MDV5101` and drawn unshaped. All
 * measurement goes through the injected `TextMetrics`, and `fonts.ts` is
 * structured so a fontkit-backed `FaceMetrics` plus an embedding step drops in
 * behind the same interface. See the package README.
 */

import type { ResolvedDocument, Scene } from '@mdv/core';

import { buildPdf } from './document.js';
import type { PdfExportContext } from './document.js';
import type { PdfExportOptions } from './options.js';
import { writePdf } from './writer.js';
import { buildTrace } from './trace.js';
import type { PdfTrace } from './trace.js';
import { createFontkitMetrics } from './metrics.js';

/**
 * Export a resolved document to PDF (SPEC 28).
 *
 * Flows the document, paginates it, lays every block out through the same
 * layout engine the screen uses, and emits tagged content so the accessible
 * name, description and table view survive into the PDF (SPEC 28.8).
 *
 * @throws PdfProfileError when `profile: 'pdf-ua-1'` is requested and a figure
 * has no accessible description — `MDV5110` is also emitted. PDF/UA is a promise
 * the exporter must not break silently.
 * @throws PdfUnitError for a malformed page size or margin (host configuration
 * error, SPEC 21).
 */
export async function exportPdf(
  doc: ResolvedDocument,
  ctx: PdfExportContext,
  opts?: PdfExportOptions,
): Promise<Uint8Array> {
  return writePdf(buildPdf(doc, ctx, opts), ctx);
}

/** Produce the operator trace for a document, without writing a file. */
export function tracePdf(
  doc: ResolvedDocument,
  ctx: PdfExportContext,
  opts?: PdfExportOptions,
): Promise<PdfTrace> {
  // Async to match the contract's signature; the work is synchronous, and a
  // caller awaiting it must not be able to observe a partially built trace.
  return Promise.resolve(buildTrace(buildPdf(doc, ctx, opts)));
}

/** Flow and render without serialising — the seam the CLI and the tests use. */
export { buildPdf } from './document.js';
export { buildTrace } from './trace.js';
export { writePdf, xmpPacket, serializeOps, PRODUCER } from './writer.js';
export { drawSceneOnPage } from './embed.js';

/**
 * The exact text-metrics provider (SPEC 21 `FontkitMetrics`): measurements come
 * from the embedded font file, so PDF and screen agree to the glyph.
 *
 * **This build cannot embed the fonts it measures.** Use
 * {@link createStandardFontMetrics} unless you are measuring for a target other
 * than this exporter.
 */
export { createFontkitMetrics };

export {
  createStandardFontMetrics,
  classifyFamily,
  fontKeyOf,
  standardFace,
  standardFontName,
  needsShaping,
  toWinAnsi,
  encodableInWinAnsi,
} from './fonts.js';

export { drawScene, PRINT_POLICY } from './paint.js';
export { ResourcePool } from './resources.js';
export { paginate, tocEntries, sceneAlt, MIN_BLOCK_SCALE } from './paginate.js';
export { buildFlow, slugify, runsText } from './flow.js';
export { createDocStyle, HEADING_SCALE } from './style.js';
export { render, interpolateRunning } from './render.js';
export { naturalSize, resolveLengthPx } from './size.js';
export { documentId } from './hash.js';
export {
  resolveOptions,
  formatPageNumber,
  pdfOptionsFromFrontMatter,
  mergePdfOptions,
} from './options.js';
export {
  PT_PER_PX,
  PX_PER_PT,
  PAGE_SIZE_NAMES,
  PdfUnitError,
  parseLengthPt,
  resolvePageSize,
  resolveMargins,
  orient,
  pxToPt,
  ptToPx,
} from './units.js';
export { PdfProfileError, renderDiagnostic } from './diagnostics.js';
export { roundTo, formatNumber } from './number.js';
export { FontLoadError } from './metrics.js';

export type { EmbeddedFont, PdfExportContext, PdfBuild, DocumentMeta } from './document.js';
export type {
  PdfExportOptions,
  ResolvedPdfOptions,
  RunningSlots,
  NumberingStyle,
} from './options.js';
export type { PdfOperation, PdfPageTrace, PdfStructTrace, PdfTrace } from './trace.js';
export type {
  Drawable,
  Destination,
  OutlineEntry,
  PageElement,
  PaginateInput,
  PaginateResult,
  PdfPage,
  TocEntry,
  BlockLayout,
  BlockSize,
} from './paginate.js';
export type {
  LinkAnnotation,
  RenderInput,
  RenderResult,
  RenderedPage,
  RunningContext,
  StructElement,
  StructKid,
  StructRef,
} from './render.js';
export type {
  FlowDocument,
  FlowItem,
  FlowNote,
  FlowTarget,
  HeadingItem,
  ParagraphItem,
  TableItem,
  VisualItem,
} from './flow.js';
export type { DocStyle } from './style.js';
export type { LineBox, PlacedRun, TextRun, TextStyle } from './text.js';
export type { PdfArg, PdfOp } from './ops.js';
export type { FaceMetrics, FontKey, GenericFamily } from './fonts.js';
export type { Margins, PageBox } from './units.js';
export type { PrintPolicy, ScenePlacement, SceneDrawResult } from './paint.js';

export type { PdfOptions } from '@mdv/core';

/** Re-exported so a host can type a scene it is about to embed. */
export type { Scene };
