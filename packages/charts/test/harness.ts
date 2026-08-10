/**
 * Hand-built fixtures for the `@mdv/charts` unit tests.
 *
 * Everything a chart type consumes that is owned by another package is stubbed
 * here rather than imported from its real implementation: the theme, the palette
 * allocator, text metrics, the id factory, the resolved block. That is a
 * deliberate constraint, not laziness — these tests must fail only when
 * `packages/charts` is wrong, and a shared fixture that imported `@mdv/themes`
 * would turn a palette tweak two directories away into a red test here.
 *
 * The stubs are **exact and boring**: `measure` returns a linear width so that
 * every assertion about text layout is arithmetic rather than font metrics, and
 * the palette hands out `#00000n` so a color assertion reads as a slot number.
 */

import type {
  BlockAttrs,
  ChartLayoutResult,
  ChartType,
  ColorScheme,
  ColorString,
  Column,
  ConformanceLevel,
  DataType,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  Encoding,
  Font,
  GlyphMetrics,
  IdFactory,
  LayoutContext,
  Mark,
  MdvBlock,
  PaletteAllocator,
  Rect,
  ResolvedBlock,
  SceneNode,
  Table,
  TextMetrics,
  Theme,
  Value,
} from '@mdv/core';
import { STATUS_PALETTE } from '@mdv/core';

// ─────────────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────────────

/** A column declaration in the compact form the fixtures use. */
export type FieldSpec = readonly [name: string, type: DataType];

/**
 * Build a {@link Table} by hand.
 *
 * Rows are given in row-major order, exactly as they appear in a Markdown table,
 * so a fixture reads like the document it stands in for.
 */
export function makeTable(fields: readonly FieldSpec[], rows: readonly (readonly Value[])[]): Table {
  const columns: Column[] = fields.map(([name, type]) => ({ name, type }));
  return { fields: columns, rows: rows.map((row) => [...row]) };
}

/** The empty table: no columns, no rows. Every type must survive it. */
export const EMPTY_TABLE: Table = { fields: [], rows: [] };

/** A table with columns but no rows — the "filter matched nothing" shape. */
export function noRows(fields: readonly FieldSpec[]): Table {
  return makeTable(fields, []);
}

/** Quarterly revenue: the running example for the cartesian types. */
export function quarters(): Table {
  return makeTable(
    [
      ['quarter', 'category'],
      ['revenue', 'number'],
    ],
    [
      ['Q1', 100],
      ['Q2', 200],
      ['Q3', 300],
      ['Q4', 400],
    ],
  );
}

