/**
 * `table` — the enhanced table block (SPEC 10).
 *
 * Tables are the one visual Markdown already has, and SPEC 10.3 makes the
 * table ↔ chart duality a design commitment: every visual block can render its
 * underlying table, and every `mdv table` can be promoted to a chart by changing
 * its type. That is why this is a full {@link ChartType} rather than a special
 * case in core — it goes through the same encode/layout seam, gets the same PDF
 * export and the same keyboard interaction, and its `a11yTable` *is* its content.
 *
 * **In-cell encodings supplement the value, never replace it** (SPEC 10.1): a
 * `bar` column draws a proportional bar *behind* the number, a `heat` column
 * tints the cell *behind* the number, and the text color flips between white and
 * ink by the fill's luminance. The number always stays legible.
 */

import type {
  A11yColumn,
  A11yTable,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  Font,
  LayoutContext,
  Mark,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  SceneNode,
  Table,
  TextMark,
  Theme,
} from '@mdv/core';
import type { PlannedEncodeResult } from './internal/plan.js';
import type { CurveKind } from './internal/types.js';
import { CURVE_KINDS } from './internal/types.js';
import { alignFor, presentationOf } from './internal/a11y.js';
import { blockDiagnostic } from './internal/diagnostics.js';
import { boolAttr, enumAttr, listAttr, numberAttr, recordAttr, stringAttr } from './internal/attrs.js';
import { cell, cellNumber, findColumn, humaniseColumn } from './internal/table.js';
import { clamp, compareNumbers, compareStrings, finite, isFiniteNumber, safeDiv, sum as sumOf } from './internal/num.js';
import { curvePath, px } from './internal/geometry.js';
import { formatValue } from './internal/format.js';
import { hitRegion, readout } from './internal/hit.js';
import { labelFont, readableOn, solid } from './internal/paint.js';
import { planOf } from './internal/plan.js';

/** Cell renderers (SPEC 10.1 `columns.*.type`). */
type CellRenderer = 'auto' | 'sparkline' | 'bar' | 'link' | 'badge';

/** In-cell magnitude encoding (SPEC 10.1 `columns.*.heat`). */
type HeatMode = 'none' | 'sequential' | 'diverging' | 'bar';
const HEAT_MODES: readonly HeatMode[] = ['none', 'sequential', 'diverging', 'bar'];

/** Row-and-header stickiness (SPEC 10.1). A static scene records it for the DOM. */
type StickyMode = 'none' | 'header' | 'first' | 'both';
const STICKY_MODES: readonly StickyMode[] = ['none', 'header', 'first', 'both'];

/** Footer aggregate operations (SPEC 10.1 `total`). */
type TotalOp = 'sum' | 'mean' | 'min' | 'max' | 'count';

/** One resolved column of the view. */
interface ViewColumn {
  index: number;
  label: string;
  align: 'left' | 'right' | 'center';
  renderer: CellRenderer;
  heat: HeatMode;
  format: string | undefined;
  /** Explicit width in px, or `undefined` for auto. */
  width: number | undefined;
  midpoint: number;
  curve: CurveKind;
  numeric: boolean;
  /** Extent of the column's numbers, for `bar` and `heat`. */
  extent: [number, number] | undefined;
  total: TotalOp | undefined;
  totalText: string | undefined;
}

/** One resolved cell. */
interface ViewCell {
  text: string;
  value: number | undefined;
  /** Comma-separated series for a `sparkline` column. */
  spark: number[] | undefined;
}

/** One body row, or a group header. */
interface ViewRow {
  kind: 'data' | 'group' | 'subtotal';
  /** Row index into the prepared table; `-1` for a synthesised row. */
  datum: number;
  cells: ViewCell[];
  /** Group header text. */
  heading?: string;
  readout: ReadoutRow[];
}

/** Everything `layout` needs. */
interface TablePlan {
  columns: ViewColumn[];
  rows: ViewRow[];
  zebra: boolean;
  sticky: StickyMode;
  hasTotals: boolean;
}

const DEFAULT_PLAN: TablePlan = { columns: [], rows: [], zebra: false, sticky: 'header', hasTotals: false };

type TableEncodeResult = PlannedEncodeResult<Mark, TablePlan>;

/** Vertical padding inside a cell, in px. */
const CELL_PAD_Y = 6;
/** Horizontal padding inside a cell, in px. */
const CELL_PAD_X = 8;
/** Never squeeze a column below this. */
const MIN_COLUMN_WIDTH = 32;

