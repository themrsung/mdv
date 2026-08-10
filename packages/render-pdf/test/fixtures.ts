/**
 * Fixtures for the PDF exporter's own tests.
 *
 * Everything a neighbouring package would normally produce — the theme, the
 * resolved config, the mdast tree, the `Scene` a chart lays out to — is built
 * here by hand. That is deliberate: these tests must fail when *this* package
 * regresses and at no other time, so they never run `@mdv/core`'s resolver or
 * `@mdv/charts`' layouts.
 */

import { STATUS_PALETTE } from '@mdv/core';
import type {
  DataRegistry,
  ResolvedBlock,
  ResolvedConfig,
  ResolvedDocument,
  Scene,
  Theme,
} from '@mdv/core';
import type {
  AttrMap,
  Blockquote,
  Code,
  FrontMatter,
  Heading,
  List,
  MdvBlock,
  MdvContent,
  MdvDirective,
  MdvDocument,
  Paragraph,
  Table,
  Text,
} from '@mdv/parser';

import { createStandardFontMetrics } from '../src/fonts.js';
import type { PdfExportContext } from '../src/document.js';

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────

/** A plain light theme with the SPEC 11.1 defaults. */
export const TEST_THEME: Theme = {
  name: 'print',
  scheme: 'light',
  tokens: {
    surface: '#f6f7f9',
    page: '#ffffff',
    'text-primary': '#111418',
    'text-secondary': '#4a5158',
    'text-muted': '#767d85',
    grid: '#e3e6ea',
    axis: '#b7bcc2',
    border: '#d3d7dc',
    'success-text': '#0a7c0a',
  },
  type: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 13,
    titleScale: 1.15,
    tickScale: 0.85,
    lineHeight: 1.45,
  },
  metrics: { radius: 4, hairline: 1, gap: 2, ring: 2 },
  categorical: [
    '#3b6ee0',
    '#e07b3b',
    '#3ba05f',
    '#a03b8c',
    '#c2a02e',
    '#3ba0a0',
    '#8c5a3b',
    '#6b6f76',
  ],
  sequential: {
    hue: '#3b6ee0',
    steps: ['#eaf0fd', '#c6d6f7', '#9cb8f0', '#6d94e7', '#3b6ee0', '#2b52a8', '#1c3671'],
    ordinalFloor: 2,
    ordinalCeiling: 6,
  },
  diverging: {
    low: '#3b6ee0',
    high: '#d03b3b',
    mid: '#9aa0a6',
    lowSteps: ['#9cb8f0', '#6d94e7', '#3b6ee0'],
    highSteps: ['#e79a9a', '#dd6b6b', '#d03b3b'],
  },
  status: STATUS_PALETTE,
  marks: {
    bar: { maxThickness: 24, cornerRadius: 4, squareAtBaseline: true },
    line: { width: 2, join: 'round', cap: 'round' },
    marker: { minDiameter: 8, ringWidth: 2 },
    area: { fillOpacity: 0.1 },
    grid: { width: 1, dashed: false },
    spacer: { surfaceGap: 2, surfaceRing: 2 },
  },
};

/** Pinned so nothing in the suite can read a clock (SPEC 24.3 rule 2). */
export const BUILD_TIME = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));

export const TEST_CONFIG: ResolvedConfig = {
  level: 2,
  strict: false,
  theme: TEST_THEME,
  colorScheme: 'light',
  locale: 'en-US',
  timezone: 'UTC',
  buildTime: BUILD_TIME,
  defaults: {},
  security: {
    allowExternal: false,
    allowedOrigins: [],
    allowHtml: false,
    allowFileUrls: false,
    maxDocumentBytes: 1_000_000,
    maxRowsPerBlock: 100_000,
    fetchTimeoutMs: 5000,
  },
  render: {
    target: 'svg',
    canvasThreshold: 5000,
    downsampleThreshold: 4000,
    animate: false,
    renderPolicy: 'eager',
    worker: false,
  },
  a11y: { texture: false, tableView: 'details', generateDesc: true },
  plugins: [],
  capabilities: {},
};