/** Two series in long form, four rows each. */
export function twoSeries(): Table {
  return makeTable(
    [
      ['quarter', 'category'],
      ['region', 'category'],
      ['revenue', 'number'],
    ],
    [
      ['Q1', 'North', 10],
      ['Q1', 'South', 30],
      ['Q2', 'North', 20],
      ['Q2', 'South', 20],
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────

/** Eight distinguishable slots. The digit is the slot index, for readability. */
const CATEGORICAL: readonly ColorString[] = [
  '#111180',
  '#118011',
  '#801111',
  '#118080',
  '#801180',
  '#808011',
  '#404040',
  '#a0a0a0',
];

/**
 * A complete {@link Theme} whose numbers match the SPEC 11.4 defaults.
 *
 * The mark spec is where the tests bite: `maxThickness: 24`, `cornerRadius: 4`,
 * `surfaceGap: 2` and `surfaceRing: 2` are the normative values, and several
 * geometry assertions are written in terms of them rather than in terms of
 * literals, so a theme that violated the spec would fail loudly.
 */
export function makeTheme(scheme: ColorScheme = 'light'): Theme {
  return {
    name: 'test',
    scheme,
    tokens: {
      surface: '#ffffff',
      page: '#ffffff',
      'text-primary': '#1a1a1a',
      'text-secondary': '#4a4a4a',
      'text-muted': '#767676',
      grid: '#e6e6e6',
      axis: '#c8c8c8',
      border: '#d4d4d4',
      'success-text': '#0a7a0a',
    },
    type: {
      fontFamily: 'system-ui, sans-serif',
      fontSize: 13,
      titleScale: 1.2,
      tickScale: 0.85,
      lineHeight: 1.4,
    },
    metrics: { radius: 4, hairline: 1, gap: 8, ring: 2 },
    categorical: CATEGORICAL,
    sequential: {
      hue: '#118080',
      steps: ['#e6f4f4', '#bfe3e3', '#8fcccc', '#5bb0b0', '#2f9090', '#118080', '#0b5f5f'],
      ordinalFloor: 1,
      ordinalCeiling: 5,
    },
    diverging: {
      low: '#801111',
      high: '#111180',
      mid: '#f2f2f2',
      lowSteps: ['#801111', '#b05555', '#d9a0a0'],
      highSteps: ['#a0a0d9', '#5555b0', '#111180'],
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A {@link PaletteAllocator} that assigns slots in first-request order.
 *
 * First-request order is the contract (SPEC 11.2 rule 1: "color follows the
 * entity, not its rank"), and this stub keeps the assignment in a `Map` so a test
 * can prove a series keeps its color when another is filtered out.
 *
 * @param size - usable slots before overflow. Pass `3` to simulate the all-pairs
 * cap of SPEC 11.2 rule 3.
 */
export function makePalette(size = 8): PaletteAllocator & { readonly assigned: ReadonlyMap<string, number> } {
  const slots = new Map<string, number>();
  let next = 0;

  const slot = (seriesId: string): number => {
    const existing = slots.get(seriesId);
    if (existing !== undefined) return existing;
    const assigned = next < size ? next : -1;
    next += 1;
    slots.set(seriesId, assigned);
    return assigned;
  };

  return {
    size,
    slot,
    color(seriesId: string): ColorString {
      const index = slot(seriesId);
      return index < 0 ? '#8c8c8c' : (CATEGORICAL[index] ?? '#8c8c8c');
    },
    isOverflow(seriesId: string): boolean {
      return slot(seriesId) < 0;
    },
    patternDef(): string | undefined {
      return undefined;
    },
    assigned: slots,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics and ids
// ─────────────────────────────────────────────────────────────────────────────

/** Nominal advance per character, as a fraction of the font size. */
export const CHAR_WIDTH_RATIO = 0.6;

/**
 * Text metrics with a closed-form answer: `width = length × size × 0.6`.
 *
 * Real metrics are a width table; a test that asserted against one would be
 * asserting the table. This makes every width in the suite predictable from the
 * string alone.
 */
export function makeMetrics(): TextMetrics {
  return {
    measure(text: string, font: Font): GlyphMetrics {
      const size = font.size;
      return {
        width: text.length * size * CHAR_WIDTH_RATIO,
        ascent: size * 0.8,
        descent: size * 0.2,
      };
    },
  };
}

/** `mdv-{index}-{infix-}{counter}`, exactly as SPEC 24.3 rule 7 specifies. */
export function makeIds(blockIndex = 0): IdFactory {
  let counter = 0;
  const next = (infix?: string): string => {
    counter += 1;
    return infix === undefined ? `mdv-${blockIndex}-${counter}` : `mdv-${blockIndex}-${infix}-${counter}`;
  };
  return { next: next as IdFactory['next'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks and contexts
// ─────────────────────────────────────────────────────────────────────────────

/** Options shared by {@link makeBlock} and {@link runChart}. */
export interface BlockOptions {
  blockType?: string;
  attrs?: BlockAttrs;
  encoding?: Encoding;
  level?: ConformanceLevel;
  id?: string;
  index?: number;
}

/**
 * An attribute bag written the way an author writes one.
 *
 * `BlockAttrs` models the *common* attributes of SPEC 8.1 with concrete types
 * and lets everything a single type owns through an index signature. Two of
 * those common names are also spelled differently by a per-type block, and the
 * narrow declaration wins:
 *
 * - `columns` is `number` (SPEC 7.6, "wrap facets after this many"), but SPEC
 *   10.1 spells the `table` block's per-column configuration `columns:` as a
 *   *map*;
 * - `format` is `DataFormat` (SPEC 6.2, the data-section syntax), but SPEC 8.13
 *   spells `metric`'s number format `format: "$~s"`.
 *
 * The library side is unaffected — it reads both through `recordAttr` /
 * `stringAttr`, which narrow from `unknown` — so this cast is confined to the
 * fixtures rather than papered over by widening a shared type.
 */
export function attrsOf(value: Readonly<Record<string, unknown>>): BlockAttrs {
  return value as BlockAttrs;
}

const ZERO_POSITION = { offset: 0, line: 1, column: 1 } as const;

function makeNode(blockType: string, attrs: BlockAttrs): MdvBlock {
  return {
    type: 'mdvBlock',
    blockType,
    attrs: attrs as MdvBlock['attrs'],
    attrsPosition: {},
    raw: { header: '', data: '', fence: '```' },
    level: 1,
  };
}

/** A {@link ResolvedBlock} over a hand-built table. */
export function makeBlock(table: Table, options: BlockOptions = {}): ResolvedBlock {
  const blockType = options.blockType ?? 'bar';
  const attrs = options.attrs ?? {};
  return {
    id: options.id ?? 'block-test',
    index: options.index ?? 0,
    blockType,
    level: options.level ?? 1,
    attrs,
    encoding: options.encoding ?? {},
    table,
    tableRef: { datasetId: '#block-0', key: 'test' },
    node: makeNode(blockType, attrs),
    range: { start: ZERO_POSITION, end: ZERO_POSITION },
    theme: makeTheme(),
    diagnostics: [],
    failed: false,
  };
}

/** A pinned build time, so nothing in the suite reads the wall clock. */
export const BUILD_TIME = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));

/** An {@link EncodeInput} plus the array its diagnostics land in. */
export interface EncodeHarness {
  input: EncodeInput;
  diagnostics: Diagnostic[];
}

/** Build an {@link EncodeInput} over a hand-built table. */
export function makeEncodeInput(table: Table, options: BlockOptions = {}): EncodeHarness {
  const block = makeBlock(table, options);
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    input: {
      block,
      table,
      encoding: block.encoding,
      attrs: block.attrs,
      theme: block.theme,
      level: options.level ?? 1,
      palette: makePalette(),
      locale: 'en-US',
      timezone: 'UTC',
      buildTime: BUILD_TIME,
      diagnostic(d: Diagnostic): void {
        diagnostics.push(d);
      },
    },
  };
}

/** A {@link LayoutContext} plus the array its diagnostics land in. */
export interface LayoutHarness {
  ctx: LayoutContext;
  diagnostics: Diagnostic[];
}

/** Build a {@link LayoutContext}. */
export function makeLayoutContext(options: { level?: ConformanceLevel; blockIndex?: number } = {}): LayoutHarness {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    ctx: {
      theme: makeTheme(),
      colorScheme: 'light',
      metrics: makeMetrics(),
      locale: 'en-US',
      timezone: 'UTC',
      level: options.level ?? 1,
      buildTime: BUILD_TIME,
      ids: makeIds(options.blockIndex ?? 0),
      a11y: { texture: false, tableView: 'details', generateDesc: true },
      animate: false,
      diagnostic(d: Diagnostic): void {
        diagnostics.push(d);
      },
    },
  };
}

/** The plot frame used by most tests: 400 × 200 at the origin, no offset. */
export const FRAME: Rect = { x: 0, y: 0, width: 400, height: 200 };

// ─────────────────────────────────────────────────────────────────────────────
// Driving a chart type
// ─────────────────────────────────────────────────────────────────────────────

/** Everything one full pass through a chart type produced. */
export interface ChartRun<M extends Mark = Mark> {
  block: ResolvedBlock;
  table: Table;
  /** What `validate` returned. */
  validation: Diagnostic[];
  encoded: EncodeResult<M>;
  laid: ChartLayoutResult;
  /** Diagnostics reported through `EncodeInput.diagnostic`. */
  encodeDiagnostics: Diagnostic[];
  /** Diagnostics reported through `LayoutContext.diagnostic`. */
  layoutDiagnostics: Diagnostic[];
  /** Every diagnostic from every stage, in stage order. */
  diagnostics: Diagnostic[];
  description: string | undefined;
}

/**
 * Run `validate` → `encode` → `layout` → `describe`, exactly as core would.
 *
 * Core skips `encode` when `validate` returns an error; this harness does not,
 * on purpose. A type must not produce NaN geometry even for a block it rejected,
 * because an author fixing one of two errors will render the half-valid block.
 */
export function runChart<M extends Mark>(
  type: ChartType<M>,
  table: Table,
  options: BlockOptions & { frame?: Rect; palette?: PaletteAllocator } = {},
): ChartRun<M> {
  const blockOptions: BlockOptions = { blockType: type.name, ...options };
  const harness = makeEncodeInput(table, blockOptions);
  const input = options.palette === undefined ? harness.input : { ...harness.input, palette: options.palette };
  const validation = type.validate(input.block, table);
  const encoded = type.encode(input);

  const layoutHarness = makeLayoutContext({
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.index === undefined ? {} : { blockIndex: options.index }),
  });
  const laid = type.layout(encoded, options.frame ?? FRAME, layoutHarness.ctx);

  const description = type.describe?.({
    block: input.block,
    table,
    encoded,
    locale: 'en-US',
    timezone: 'UTC',
  });

  return {
    block: input.block,
    table,
    validation,
    encoded,
    laid,
    encodeDiagnostics: harness.diagnostics,
    layoutDiagnostics: layoutHarness.diagnostics,
    diagnostics: [...validation, ...harness.diagnostics, ...layoutHarness.diagnostics],
    ...(description === undefined ? {} : { description }),
  } as ChartRun<M>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertions
// ─────────────────────────────────────────────────────────────────────────────

/** One number found somewhere in a structure, with the path that reached it. */
export interface FoundNumber {
  path: string;
  value: number;
}

/**
 * Every number anywhere in a value, with its path.
 *
 * Deliberately structural rather than typed against {@link SceneNode}: the point
 * of the NaN-freedom tests is to catch a `NaN` in a field nobody thought to
 * check, which a hand-written walker over the known node shapes would miss the
 * moment a new field appeared.
 */
export function collectNumbers(value: unknown, path = '$'): FoundNumber[] {
  if (typeof value === 'number') return [{ path, value }];
  if (value === null || typeof value !== 'object') return [];
  if (value instanceof Date) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectNumbers(entry, `${path}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
    collectNumbers(entry, `${path}.${key}`),
  );
}

/**
 * The paths of every non-finite number in a value.
 *
 * Returns paths rather than a boolean so a failure names the field: `"NaN at
 * $.nodes[3].r[2]"` is a bug report, `"expected true"` is not.
 */
export function nonFiniteNumbers(value: unknown, path = '$'): string[] {
  return collectNumbers(value, path)
    .filter((found) => !Number.isFinite(found.value))
    .map((found) => `${found.path} = ${String(found.value)}`);
}

/** Flatten a scene-node tree to a list, depth-first in paint order. */
export function flattenNodes(nodes: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (node: SceneNode): void => {
    out.push(node);
    if (node.kind === 'group') for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}

/** Every node of one kind, depth-first in paint order. */
export function nodesOfKind<K extends SceneNode['kind']>(
  nodes: readonly SceneNode[],
  kind: K,
): Extract<SceneNode, { kind: K }>[] {
  return flattenNodes(nodes).filter((node): node is Extract<SceneNode, { kind: K }> => node.kind === kind);
}

/** Diagnostic codes in order, for `expect(codesOf(run)).toContain('MDV3021')`. */
export function codesOf(source: { diagnostics: readonly Diagnostic[] } | readonly Diagnostic[]): string[] {
  const list = Array.isArray(source) ? source : (source as { diagnostics: readonly Diagnostic[] }).diagnostics;
  return list.map((d) => d.code);
}