/** `table` (SPEC 10). */
export const tableChart: ChartType<Mark> = {
  name: 'table',
  level: 1,
  // The row is the target; there is no crosshair over a table.
  family: 'mark',
  channels: [],
  defaultEncoding: {},
  defaults: { zebra: false, sticky: 'header', sortable: true },
  schemaId: 'https://mdv.dev/schema/1.0/block/table.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const columns = recordAttr(block.attrs, 'columns');
    if (columns !== undefined) {
      for (const name of Object.keys(columns)) {
        if (findColumn(table, name) === undefined && table.fields.length > 0) {
          diagnostics.push(
            blockDiagnostic(
              'MDV1501',
              block,
              'encode',
              `\`columns.${name}\` does not match any column in the data`,
              'Column names are compared case-sensitively (SPEC 6.1.2).',
            ),
          );
        }
      }
    }
    for (const entry of listAttr(block.attrs, 'sort')) {
      if (typeof entry !== 'string') continue;
      const field = entry.startsWith('-') ? entry.slice(1) : entry;
      if (findColumn(table, field) === undefined && table.fields.length > 0) {
        diagnostics.push(
          blockDiagnostic('MDV1501', block, 'encode', `\`sort\` names \`${field}\`, which is not a column`),
        );
      }
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<Mark> {
    return encodeTable(input);
  },

  layout(encoded: EncodeResult<Mark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    return layoutTable(encoded, frame, ctx);
  },

  describe(input: DescribeInput<Mark>): string {
    const plan = planOf<Mark, TablePlan>(input.encoded, DEFAULT_PLAN);
    const dataRows = plan.rows.filter((row) => row.kind === 'data').length;
    if (plan.columns.length === 0) return 'Table with no columns.';
    const names = plan.columns.map((column) => column.label).join(', ');
    return `Table. ${dataRows} row${dataRows === 1 ? '' : 's'} across ${plan.columns.length} column${plan.columns.length === 1 ? '' : 's'}: ${names}.`;
  },
};

/** Resolve the column configuration and every cell. */
function encodeTable(input: EncodeInput): EncodeResult<Mark> {
  const { table, attrs, block } = input;
  const configured = recordAttr(attrs, 'columns');
  const totals = recordAttr(attrs, 'total');
  const zebra = boolAttr(attrs, 'zebra', false);
  const sticky = enumAttr(attrs, 'sticky', STICKY_MODES, 'header');
  const groupField = stringAttr(attrs, 'group');
  const groupColumn = findColumn(table, groupField);

  // Column order follows `columns:` as written; otherwise the data's own order.
  const names =
    configured === undefined
      ? table.fields.map((field) => field.name)
      : Object.keys(configured).filter((name) => findColumn(table, name) !== undefined);

  const columns: ViewColumn[] = [];
  for (const name of names) {
    const found = findColumn(table, name);
    if (found === undefined) continue;
    const config = configured?.[name];
    const record = typeof config === 'object' && config !== null && !Array.isArray(config)
      ? (config as Readonly<Record<string, unknown>>)
      : undefined;

    const declaredType = typeof record?.['type'] === 'string' ? (record['type'] as string) : undefined;
    const renderer: CellRenderer =
      declaredType === 'sparkline' || declaredType === 'bar' || declaredType === 'link' || declaredType === 'badge'
        ? declaredType
        : 'auto';
    const numeric =
      renderer === 'auto' &&
      (declaredType === 'number' ||
        declaredType === 'integer' ||
        found.column.type === 'number' ||
        found.column.type === 'integer' ||
        found.column.type === 'duration');

    const heatText = typeof record?.['heat'] === 'string' ? (record['heat'] as string) : 'none';
    const heat: HeatMode = HEAT_MODES.find((mode) => mode === heatText) ?? 'none';
    const alignText = typeof record?.['align'] === 'string' ? (record['align'] as string) : undefined;
    const align: 'left' | 'right' | 'center' =
      alignText === 'right' || alignText === 'center' || alignText === 'left'
        ? alignText
        : numeric || renderer === 'bar'
          ? 'right'
          : alignFor(found.column.type);

    const widthRaw = record?.['width'];
    const width = typeof widthRaw === 'number' && Number.isFinite(widthRaw) && widthRaw > 0 ? widthRaw : undefined;
    const curveText = typeof record?.['curve'] === 'string' ? (record['curve'] as string) : 'linear';
    const curve: CurveKind = CURVE_KINDS.find((kind) => kind === curveText) ?? 'linear';
    const midpointRaw = record?.['midpoint'];
    const midpoint = typeof midpointRaw === 'number' && Number.isFinite(midpointRaw) ? midpointRaw : 0;

    const values: number[] = [];
    for (let row = 0; row < table.rows.length; row += 1) {
      const value = cellNumber(cell(table, row, found.index));
      if (value !== null) values.push(value);
    }
    const extent: [number, number] | undefined =
      values.length === 0 ? undefined : [Math.min(...values), Math.max(...values)];

    const totalRaw = totals?.[name];
    const total: TotalOp | undefined =
      totalRaw === 'sum' || totalRaw === 'mean' || totalRaw === 'min' || totalRaw === 'max' || totalRaw === 'count'
        ? totalRaw
        : undefined;

    columns.push({
      index: found.index,
      label: typeof record?.['label'] === 'string' ? (record['label'] as string) : humaniseColumn(found.column),
      align,
      renderer,
      heat,
      format: typeof record?.['format'] === 'string' ? (record['format'] as string) : found.column.format,
      width,
      midpoint,
      curve,
      numeric: numeric || renderer === 'bar',
      extent,
      total,
      totalText: undefined,
    });
  }

  // ── Row order (SPEC 10.1 `sort`; `-` is descending) ───────────────────────
  let order = table.rows.map((_, index) => index);
  const sortKeys = listAttr(attrs, 'sort')
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => ({
      descending: entry.startsWith('-'),
      column: findColumn(table, entry.startsWith('-') ? entry.slice(1) : entry),
    }))
    .filter((key): key is { descending: boolean; column: NonNullable<ReturnType<typeof findColumn>> } => key.column !== undefined);

  if (sortKeys.length > 0) {
    order = [...order].sort((a, b) => {
      for (const key of sortKeys) {
        const left = cell(table, a, key.column.index);
        const right = cell(table, b, key.column.index);
        const comparison = compareCells(left, right) * (key.descending ? -1 : 1);
        if (comparison !== 0) return comparison;
      }
      // Ties keep source order: sorting must not shuffle equal rows.
      return a - b;
    });
  }

  // ── Grouping (SPEC 10.1 `group`) ──────────────────────────────────────────
  const rows: ViewRow[] = [];
  const buildCells = (rowIndex: number): ViewCell[] =>
    columns.map((column) => resolveCell(table, rowIndex, column));

  if (groupColumn === undefined) {
    for (const rowIndex of order) {
      rows.push({ kind: 'data', datum: rowIndex, cells: buildCells(rowIndex), readout: rowReadout(columns, buildCells(rowIndex)) });
    }
  } else {
    const groups = new Map<string, number[]>();
    const groupOrder: string[] = [];
    for (const rowIndex of order) {
      const raw = cell(table, rowIndex, groupColumn.index);
      const key = raw === null ? '—' : raw instanceof Date ? raw.toISOString() : String(raw);
      let bucket = groups.get(key);
      if (bucket === undefined) {
        bucket = [];
        groups.set(key, bucket);
        groupOrder.push(key);
      }
      bucket.push(rowIndex);
    }
    for (const key of groupOrder) {
      const members = groups.get(key) ?? [];
      rows.push({ kind: 'group', datum: members[0] ?? -1, cells: [], heading: key, readout: [] });
      for (const rowIndex of members) {
        const cells = buildCells(rowIndex);
        rows.push({ kind: 'data', datum: rowIndex, cells, readout: rowReadout(columns, cells) });
      }
      // A group without a subtotal invites the reader to add the rows up by eye.
      rows.push({
        kind: 'subtotal',
        datum: -1,
        cells: subtotalCells(table, columns, members),
        heading: `${key} total`,
        readout: [],
      });
    }
  }

  // ── Footer totals (SPEC 10.1 `total`) ─────────────────────────────────────
  let hasTotals = false;
  for (const column of columns) {
    if (column.total === undefined) continue;
    hasTotals = true;
    const values: number[] = [];
    for (let row = 0; row < table.rows.length; row += 1) {
      const value = cellNumber(cell(table, row, column.index));
      if (value !== null) values.push(value);
    }
    column.totalText = formatValue(aggregate(column.total, values), column.format);
  }

  if (numberAttr(attrs, 'pageSize', 0, 0) > 0) {
    // A scene graph is static; pagination is an interactive-target behaviour and
    // PDF renders every row anyway (SPEC 10.1).
    input.diagnostic(
      blockDiagnostic(
        'MDV1501',
        block,
        'encode',
        '`pageSize` has no effect on a static render; every row is drawn',
        'Interactive targets paginate; PDF and SVG render all rows so the export stays lossless.',
      ),
    );
  }

  const a11yColumns: A11yColumn[] = columns.map((column) => ({
    name: column.label,
    type: table.fields[column.index]?.type ?? 'string',
    align: column.align,
  }));
  const a11yTable: A11yTable = {
    caption: attrs.caption ?? attrs.title ?? 'Table',
    columns: a11yColumns,
    rows: rows.filter((row) => row.kind === 'data').map((row) => row.cells.map((viewCell) => viewCell.text)),
    presentation: presentationOf(attrs),
  };

  // One text mark per cell: the marks *are* the data in a table, which keeps the
  // export path and the readout builder identical to every other type.
  const marks: TextMark[] = [];
  for (const row of rows) {
    if (row.kind !== 'data') continue;
    row.cells.forEach((viewCell, columnIndex) => {
      const column = columns[columnIndex];
      if (column === undefined) return;
      marks.push({
        mark: 'text',
        seriesId: '',
        datum: row.datum,
        x: column.label,
        y: row.datum,
        text: viewCell.text,
      });
    });
  }

  const result: TableEncodeResult = {
    marks,
    series: [],
    scales: {},
    axes: [],
    a11yTable,
    state: { columns, rows, zebra, sticky, hasTotals },
  };
  return result;
}