/** An empty dataset registry — no fixture here needs data. */
const EMPTY_REGISTRY: DataRegistry = {
  get: () => undefined,
  has: () => false,
  list: () => [],
  resolve: () => undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// mdast builders
// ─────────────────────────────────────────────────────────────────────────────

const ZERO = { line: 1, column: 1, offset: 0 };
const POSITION = { start: ZERO, end: ZERO };

export function text(value: string): Text {
  return { type: 'text', value };
}

export function paragraph(value: string): Paragraph {
  return { type: 'paragraph', children: [text(value)], position: POSITION };
}

export function heading(depth: 1 | 2 | 3 | 4 | 5 | 6, value: string): Heading {
  return { type: 'heading', depth, children: [text(value)], position: POSITION };
}

export function code(value: string, lang?: string): Code {
  return { type: 'code', value, lang: lang ?? null, meta: null, position: POSITION };
}

export function bulletList(items: readonly string[]): List {
  return {
    type: 'list',
    ordered: false,
    spread: false,
    children: items.map((item) => ({
      type: 'listItem' as const,
      spread: false,
      checked: null,
      children: [paragraph(item)],
      position: POSITION,
    })),
    position: POSITION,
  };
}

export function quote(value: string): Blockquote {
  return { type: 'blockquote', children: [paragraph(value)], position: POSITION };
}

export function table(head: readonly string[], rows: readonly (readonly string[])[]): Table {
  const row = (cells: readonly string[]) => ({
    type: 'tableRow' as const,
    children: cells.map((cell) => ({
      type: 'tableCell' as const,
      children: [text(cell)],
      position: POSITION,
    })),
    position: POSITION,
  });
  return {
    type: 'table',
    align: head.map(() => null),
    children: [row(head), ...rows.map(row)],
    position: POSITION,
  };
}

/** A visual block node. The `data` is never parsed here; layout is stubbed. */
export function mdvBlock(blockType: string, attrs: AttrMap = {}): MdvBlock {
  return {
    type: 'mdvBlock',
    blockType,
    attrs,
    attrsPosition: {},
    raw: { header: `\`\`\`mdv:${blockType}`, data: '', fence: '```' },
    level: 1,
    position: POSITION,
  };
}

/** A container directive, e.g. `:::mdv-figure{caption="…"}`. */
export function directive(
  name: string,
  attrs: AttrMap,
  children: readonly MdvContent[] = [],
): MdvDirective {
  return {
    type: 'mdvDirective',
    kind: 'container',
    name,
    attrs,
    attrsPosition: {},
    children: [...children],
    position: POSITION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentOptions {
  frontmatter?: FrontMatter;
  blocks?: readonly ResolvedBlock[];
}

/** Front matter with the bookkeeping fields the parser always fills in. */
export function frontMatter(fields: Partial<FrontMatter>): FrontMatter {
  return {
    extra: {},
    range: { start: ZERO, end: ZERO },
    attrsPosition: {},
    ...fields,
  };
}

export function resolvedDocument(
  children: readonly MdvContent[],
  options: DocumentOptions = {},
): ResolvedDocument {
  const ast: MdvDocument = {
    type: 'root',
    children: [...children],
    diagnostics: [],
    datasets: {},
    position: POSITION,
  };
  const doc: ResolvedDocument = {
    ast,
    blocks: options.blocks ?? [],
    datasets: EMPTY_REGISTRY,
    diagnostics: [],
    theme: TEST_THEME,
    config: TEST_CONFIG,
  };
  if (options.frontmatter !== undefined) {
    return { ...doc, frontmatter: options.frontmatter };
  }
  return doc;
}

/** A `ResolvedBlock` for a node produced by {@link mdvBlock}. */
export function resolvedBlock(
  node: MdvBlock,
  index: number,
  attrs: Record<string, unknown> = {},
): ResolvedBlock {
  return {
    id: `mdv-${String(index)}`,
    index,
    blockType: node.blockType,
    level: 1,
    attrs: { ...node.attrs, ...attrs },
    encoding: {},
    table: { fields: [], rows: [] },
    tableRef: { datasetId: `#block-${String(index)}`, key: `#block-${String(index)}` },
    node,
    range: { start: ZERO, end: ZERO },
    theme: TEST_THEME,
    diagnostics: [],
    failed: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A scene that stands in for whatever `@mdv/charts` would have produced: one
 * rectangle and one label, with a real accessible tree so the `/Alt` path is
 * exercised.
 */
export function stubScene(width: number, height: number, name: string, desc?: string): Scene {
  return {
    width,
    height,
    defs: [],
    root: {
      kind: 'group',
      id: 'mdv-0-root',
      children: [
        {
          kind: 'rect',
          x: 8,
          y: 8,
          w: Math.max(1, width - 16),
          h: Math.max(1, height - 16),
          fill: { kind: 'solid', color: TEST_THEME.categorical[0] ?? '#3b6ee0' },
        },
        {
          kind: 'text',
          x: 8,
          y: 20,
          text: name,
          font: { family: TEST_THEME.type.fontFamily, size: TEST_THEME.type.fontSize },
          fill: { kind: 'solid', color: TEST_THEME.tokens['text-primary'] },
          anchor: 'start',
          baseline: 'alphabetic',
        },
      ],
    },
    a11y: {
      role: 'figure',
      name,
      ...(desc === undefined ? {} : { desc }),
      descGenerated: desc === undefined,
      table: { caption: name, columns: [], rows: [], presentation: 'details' },
      focusOrder: [],
    },
    hitIndex: [],
    meta: { blockId: 'mdv-0', type: 'bar', theme: TEST_THEME.name, version: '0.0.0' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export context
// ─────────────────────────────────────────────────────────────────────────────

export function exportContext(over: Partial<PdfExportContext> = {}): PdfExportContext {
  return {
    fonts: [],
    metrics: createStandardFontMetrics(),
    buildTime: BUILD_TIME,
    printTheme: TEST_THEME,
    ...over,
  };
}

/** Lorem-ish filler that is deterministic and long enough to overflow pages. */
export function filler(index: number): string {
  const words = [
    'measurement',
    'baseline',
    'column',
    'orphan',
    'widow',
    'pagination',
    'operator',
    'stream',
    'glyph',
    'kerning',
    'descender',
    'leading',
  ];
  const out: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    out.push(words[(index * 7 + i * 3) % words.length] as string);
  }
  return `${out.join(' ')}.`;
}
