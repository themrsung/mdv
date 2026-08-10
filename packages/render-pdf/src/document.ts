/**
 * The export pipeline: resolved document → flowed → paginated → rendered.
 *
 * Everything here is **synchronous and pure** given its inputs. Nothing reads a
 * clock, a locale or a filesystem, and nothing writes bytes — that is
 * `writer.ts`'s job. Splitting the two is what makes the operator-trace fixtures
 * of SPEC 28.10 possible: `tracePdf` runs exactly this code and stops.
 *
 * The one non-obvious step is the table-of-contents fixpoint. The contents list
 * page numbers, and the contents themselves occupy pages, so the numbers depend
 * on the list that depends on the numbers. Pagination is re-run until the
 * entries stop changing (SPEC 28.2 says the contents are generated from the
 * headings; it does not say how, and iterating to a fixpoint is the only way to
 * be right rather than approximately right).
 */

import { layoutBlock } from '@mdv/core';
import type {
  Diagnostic,
  LayoutContext,
  ResolvedBlock,
  ResolvedDocument,
  Scene,
  TextMetrics,
  Theme,
} from '@mdv/core';

import { buildFlow, runsText } from './flow.js';
import type { FlowDocument, FlowItem, HeadingItem, ParagraphItem } from './flow.js';
import { createDocStyle } from './style.js';
import type { DocStyle } from './style.js';
import { paginate, tocEntries } from './paginate.js';
import type { BlockLayout, BlockSize, PaginateResult, TocEntry } from './paginate.js';
import { render } from './render.js';
import type { RenderResult, RunningContext } from './render.js';
import { mergePdfOptions, pdfOptionsFromFrontMatter, resolveOptions } from './options.js';
import type { PdfExportOptions, ResolvedPdfOptions } from './options.js';
import { naturalSize } from './size.js';
import { renderDiagnostic } from './diagnostics.js';
import { ptToPx } from './units.js';

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

/** A font available to the exporter (SPEC 28.6). */
export interface EmbeddedFont {
  /** Family name as it appears in `Font.family`. */
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** The font file. Subsetted on export; glyphs are emitted in codepoint order. */
  data: Uint8Array;
}

/** Everything the exporter needs beyond the document itself. */
export interface PdfExportContext {
  /**
   * Fonts to embed. Text is real and subsetted, never outlined. A glyph with no
   * font produces `MDV5100`.
   *
   * **Not honoured by this build.** Embedding is not implemented; the standard
   * 14 faces are used instead and the field is accepted so that callers written
   * against the contract keep compiling. See the package README.
   */
  fonts: readonly EmbeddedFont[];
  /**
   * Metrics used for layout. MUST measure the faces that will actually be drawn
   * — measuring with one font and drawing with another is how PDF pagination
   * comes to disagree with the screen. Use `createStandardFontMetrics()` unless
   * you have embedded faces.
   */
  metrics: TextMetrics;
  /** Pins creation and modification dates (SPEC 28.10). */
  buildTime: Date;
  /** Collected during export: `MDV5100`, `MDV5101`, `MDV5110`, `MDV5120`. */
  onDiagnostic?: (d: Diagnostic) => void;

  /**
   * The chart-type registry. Passed through to `layoutBlock`, which needs it to
   * find a block's layout function; without one, only the built-in types
   * resolve. `@mdv/render-pdf` does not depend on `@mdv/charts`, so the host
   * supplies it.
   */
  registry?: unknown;
  /**
   * The theme to print with, normally the `print` theme (SPEC 28.5). Defaults to
   * the document's own resolved theme.
   */
  printTheme?: Theme | undefined;
  /** The original `.mdv` text, for `embedSource` (SPEC 28.9). */
  source?: string | Uint8Array | undefined;
  /** File name recorded for the attachment. @defaultValue `'source.mdv'` */
  sourceName?: string | undefined;
  /** Resolve an `image` href to bytes. Backends never fetch (SPEC 20). */
  resolveImage?:
    | ((href: string) => { format: 'png' | 'jpg'; bytes: Uint8Array } | undefined)
    | undefined;
}

/**
 * `layoutBlock` reads the registry off the context when it is not passed
 * positionally, which is the only way to hand it one through a declaration that
 * predates the parameter.
 */