/** Compare two cells for `sort`, without ever touching `localeCompare`. */
function compareCells(left: unknown, right: unknown): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : 1;
  if (right === null || right === undefined) return -1;
  const leftNumber = left instanceof Date ? left.getTime() : typeof left === 'number' ? left : Number.NaN;
  const rightNumber = right instanceof Date ? right.getTime() : typeof right === 'number' ? right : Number.NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return compareNumbers(leftNumber, rightNumber);
  return compareStrings(String(left), String(right));
}

/** Resolve one cell's text, number and sparkline series. */
function resolveCell(table: Table, row: number, column: ViewColumn): ViewCell {
  const raw = cell(table, row, column.index);
  if (column.renderer === 'sparkline') {
    // A sparkline column parses a comma-separated list per cell (SPEC 10.1).
    const parts = String(raw ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value): value is number => Number.isFinite(value));
    return { text: parts.length === 0 ? '—' : `${parts.length} points`, value: undefined, spark: parts };
  }
  const numeric = cellNumber(raw);
  return {
    text: formatValue(raw, column.format),
    value: numeric === null ? undefined : numeric,
    spark: undefined,
  };
}

/** The readout for a row: every column, with the first as the emphasis. */
function rowReadout(columns: readonly ViewColumn[], cells: readonly ViewCell[]): ReadoutRow[] {
  const out: ReadoutRow[] = [];
  columns.forEach((column, index) => {
    const viewCell = cells[index];
    if (viewCell === undefined) return;
    out.push(readout(column.label, viewCell.text, undefined, index === 0));
  });
  return out;
}

