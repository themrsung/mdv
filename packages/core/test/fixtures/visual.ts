/**
 * Hand-built fixtures for the scale / encode / layout / a11y tests.
 *
 * Deliberately built by hand rather than parsed: these tests must not depend on
 * `@mdv/parser` or on the data agent's `resolve`, so a break anywhere else in
 * the tree cannot make the layout suite red for the wrong reason.
 */

import type { MdvBlock, Range } from '@mdv/parser';
import type {
  BlockAttrs,
  ChartType,
  Column,
  DataType,
  Encoding,
  ResolvedBlock,
  Table,
  Theme,
  Value,
} from '@mdv/core';

/** A zero-width range at the document start. */
export const RANGE: Range = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 },
};

/** The default light theme of SPEC 11.1, verbatim. */
export const THEME: Theme = {
  name: 'default',
  scheme: 'light',
  tokens: {
    surface: '#fcfcfb',
    page: '#f9f9f7',
    'text-primary': '#0b0b0b',
    'text-secondary': '#52514e',
    'text-muted': '#898781',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    border: 'rgba(11,11,11,0.10)',
    'success-text': '#006300',
  },
  type: {
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    fontSize: 13,
    titleScale: 1.23,
    tickScale: 0.85,
    lineHeight: 1.4,
  },
  metrics: { radius: 4, hairline: 1, gap: 2, ring: 2 },
  categorical: [
    '#2a78d6',
    '#eb6834',
    '#1baf7a',
    '#eda100',
    '#e87ba4',
    '#008300',
    '#4a3aa7',
    '#e34948',
  ],
  sequential: {
    hue: '#2a78d6',
    steps: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    ordinalFloor: 1,
    ordinalCeiling: 6,
  },
  diverging: {
    low: '#2a78d6',
    high: '#d03b3b',
    mid: '#f0efec',
    lowSteps: ['#cde2fb', '#6da7ec', '#2a78d6'],
    highSteps: ['#f5c9c9', '#e58585', '#d03b3b'],
  },
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' },
  marks: {
    bar: { maxThickness: 24, cornerRadius: 4, squareAtBaseline: true },
    line: { width: 2, join: 'round', cap: 'round' },
    marker: { minDiameter: 8, ringWidth: 2 },
    area: { fillOpacity: 0.1 },
    grid: { width: 1, dashed: false },
    spacer: { surfaceGap: 2, surfaceRing: 2 },
  },
};

/** Build a table from a header spec and rows. */
export function table(fields: readonly [string, DataType][], rows: readonly Value[][]): Table {
  return {
    fields: fields.map(([name, type]): Column => ({ name, type })),
    rows: rows.map((row) => [...row]),
  };
}

/** Quarterly revenue: the running example of SPEC 12.2. */
export const QUARTERS: Table = table(
  [
    ['quarter', 'category'],
    ['revenue', 'number'],
  ],
  [
    ['Q1', 1240],
    ['Q2', 1510],
    ['Q3', 1702],
    ['Q4', 1893],
  ],
);

/** Two series in long form. */
export const LONG_FORM: Table = table(
  [
    ['quarter', 'category'],
    ['metric', 'category'],
    ['amount', 'number'],
  ],
  [
    ['Q1', 'revenue', 1240],
    ['Q1', 'profit', 210],
    ['Q2', 'revenue', 1510],
    ['Q2', 'profit', 260],
  ],
);

/** A synthetic `MdvBlock` AST node, enough for a `ResolvedBlock`. */
export function astNode(blockType: string): MdvBlock {
  return {
    type: 'mdvBlock',
    blockType,
    attrs: {},
    attrsPosition: {},
    raw: { header: '', data: '', fence: '```' },
    level: 1,
  };
}

/** Options for {@link resolvedBlock}. */
export interface BlockOptions {
  blockType?: string;
  attrs?: BlockAttrs;
  encoding?: Encoding;
  table?: Table;
  index?: number;
  failed?: boolean;
}

/** A `ResolvedBlock` with every required field filled in. */
export function resolvedBlock(options: BlockOptions = {}): ResolvedBlock {
  const blockType = options.blockType ?? 'bar';
  const data = options.table ?? QUARTERS;
  return {
    id: `mdv-${options.index ?? 0}`,
    index: options.index ?? 0,
    blockType,
    level: 1,
    attrs: options.attrs ?? {},
    encoding: options.encoding ?? { x: { field: 'quarter' }, y: { field: 'revenue' } },
    table: data,
    tableRef: { datasetId: '#block-0', key: 'fixture' },
    node: astNode(blockType),
    range: RANGE,
    theme: THEME,
    diagnostics: [],
    failed: options.failed ?? false,
  };
}

/** The channel declarations a simple bar-like type accepts. */
export const XY_CHANNELS: ChartType['channels'] = [
  {
    name: 'x',
    required: true,
    accepts: ['category', 'string', 'date', 'datetime', 'number', 'integer'],
    doc: 'Horizontal position.',
  },
  {
    name: 'y',
    required: true,
    accepts: ['number', 'integer'],
    list: true,
    doc: 'Vertical position.',
  },
  { name: 'series', required: false, accepts: ['category', 'string'], doc: 'Splits rows.' },
];