interface LayoutContextWithRegistry extends LayoutContext {
  registry?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/** Document-level metadata for the info dictionary and XMP (SPEC 28.9). */
export interface DocumentMeta {
  title: string;
  subtitle: string;
  author: string;
  subject: string;
  keywords: readonly string[];
  /** The document's own `date:`, verbatim. Never a clock reading. */
  date: string;
  lang: string;
  locale: string;
  theme: string;
}

/** Everything the writer needs, and everything a trace is built from. */
export interface PdfBuild {
  options: ResolvedPdfOptions;
  style: DocStyle;
  flow: FlowDocument;
  pagination: PaginateResult;
  rendered: RenderResult;
  meta: DocumentMeta;
  diagnostics: readonly Diagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout adapter
// ─────────────────────────────────────────────────────────────────────────────

/** `mdv-{blockIndex}-{counter}` (SPEC 24.3 rule 7). */
function createIds(blockIndex: number): { next(infix?: string): string } {
  let counter = 0;
  return {
    next(infix?: string): string {
      counter += 1;
      const n = String(counter);
      return infix === undefined
        ? `mdv-${String(blockIndex)}-${n}`
        : `mdv-${String(blockIndex)}-${infix}-${n}`;
    },
  };
}

/**
 * A scene that says, in the document, that a block could not be laid out.
 *
 * Not an empty scene: a blank rectangle where a chart should be is the failure
 * mode SPEC 21 exists to prevent. The box is drawn, `MDV5000` is reported, and
 * the accessible name says the same thing the ink does.
 */
function failedScene(block: ResolvedBlock, width: number, height: number, theme: Theme): Scene {
  const message = `Block failed to render: ${block.blockType}`;
  return {
    width,
    height,
    defs: [],
    root: {
      kind: 'group',
      id: `mdv-${String(block.index)}-failed`,
      children: [
        {
          kind: 'rect',
          x: 0.5,
          y: 0.5,
          w: Math.max(1, width - 1),
          h: Math.max(1, height - 1),
          stroke: { paint: { kind: 'solid', color: theme.tokens.border }, width: 1 },
        },
        {
          kind: 'text',
          x: width / 2,
          y: height / 2,
          text: message,
          font: { family: theme.type.fontFamily, size: theme.type.fontSize },
          fill: { kind: 'solid', color: theme.tokens['text-secondary'] },
          anchor: 'middle',
          baseline: 'middle',
        },
      ],
    },
    a11y: {
      role: 'img',
      name: message,
      descGenerated: true,
      table: { caption: '', columns: [], rows: [], presentation: 'none' },
      focusOrder: [],
    },
    hitIndex: [],
    meta: {
      blockId: block.id,
      type: block.blockType,
      theme: theme.name,
      version: '0.0.0',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Link appendix (SPEC 28.7)
// ─────────────────────────────────────────────────────────────────────────────

const APPENDIX_ANCHOR = 'mdv-link-appendix';

/**
 * Append the list of external URLs.
 *
 * Paper cannot be clicked. When the author asks for it, every external target
 * is printed once, in first-appearance order, so the reader can type it.
 */
function withLinkAppendix(flow: FlowDocument, title: string): FlowDocument {
  if (flow.externalLinks.length === 0) return flow;
  const heading: HeadingItem = {
    kind: 'heading',
    level: 2,
    runs: [{ text: title }],
    text: title,
    id: APPENDIX_ANCHOR,
    indent: 0,
    quoteDepth: 0,
    keepWithNext: true,
    group: undefined,
    anchor: APPENDIX_ANCHOR,
  };
  const items: FlowItem[] = [...flow.items, heading];
  for (let i = 0; i < flow.externalLinks.length; i += 1) {
    const url = flow.externalLinks[i];
    if (url === undefined) continue;
    const entry: ParagraphItem = {
      kind: 'paragraph',
      role: 'listItem',
      runs: [{ text: url, mono: true }],
      marker: `${String(i + 1)}.`,
      listOrdinal: i + 1,
      listKind: 'ordered',
      callout: undefined,
      indent: 1,
      quoteDepth: 0,
      keepWithNext: false,
      group: undefined,
      anchor: undefined,
    };
    items.push(entry);
  }
  return { ...flow, items };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

function frontMatterString(doc: ResolvedDocument, key: 'title' | 'subtitle' | 'author' | 'date' | 'lang'): string {
  const value = doc.frontmatter?.[key];
  return typeof value === 'string' ? value : '';
}

function documentMeta(doc: ResolvedDocument, options: ResolvedPdfOptions, theme: Theme): DocumentMeta {
  const lang = frontMatterString(doc, 'lang');
  return {
    title: options.title ?? frontMatterString(doc, 'title'),
    subtitle: frontMatterString(doc, 'subtitle'),
    author: options.author ?? frontMatterString(doc, 'author'),
    subject: options.subject ?? frontMatterString(doc, 'subtitle'),
    keywords: options.keywords,
    date: frontMatterString(doc, 'date'),
    lang: lang === '' ? doc.config.locale : lang,
    locale: doc.config.locale,
    theme: theme.name,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/** How many times the contents may be re-paginated before we take what we have. */
const TOC_ROUNDS = 8;

function sameEntries(a: readonly TocEntry[], b: readonly TocEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as TocEntry;
    const y = b[i] as TocEntry;
    if (x.level !== y.level || x.title !== y.title || x.page !== y.page || x.dest !== y.dest) {
      return false;
    }
  }
  return true;
}

/**
 * Flow, paginate and render a document.
 *
 * @throws PdfProfileError when `profile: 'pdf-ua-1'` is requested and a figure
 * has no accessible description (`MDV5110`).
 */
export function buildPdf(
  doc: ResolvedDocument,
  ctx: PdfExportContext,
  opts?: PdfExportOptions,
): PdfBuild {
  const diagnostics: Diagnostic[] = [];
  const report = (d: Diagnostic): void => {
    diagnostics.push(d);
    ctx.onDiagnostic?.(d);
  };

  const options = resolveOptions(
    mergePdfOptions(pdfOptionsFromFrontMatter(doc.frontmatter?.pdf), opts),
  );
  const theme = ctx.printTheme ?? doc.theme;
  const style = createDocStyle(theme);
  const metrics = ctx.metrics;
  const meta = documentMeta(doc, options, theme);

  const flow = withLinkAppendix(
    buildFlow(doc, { restartAt: options.numbering.restartAt }),
    'Links',
  );

  const layout: BlockLayout = (block, widthPx, heightPx) => {
    const context: LayoutContextWithRegistry = {
      theme,
      colorScheme: doc.config.colorScheme,
      metrics,
      locale: doc.config.locale,
      timezone: doc.config.timezone,
      level: doc.config.level,
      buildTime: ctx.buildTime,
      ids: createIds(block.index),
      a11y: {
        // Grayscale printing loses hue, so the texture channel is not optional
        // there (SPEC 12.6, 28.5).
        texture: options.grayscale || doc.config.a11y.texture,
        tableView: options.expandTables ? 'visible' : doc.config.a11y.tableView,
        generateDesc: doc.config.a11y.generateDesc,
      },
      animate: false,
      diagnostic: report,
      registry: ctx.registry,
    };
    try {
      return layoutBlock(block, { width: widthPx, height: heightPx }, context);
    } catch (error) {
      report(
        renderDiagnostic('MDV5000', {
          blockId: block.id,
          range: block.range,
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      return failedScene(block, widthPx, heightPx, theme);
    }
  };

  const size: BlockSize = (block, columnPx) => naturalSize(block.attrs, columnPx, theme);

  const base = { flow, style, metrics, options, layout, size };
  let pagination = paginate(base);

  if (options.toc !== undefined) {
    const { depth, title, pageBreakAfter } = options.toc;
    let entries = tocEntries(pagination.outline, pagination.pages, depth, options.numbering.style, 0);
    for (let round = 0; round < TOC_ROUNDS; round += 1) {
      pagination = paginate({ ...base, toc: { title, entries, pageBreakAfter } });
      const next = tocEntries(
        pagination.outline,
        pagination.pages,
        depth,
        options.numbering.style,
        0,
      );
      if (sameEntries(entries, next)) break;
      entries = next;
    }
  }

  for (const d of pagination.diagnostics) report(d);

  const running: RunningContext = {
    title: meta.title,
    subtitle: meta.subtitle,
    author: meta.author,
    date: meta.date,
  };

  const rendered = render({
    pages: pagination.pages,
    style,
    metrics,
    options,
    destinations: pagination.destinations,
    running,
    lang: meta.lang,
    ...(ctx.resolveImage === undefined ? {} : { resolveImage: ctx.resolveImage }),
  });
  for (const d of rendered.diagnostics) report(d);

  return { options, style, flow, pagination, rendered, meta, diagnostics };
}

/** The width of the text column, in CSS pixels — what a block is laid out at. */
export function columnWidthPx(options: ResolvedPdfOptions): number {
  return ptToPx(options.page.widthPt - options.margins.leftPt - options.margins.rightPt);
}

/** Plain text of a flow item, for tests and for the CLI's `--verbose` output. */
export function itemText(item: FlowItem): string {
  switch (item.kind) {
    case 'heading':
      return item.text;
    case 'paragraph':
      return runsText(item.runs);
    case 'code':
      return item.lines.join('\n');
    case 'table':
      return item.caption ?? item.label ?? '';
    case 'visual':
      return item.label ?? item.block.blockType;
    default:
      return '';
  }
}