/** Subtotal cells for one group. */
function subtotalCells(table: Table, columns: readonly ViewColumn[], members: readonly number[]): ViewCell[] {
  return columns.map((column) => {
    if (!column.numeric) return { text: '', value: undefined, spark: undefined };
    const values: number[] = [];
    for (const row of members) {
      const value = cellNumber(cell(table, row, column.index));
      if (value !== null) values.push(value);
    }
    if (values.length === 0) return { text: '', value: undefined, spark: undefined };
    const total = aggregate(column.total ?? 'sum', values);
    return { text: formatValue(total, column.format), value: total, spark: undefined };
  });
}

/** Apply a footer aggregate. */
function aggregate(op: TotalOp, values: readonly number[]): number {
  if (values.length === 0) return 0;
  switch (op) {
    case 'mean': return sumOf(values) / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'count': return values.length;
    default: return sumOf(values);
  }
}

/** Draw the table into the scene graph. */
function layoutTable(encoded: EncodeResult<Mark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
  const plan = planOf<Mark, TablePlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];
  const theme = ctx.theme;

  const x0 = finite(frame.x, 0);
  const y0 = finite(frame.y, 0);
  const width = Math.max(0, finite(frame.width, 0));
  const height = Math.max(0, finite(frame.height, 0));
  if (width <= 0 || height <= 0 || plan.columns.length === 0) return { nodes, hits };

  const headerFont = labelFont(theme, theme.type.tickScale, 600);
  const bodyFont = labelFont(theme, theme.type.tickScale);
  const rowHeight = Math.max(20, bodyFont.size * theme.type.lineHeight + CELL_PAD_Y * 2);

  const widths = resolveWidths(plan, width, headerFont, bodyFont, ctx);

  // ── Header ────────────────────────────────────────────────────────────────
  let y = y0;
  const headerBaseline = y + rowHeight / 2;
  plan.columns.forEach((column, index) => {
    const left = columnLeft(widths, index) + x0;
    const columnWidth = widths[index] ?? 0;
    nodes.push(
      textNode(
        column.label,
        left,
        headerBaseline,
        columnWidth,
        column.align,
        headerFont,
        theme.tokens['text-secondary'],
        ctx,
        false,
        'mdv-table-header',
      ),
    );
  });
  y += rowHeight;
  // One hairline under the header — the only rule the table needs.
  nodes.push({
    kind: 'line',
    cls: 'mdv-table-rule',
    x1: px(x0),
    y1: px(y),
    x2: px(x0 + width),
    y2: px(y),
    stroke: { paint: solid(theme.tokens.border), width: theme.metrics.hairline },
  });

  // ── Body ──────────────────────────────────────────────────────────────────
  let zebraIndex = 0;
  for (const row of plan.rows) {
    if (y >= y0 + height) break;

    if (row.kind === 'group') {
      nodes.push(
        textNode(
          row.heading ?? '',
          x0 + CELL_PAD_X,
          y + rowHeight / 2,
          width,
          'left',
          headerFont,
          theme.tokens['text-primary'],
          ctx,
          false,
          'mdv-table-group',
        ),
      );
      y += rowHeight;
      zebraIndex = 0;
      continue;
    }

    const isSubtotal = row.kind === 'subtotal';
    if (plan.zebra && !isSubtotal && zebraIndex % 2 === 1) {
      nodes.push({
        kind: 'rect',
        cls: 'mdv-table-zebra',
        x: px(x0),
        y: px(y),
        w: px(width),
        h: px(rowHeight),
        fill: solid(theme.tokens.border, 0.12),
      });
    }
    if (isSubtotal) {
      nodes.push({
        kind: 'line',
        cls: 'mdv-table-rule',
        x1: px(x0),
        y1: px(y),
        x2: px(x0 + width),
        y2: px(y),
        stroke: { paint: solid(theme.tokens.border), width: theme.metrics.hairline },
      });
    }

    plan.columns.forEach((column, index) => {
      const viewCell = row.cells[index];
      if (viewCell === undefined) return;
      const left = columnLeft(widths, index) + x0;
      const columnWidth = widths[index] ?? 0;
      let ink = isSubtotal ? theme.tokens['text-primary'] : theme.tokens['text-primary'];

      // In-cell encodings sit *behind* the value, never over it.
      if (column.heat === 'bar' || column.renderer === 'bar') {
        const fraction = magnitudeFraction(viewCell.value, column.extent);
        if (fraction > 0) {
          nodes.push({
            kind: 'rect',
            cls: 'mdv-table-cell-bar',
            x: px(left + 1),
            y: px(y + CELL_PAD_Y / 2),
            w: px(Math.max(0, (columnWidth - 2) * fraction)),
            h: px(rowHeight - CELL_PAD_Y),
            r: 2,
            fill: solid(theme.categorical[0] ?? theme.tokens['text-muted'], 0.18),
          });
        }
      } else if (column.heat === 'sequential' || column.heat === 'diverging') {
        const fill = heatColor(theme, column, viewCell.value);
        if (fill !== undefined) {
          nodes.push({
            kind: 'rect',
            cls: 'mdv-table-cell-heat',
            x: px(left),
            y: px(y),
            w: px(columnWidth),
            h: px(rowHeight),
            fill: solid(fill),
          });
          // The text color flips between white and ink by the fill's luminance.
          ink = readableOn(theme, fill);
        }
      }

      if (column.renderer === 'sparkline' && viewCell.spark !== undefined && viewCell.spark.length > 1) {
        const d = curvePath(
          sparkPoints(viewCell.spark, left + CELL_PAD_X, y + CELL_PAD_Y, Math.max(0, columnWidth - CELL_PAD_X * 2), rowHeight - CELL_PAD_Y * 2),
          column.curve,
        );
        if (d.length > 0) {
          nodes.push({
            kind: 'path',
            cls: 'mdv-table-cell-sparkline',
            d,
            stroke: { paint: solid(theme.tokens['text-muted']), width: 1.5, cap: 'round', join: 'round' },
          });
        }
        return;
      }

      if (column.renderer === 'badge') {
        const metrics = ctx.metrics.measure(viewCell.text, bodyFont);
        const badgeWidth = metrics.width + CELL_PAD_X;
        const badgeX = column.align === 'right' ? left + columnWidth - badgeWidth - CELL_PAD_X : left + CELL_PAD_X / 2;
        nodes.push({
          kind: 'rect',
          cls: 'mdv-table-cell-badge',
          x: px(badgeX),
          y: px(y + CELL_PAD_Y / 2),
          w: px(badgeWidth),
          h: px(rowHeight - CELL_PAD_Y),
          r: 4,
          fill: solid(theme.tokens.border, 0.35),
        });
      }

      nodes.push(
        textNode(
          viewCell.text,
          left,
          y + rowHeight / 2,
          columnWidth,
          column.align,
          bodyFont,
          ink,
          ctx,
          // Y-axis ticks and table values use tabular figures (SPEC 11.5), so
          // digits line up down a column.
          column.numeric,
          isSubtotal ? 'mdv-table-subtotal' : 'mdv-table-cell',
        ),
      );
    });

    if (row.kind === 'data') {
      hits.push(
        hitRegion({
          x: x0,
          y,
          w: width,
          h: rowHeight,
          datumIndex: row.datum,
          readout: row.readout,
        }),
      );
      zebraIndex += 1;
    }
    y += rowHeight;
  }

  // ── Footer totals ─────────────────────────────────────────────────────────
  if (plan.hasTotals) {
    nodes.push({
      kind: 'line',
      cls: 'mdv-table-rule',
      x1: px(x0),
      y1: px(y),
      x2: px(x0 + width),
      y2: px(y),
      stroke: { paint: solid(theme.tokens.border), width: theme.metrics.hairline },
    });
    plan.columns.forEach((column, index) => {
      if (column.totalText === undefined) return;
      const left = columnLeft(widths, index) + x0;
      nodes.push(
        textNode(
          column.totalText,
          left,
          y + rowHeight / 2,
          widths[index] ?? 0,
          column.align,
          headerFont,
          theme.tokens['text-primary'],
          ctx,
          column.numeric,
          'mdv-table-total',
        ),
      );
    });
  }

  return { nodes, hits };
}

/**
 * Allocate column widths.
 *
 * Measured content first, then scaled to the frame: shrinking proportionally
 * (with a floor) is what keeps a wide table inside the block instead of causing
 * horizontal document overflow, which SPEC 8.1 forbids outright.
 */
function resolveWidths(
  plan: TablePlan,
  available: number,
  headerFont: Font,
  bodyFont: Font,
  ctx: LayoutContext,
): number[] {
  const natural = plan.columns.map((column, index) => {
    if (column.width !== undefined) return column.width;
    let widest = ctx.metrics.measure(column.label, headerFont).width;
    for (const row of plan.rows) {
      const viewCell = row.cells[index];
      if (viewCell === undefined) continue;
      const measured = ctx.metrics.measure(viewCell.text, bodyFont).width;
      if (measured > widest) widest = measured;
    }
    if (column.totalText !== undefined) {
      widest = Math.max(widest, ctx.metrics.measure(column.totalText, headerFont).width);
    }
    return widest + CELL_PAD_X * 2;
  });

  const total = sumOf(natural);
  if (total <= 0) {
    const even = safeDiv(available, plan.columns.length, 0);
    return plan.columns.map(() => even);
  }
  if (total <= available) {
    // Distribute the slack proportionally so the table fills its frame.
    const slack = available - total;
    return natural.map((value) => value + slack * safeDiv(value, total, 0));
  }
  const scale = safeDiv(available, total, 1);
  const scaled = natural.map((value) => Math.max(MIN_COLUMN_WIDTH, value * scale));
  const scaledTotal = sumOf(scaled);
  if (scaledTotal <= available) return scaled;
  // Floors pushed it over; renormalise once more, accepting the floor breach
  // rather than overflowing the block.
  const correction = safeDiv(available, scaledTotal, 1);
  return scaled.map((value) => value * correction);
}

/** Left edge of a column, relative to the frame. */
function columnLeft(widths: readonly number[], index: number): number {
  let left = 0;
  for (let i = 0; i < index; i += 1) left += widths[i] ?? 0;
  return left;
}

/** A measured text node, aligned inside its column box. */
function textNode(
  text: string,
  left: number,
  centreY: number,
  columnWidth: number,
  align: 'left' | 'right' | 'center',
  font: Font,
  fill: ColorString,
  ctx: LayoutContext,
  tabular: boolean,
  cls: string,
): SceneNode {
  const anchor = align === 'right' ? 'end' : align === 'center' ? 'middle' : 'start';
  const x =
    align === 'right' ? left + columnWidth - CELL_PAD_X : align === 'center' ? left + columnWidth / 2 : left + CELL_PAD_X;
  const node: SceneNode = {
    kind: 'text',
    cls,
    x: px(x),
    y: px(centreY),
    text,
    font,
    fill: solid(fill),
    anchor,
    baseline: 'middle',
    width: px(ctx.metrics.measure(text, font).width),
  };
  if (tabular) node.tabular = true;
  return node;
}

/** How full an in-cell bar should be, 0…1. */
function magnitudeFraction(value: number | undefined, extent: [number, number] | undefined): number {
  if (value === undefined || extent === undefined) return 0;
  const [lo, hi] = extent;
  const base = Math.min(0, lo);
  const top = Math.max(hi, base);
  if (top === base) return 0;
  return clamp(safeDiv(value - base, top - base, 0), 0, 1);
}

/** The heat tint for a cell (SPEC 10.1 `heat`). */
function heatColor(theme: Theme, column: ViewColumn, value: number | undefined): ColorString | undefined {
  if (value === undefined || column.extent === undefined) return undefined;
  const [lo, hi] = column.extent;

  if (column.heat === 'diverging') {
    const reach = Math.max(Math.abs(hi - column.midpoint), Math.abs(column.midpoint - lo));
    if (reach === 0) return theme.diverging.mid;
    const ratio = clamp(safeDiv(Math.abs(value - column.midpoint), reach, 0), 0, 1);
    // Zero must read as "nothing": the midpoint is the neutral gray, never a hue.
    const rising = value >= column.midpoint;
    const steps = rising ? theme.diverging.highSteps : theme.diverging.lowSteps;
    if (steps.length === 0) return theme.diverging.mid;
    if (ratio < 1 / (steps.length * 2)) return theme.diverging.mid;
    const index = Math.min(steps.length - 1, Math.round(ratio * (steps.length - 1)));
    // `lowSteps` reads from the low *extreme* inwards towards the midpoint,
    // while `highSteps` reads outwards from it, so the two arms are indexed from
    // opposite ends. Indexing both the same way tints the worst number the
    // palest red and the barely-negative one the deepest — the arm reversed.
    return (rising ? steps[index] : steps[steps.length - 1 - index]) ?? theme.diverging.mid;
  }

  const steps = theme.sequential.steps;
  if (steps.length === 0 || hi === lo) return undefined;
  const ratio = clamp(safeDiv(value - lo, hi - lo, 0), 0, 1);
  const index = Math.min(steps.length - 1, Math.round(ratio * (steps.length - 1)));
  return steps[index];
}

/** Lay out an in-cell sparkline. */
function sparkPoints(values: readonly number[], x: number, y: number, width: number, height: number): { x: number; y: number }[] {
  const usable = values.filter(isFiniteNumber);
  if (usable.length === 0 || width <= 0 || height <= 0) return [];
  let lo = usable[0] ?? 0;
  let hi = lo;
  for (const value of usable) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo;
  const step = usable.length > 1 ? width / (usable.length - 1) : 0;
  return usable.map((value, index) => ({
    x: x + step * index,
    y: span === 0 ? y + height / 2 : y + height - ((value - lo) / span) * height,
  }));
}

export default tableChart;

/** Re-exported so other types can render "unknown block type" as a table. */
export { encodeTable as encodeTableView, layoutTable as layoutTableView };
