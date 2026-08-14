/**
 * `treemap` — a magnitude and its parts, as nested rectangles (SPEC 8.12).
 *
 * ## What a treemap says, and the four decisions that follow
 *
 * A treemap says **"this whole is made of these parts, and the parts are made of
 * parts"**. Area is the magnitude; nesting is the hierarchy; nothing else on the
 * page carries data. Every decision below falls out of that one sentence.
 *
 * 1. **A group is the sum of its parts.** A row that other rows name as their
 *    `parent` is structure, not magnitude: its rectangle is already filled by its
 *    children, so its own `value` cell — if the author wrote one — is *not* added
 *    on top. Adding it would paint a parent larger than the parts it contains,
 *    which is the one thing a nested rectangle cannot mean. The cell is still
 *    reachable in the source; what the chart draws is what the parts add up to.
 *
 * 2. **The hierarchy is a field, not nested data** (SPEC 6.1). `parent:` names a
 *    column, exactly as `waterfall`'s `total:` does; a cell naming a category
 *    that has no row of its own creates that group anyway — `(Paris, France)`,
 *    `(Lyon, France)` is the ordinary way this data arrives, and demanding a
 *    `France` row before it will draw would be pedantry, not validation. The
 *    category cell is the identity, so two rows with the same category are one
 *    node and their values sum (as in `pie`); a `parent` chain that closes on
 *    itself is broken at the offending node and reported (`MDV3070`).
 *
 * 3. **Colour names the branch, not the value.** Each top-level node takes a
 *    categorical slot from the allocator (SPEC 11.2 rule 1) and every descendant
 *    wears it, so a reader tracks a branch by hue and reads its subdivision by
 *    the gaps between tiles. Groups paint the same colour at low opacity, which
 *    is visible only in the padding and the header band their children do not
 *    cover — depth is drawn by the frame, not by a second colour dimension that
 *    would compete with the first. Past the palette cap the allocator returns the
 *    "Other" colour and several branches share it: a treemap identifies a tile by
 *    **position and label**, never by hue alone, so the cap costs colour and
 *    never identity — nothing is folded away.
 *
 * 4. **A label is drawn only where it fits, uncropped** (SPEC 11.5). `labelMinArea`
 *    is the floor below which one is not attempted at all; above it the text is
 *    measured and dropped if it would overflow its own tile. Half a word inside a
 *    rectangle is worse than no word, and the table view has every name anyway.
 *
 * ## Tiling
 *
 * `squarify` (the default) is Bruls–Huizing–van Wijk: rows are grown while the
 * worst aspect ratio in the row keeps improving, which trades the reading order
 * for tiles a reader can actually compare — long slivers defeat area judgement.
 * `slice` and `dice` keep document order in one axis, which is what an author
 * wants when the order *is* the data. Squarify sorts by value within each level
 * and breaks ties by document position, so the picture is deterministic
 * (SPEC 24.3 rule 5) without depending on the input's own ordering.
 *
 * ## No axes, no scales to speak of
 *
 * Area is not a scale core can tick, and there is no position channel: `axes` is
 * empty (the registry contract names `treemap` as an example) and the bundle
 * carries the value extent only so that annotations and downstream tooling see a
 * domain rather than nothing.
 */

import type {
  A11yTable,
  AxisModel,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  Column,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  NodeMark,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  RowIndex,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';
import {
  autoNumberAttr,
  boolOrStringAttr,
  numberAttr,
  enumAttr,
  stringAttr,
} from './internal/attrs.js';
import {
  blockDiagnostic,
  incompatibleField,
  missingChannel,
  unknownEnum,
} from './internal/diagnostics.js';
import { hitRegion, readout } from './internal/hit.js';
import { isFiniteNumber } from './internal/num.js';
import { labelFont, readableOn, solid, tickFont } from './internal/paint.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import { planOf } from './internal/plan.js';
import { createBandScale, createContinuousScale } from './internal/scale.js';
import { buildLegend } from './internal/series.js';
import {
  bindField,
  cell,
  cellNumber,
  channelFormat,
  findColumn,
  firstChannelOf,
  humaniseColumn,
  isQuantitative,
} from './internal/table.js';
import { formatNumber, formatValue } from './internal/format.js';
import { composeDescription, countPhrase, presentationOf, subjectPhrase } from './internal/a11y.js';
import { px } from './internal/geometry.js';

/** How a rectangle is divided among its children. */
const TILINGS = ['squarify', 'slice', 'dice'] as const;
type Tiling = (typeof TILINGS)[number];

/** Share format for the readout and the table view. */
const SHARE = '.1%';

/**
 * How much of its own colour a subdivided group keeps. Low enough that a child
 * painted over it reads as the child's colour, high enough that the padding and
 * the header band still say which branch they belong to.
 */
const GROUP_TINT = 0.28;

/**
 * A `parent` chain is a forest while it is being built — a link that would close
 * a loop is refused before it is made — so walking up terminates within one step
 * per node. That bound is the loop guard: exact, so no cycle escapes detection
 * by being long, and terminating, so a malformed chain cannot hang a render.
 */
const chainLimit = (nodes: readonly unknown[]): number => nodes.length + 1;

/** One node of the tree, resolved to everything layout needs. */
interface TreemapTile {
  /** Identity — the category cell, verbatim. */
  key: string;
  /** Display name. */
  label: string;
  /** Index of the parent tile, or `-1` for a top-level node. */
  parent: number;
  /** Child tile indices, in document order. */
  children: readonly number[];
  /** Levels below the top. */
  depth: number;
  /** Drawn magnitude: the own value for a leaf, the sum of the parts for a group. */
  value: number;
  /** Fraction of the whole, 0…1. Precomputed so layout does no arithmetic on data. */
  share: number;
  /** The node's own row, or its first descendant's when the group has no row. */
  row: RowIndex;
  /** The top-level node this one belongs to — the palette identity. */
  seriesId: string;
  color: ColorString;
  /** The magnitude, already formatted (SPEC 12.3: layout never formats). */
  valueText: string;
  readout: readonly ReadoutRow[];
}

/** Resolved attributes and the tree, carried from `encode` to `layout`. */
interface TreemapPlan {
  tiles: readonly TreemapTile[];
  /** Top-level tile indices, in document order. */
  roots: readonly number[];
  tiling: Tiling;
  /** Levels to draw; `undefined` draws the whole tree. */
  depth: number | undefined;
  labels: boolean;
  /** Square pixels below which a tile is not labelled at all. */
  labelMinArea: number;
  total: number;
  /** "Revenue" — for the generated description. */
  measure: string;
  /** "Region" — for the generated description. */
  category: string;
  valueFormat: string | undefined;
}

/** A treemap's marks are nodes, and its plan is the tree (SPEC 8.12). */
export type TreemapEncodeResult = PlannedEncodeResult<NodeMark, TreemapPlan>;

const DEFAULT_PLAN: TreemapPlan = {
  tiles: [],
  roots: [],
  tiling: 'squarify',
  depth: undefined,
  labels: true,
  labelMinArea: 900,
  total: 0,
  measure: '',
  category: '',
  valueFormat: undefined,
};

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'category',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime'],
    defaultScale: 'band',
    doc: 'The name of each part. Two rows sharing a name are one tile.',
  },
  {
    name: 'value',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'The magnitude each tile’s area stands for. Negative rows are dropped.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tiling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The worst aspect ratio in a row of `rowArea` laid along a side of `short`.
 *
 * `Infinity` for a row that cannot be judged — zero area, or a zero-valued member
 * whose tile would be a line — which reads as "adding this makes it worse" and
 * ends the row, exactly as it should.
 */
function worstRatio(short: number, rowArea: number, minArea: number, maxArea: number): number {
  if (!(short > 0) || !(rowArea > 0) || !(minArea > 0)) return Number.POSITIVE_INFINITY;
  const side = short * short;
  const area = rowArea * rowArea;
  return Math.max((side * maxArea) / area, area / (side * minArea));
}

/**
 * Bruls–Huizing–van Wijk squarified tiling.
 *
 * Values are laid out in descending order — the algorithm's whole premise is
 * that the biggest remaining tile leads the row — but the rectangles come back
 * in the caller's order, so document order still owns the tree and only the
 * *geometry* is sorted. Ties break by position, so equal values are stable.
 */
function squarifyRects(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, width: 0, height: 0 }));
  const order = values
    .map((_, index) => index)
    .sort((a, b) => (values[b] ?? 0) - (values[a] ?? 0) || a - b);

  let { x, y, width, height } = rect;
  let remaining = 0;
  for (const value of values) remaining += Math.max(0, value);

  let start = 0;
  while (start < order.length && remaining > 0 && width > 0 && height > 0) {
    // Area per unit of value, recomputed for the shrinking rectangle so rounding
    // never accumulates into a gap at the far edge.
    const scale = (width * height) / remaining;
    const short = Math.min(width, height);
    const areaOf = (position: number): number =>
      Math.max(0, values[order[position] ?? 0] ?? 0) * scale;

    let end = start + 1;
    let rowArea = areaOf(start);
    let minArea = rowArea;
    let maxArea = rowArea;
    let best = worstRatio(short, rowArea, minArea, maxArea);
    while (end < order.length) {
      const area = areaOf(end);
      const nextMin = Math.min(minArea, area);
      const nextMax = Math.max(maxArea, area);
      const next = worstRatio(short, rowArea + area, nextMin, nextMax);
      if (next > best) break;
      rowArea += area;
      minArea = nextMin;
      maxArea = nextMax;
      best = next;
      end += 1;
    }

    const thickness = short > 0 ? rowArea / short : 0;
    let offset = 0;
    let consumed = 0;
    for (let position = start; position < end; position += 1) {
      const index = order[position];
      if (index === undefined) continue;
      const value = Math.max(0, values[index] ?? 0);
      consumed += value;
      const extent = rowArea > 0 ? (value * scale * short) / rowArea : 0;
      out[index] =
        width >= height
          ? { x, y: y + offset, width: thickness, height: extent }
          : { x: x + offset, y, width: extent, height: thickness };
      offset += extent;
    }

    if (width >= height) {
      x += thickness;
      width -= thickness;
    } else {
      y += thickness;
      height -= thickness;
    }
    remaining -= consumed;
    start = end;
  }
  return out;
}

/** `slice` (stacked) and `dice` (side by side): document order, one axis. */
function bandRects(values: readonly number[], rect: Rect, vertical: boolean): Rect[] {
  let total = 0;
  for (const value of values) total += Math.max(0, value);
  const out: Rect[] = [];
  let offset = 0;
  for (const value of values) {
    const share = total > 0 ? Math.max(0, value) / total : 0;
    const extent = (vertical ? rect.height : rect.width) * share;
    out.push(
      vertical
        ? { x: rect.x, y: rect.y + offset, width: rect.width, height: extent }
        : { x: rect.x + offset, y: rect.y, width: extent, height: rect.height },
    );
    offset += extent;
  }
  return out;
}

/** Divide `rect` among `values`, returning one rectangle per value, in order. */
function tileRects(values: readonly number[], rect: Rect, tiling: Tiling): Rect[] {
  if (tiling === 'slice') return bandRects(values, rect, true);
  if (tiling === 'dice') return bandRects(values, rect, false);
  return squarifyRects(values, rect);
}

// ─────────────────────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────────────────────

/** Attributes a treemap reads beyond the common set (SPEC 8.1). */
function readAttrs(input: EncodeInput): {
  tiling: Tiling;
  depth: number | undefined;
  labelMinArea: number;
  labels: boolean;
  parent: string | undefined;
} {
  const { attrs, block } = input;
  const labelRequest = boolOrStringAttr(attrs, 'label');
  return {
    tiling: enumAttr(attrs, 'tile', TILINGS, 'squarify', (given: string) => {
      input.diagnostic(unknownEnum(block, 'tile', given, TILINGS, 'squarify'));
    }),
    depth: autoNumberAttr(attrs, 'depth', 1, 16),
    // 900 px² is a 30 × 30 tile: smaller than that and a name plus a number is
    // never both readable and inside.
    labelMinArea: numberAttr(attrs, 'labelMinArea', 900, 0, 1_000_000),
    // Labels default **on**: a treemap has no axis, so the tiles are the only
    // place a name can appear at all.
    labels:
      labelRequest === undefined
        ? true
        : labelRequest.kind === 'bool'
          ? labelRequest.value
          : labelRequest.value !== 'none',
    parent: stringAttr(attrs, 'parent'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The tree
// ─────────────────────────────────────────────────────────────────────────────

/** A node under construction, before values roll up. */
interface Building {
  key: string;
  label: string;
  parentKey: string | undefined;
  own: number;
  ownRow: RowIndex | undefined;
  children: number[];
  parent: number;
  depth: number;
  value: number;
  row: RowIndex;
}

/** The table view: every node, with the hierarchy spelled out (SPEC 12.3). */
function treemapA11yTable(
  tiles: readonly TreemapTile[],
  total: number,
  options: {
    caption: string;
    categoryLabel: string;
    categoryType: Column['type'];
    parentLabel: string | undefined;
    measure: string;
    valueType: Column['type'];
    valueFormat: string | undefined;
    presentation: ReturnType<typeof presentationOf>;
  },
): A11yTable {
  const nested = options.parentLabel !== undefined;
  const columns: A11yTable['columns'] = [
    { name: options.categoryLabel, type: options.categoryType, align: 'left' as const },
    ...(nested
      ? [{ name: options.parentLabel as string, type: 'string' as const, align: 'left' as const }]
      : []),
    { name: options.measure, type: options.valueType, align: 'right' as const },
    { name: 'Share', type: 'number' as const, align: 'right' as const },
  ];
  return {
    caption: options.caption,
    columns,
    rows: tiles.map((tile) => [
      tile.label,
      ...(nested ? [tile.parent < 0 ? '' : (tiles[tile.parent]?.label ?? '')] : []),
      tile.valueText,
      formatNumber(total > 0 ? tile.value / total : 0, SHARE),
    ]),
    presentation: options.presentation,
  };
}

/** A well-formed empty result, for a block whose rows resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  series: readonly SeriesDescriptor[],
  plan: TreemapPlan,
): TreemapEncodeResult {
  return {
    marks: [],
    series,
    scales: {
      x: createBandScale({ domain: [], padding: 0 }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: {
      caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
      columns: [],
      rows: [],
      presentation: presentationOf(input.attrs),
    },
    state: plan,
  };
}

/** `treemap` (SPEC 8.12). */
export const treemapChart: ChartType<NodeMark> = {
  name: 'treemap',
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: {
    tile: 'squarify',
    labelMinArea: 900,
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/treemap.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const categoryChannel = firstChannelOf(block.encoding, ['category', 'x', 'label']);
    if (categoryChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'category', 'the name of each part'));
    } else if (findColumn(table, categoryChannel.field) === undefined && table.fields.length > 0) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`category\` names \`${categoryChannel.field}\`, which is not a column`,
        ),
      );
    }

    const valueChannel = firstChannelOf(block.encoding, ['value', 'y']);
    if (valueChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'value', 'the size of each part'));
      return diagnostics;
    }

    const bound = bindField(table, valueChannel);
    if (bound === undefined) {
      if (table.fields.length > 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3000',
            block,
            'encode',
            `\`value\` names \`${valueChannel.field}\`, which is not a column`,
          ),
        );
      }
      return diagnostics;
    }
    if (!isQuantitative(bound.column.type) && bound.column.type !== 'unknown') {
      diagnostics.push(
        incompatibleField(block, 'value', bound.column.name, bound.column.type, [
          'number',
          'integer',
          'duration',
        ]),
      );
    }

    const parent = stringAttr(block.attrs, 'parent');
    if (
      parent !== undefined &&
      findColumn(table, parent) === undefined &&
      table.fields.length > 0
    ) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`parent\` names \`${parent}\`, which is not a column`,
          'Point `parent:` at the column holding each row’s parent category, or drop the attribute.',
        ),
      );
    }

    // An area cannot be negative, and a treemap has no baseline to hang one
    // below. Say so once, name the column, and send the author to a bar chart.
    for (let row = 0; row < table.rows.length; row += 1) {
      const numeric = cellNumber(cell(table, row, bound.index));
      if (numeric !== null && isFiniteNumber(numeric) && numeric < 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3001',
            block,
            'encode',
            `\`${bound.column.name}\` contains negative values`,
            'An area cannot be negative. Use a bar chart, which can draw below a baseline.',
          ),
        );
        break;
      }
    }

    return diagnostics;
  },

  encode(input: EncodeInput): TreemapEncodeResult {
    const { table, encoding, block } = input;
    const options = readAttrs(input);

    const categoryChannel = firstChannelOf(encoding, ['category', 'x', 'label']);
    const valueChannel = firstChannelOf(encoding, ['value', 'y']);
    const categoryBound = bindField(table, categoryChannel);
    const valueBound = bindField(table, valueChannel);

    const basePlan: TreemapPlan = {
      ...DEFAULT_PLAN,
      tiling: options.tiling,
      depth: options.depth,
      labels: options.labels,
      labelMinArea: options.labelMinArea,
    };
    if (categoryBound === undefined || valueBound === undefined) {
      return emptyResult(input, [], basePlan);
    }

    const categoryFormat = channelFormat(categoryChannel, categoryBound.column);
    const valueFormat = channelFormat(valueChannel, valueBound.column);
    const categoryLabel = humaniseColumn(categoryBound.column);
    const measure = humaniseColumn(valueBound.column);
    const parentColumn =
      options.parent === undefined ? undefined : findColumn(table, options.parent);
    const parentFormat =
      parentColumn === undefined ? undefined : (parentColumn.column.format ?? undefined);

    // ── Nodes, in first-appearance order ─────────────────────────────────────
    const nodes: Building[] = [];
    const byKey = new Map<string, number>();
    const nodeAt = (key: string, label: string): number => {
      const found = byKey.get(key);
      if (found !== undefined) return found;
      const index = nodes.length;
      byKey.set(key, index);
      nodes.push({
        key,
        label,
        parentKey: undefined,
        own: 0,
        ownRow: undefined,
        children: [],
        parent: -1,
        depth: 0,
        value: 0,
        row: 0,
      });
      return index;
    };

    let dropped = 0;
    for (let row = 0; row < table.rows.length; row += 1) {
      const key = formatValue(cell(table, row, categoryBound.index), categoryFormat);
      if (key === '') {
        dropped += 1;
        continue;
      }
      const numeric = cellNumber(cell(table, row, valueBound.index));
      if (numeric === null || !isFiniteNumber(numeric) || numeric < 0) {
        dropped += 1;
        continue;
      }
      const index = nodeAt(key, key);
      const node = nodes[index];
      if (node === undefined) continue;
      // Two rows with the same name are the same tile: the picture cannot show
      // one name twice and mean two things by it.
      node.own += numeric;
      if (node.ownRow === undefined) node.ownRow = row;
      if (parentColumn !== undefined && node.parentKey === undefined) {
        const parentKey = formatValue(cell(table, row, parentColumn.index), parentFormat);
        if (parentKey !== '' && parentKey !== key) node.parentKey = parentKey;
      }
    }

    if (nodes.length === 0) {
      return emptyResult(input, [], { ...basePlan, measure, category: categoryLabel, valueFormat });
    }

    // ── Links, and the cycles they can close ─────────────────────────────────
    let cycles = 0;
    // Indexed, not `for…of`: `nodeAt` appends synthetic groups as we go, and the
    // index *is* the child's identity for the link we are about to make.
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined || node.parentKey === undefined) continue;
      const parentIndex = nodeAt(node.parentKey, node.parentKey);
      const parent = nodes[parentIndex];
      if (parent === undefined) continue;
      // Walk up from the proposed parent: reaching this node again means the
      // link would close a loop, and a loop has no outermost rectangle.
      let cursor: number = parentIndex;
      let closes = false;
      for (let step = 0; step < chainLimit(nodes) && cursor >= 0; step += 1) {
        if (cursor === index) {
          closes = true;
          break;
        }
        cursor = nodes[cursor]?.parent ?? -1;
      }
      if (closes) {
        cycles += 1;
        continue;
      }
      node.parent = parentIndex;
      parent.children.push(index);
    }
    if (cycles > 0) {
      input.diagnostic(
        blockDiagnostic(
          'MDV3070',
          block,
          'encode',
          cycles === 1
            ? 'One row names a `parent` that is inside its own branch'
            : `${countPhrase(cycles, 'row')} name a \`parent\` that is inside their own branch`,
          'A tile cannot contain the tile that contains it. Those rows are drawn at the top level.',
        ),
      );
    }

    const roots = nodes
      .map((_, index) => index)
      .filter((index) => (nodes[index]?.parent ?? -1) < 0);

    // ── Depths, magnitudes and rows, rolled up from the leaves ───────────────
    // A group is the sum of its parts (decision 1); a leaf is its own value.
    const order: number[] = [];
    const seen = new Set<number>();
    const walk: { index: number; depth: number }[] = [];
    for (let k = roots.length - 1; k >= 0; k -= 1) {
      const index = roots[k];
      if (index !== undefined) walk.push({ index, depth: 0 });
    }
    while (walk.length > 0) {
      const step = walk.pop();
      if (step === undefined) continue;
      const node = nodes[step.index];
      if (node === undefined) continue;
      // The link pass refuses every edge that would close a loop, so this can
      // only fire if that reasoning is ever wrong. It costs one comparison.
      if (seen.has(step.index)) continue;
      seen.add(step.index);
      node.depth = step.depth;
      order.push(step.index);
      for (let k = node.children.length - 1; k >= 0; k -= 1) {
        const child = node.children[k];
        if (child !== undefined) walk.push({ index: child, depth: step.depth + 1 });
      }
    }
    for (let position = order.length - 1; position >= 0; position -= 1) {
      const index = order[position];
      if (index === undefined) continue;
      const node = nodes[index];
      if (node === undefined) continue;
      if (node.children.length === 0) {
        node.value = node.own;
        node.row = node.ownRow ?? 0;
        continue;
      }
      let sum = 0;
      for (const child of node.children) sum += nodes[child]?.value ?? 0;
      node.value = sum;
      // A group with no row of its own borrows its first descendant's, so every
      // target still points at a row that really exists.
      node.row = node.ownRow ?? nodes[node.children[0] ?? 0]?.row ?? 0;
    }

    let total = 0;
    for (const index of roots) total += nodes[index]?.value ?? 0;

    // ── Colour: one slot per branch (decision 3) ─────────────────────────────
    const series: SeriesDescriptor[] = [];
    const branchOf = new Map<number, SeriesDescriptor>();
    for (const index of roots) {
      const node = nodes[index];
      if (node === undefined) continue;
      const patternDef = input.palette.patternDef(node.key);
      const descriptor: SeriesDescriptor = {
        id: node.key,
        label: node.label,
        slot: input.palette.slot(node.key),
        color: input.palette.color(node.key),
        source: categoryBound.column.name,
        ...(patternDef === undefined ? {} : { patternDef }),
      };
      series.push(descriptor);
      branchOf.set(index, descriptor);
    }
    const rootOf = (index: number): number => {
      let cursor = index;
      for (let step = 0; step < chainLimit(nodes); step += 1) {
        const parent = nodes[cursor]?.parent ?? -1;
        if (parent < 0) return cursor;
        cursor = parent;
      }
      return cursor;
    };

    // ── Tiles, in depth-first document order ─────────────────────────────────
    const remap = new Map<number, number>();
    order.forEach((index, position) => remap.set(index, position));
    const format = (value: number): string => formatNumber(value, valueFormat);

    const tiles: TreemapTile[] = [];
    for (const index of order) {
      const node = nodes[index];
      if (node === undefined) continue;
      const branch = branchOf.get(rootOf(index));
      const share = total > 0 ? node.value / total : 0;
      const parentNode = node.parent < 0 ? undefined : nodes[node.parent];
      const valueText = format(node.value);
      const rows: ReadoutRow[] = [readout(node.label, valueText, branch, true)];
      if (parentNode !== undefined) {
        rows.push(readout('Within', parentNode.label));
        rows.push(
          readout(
            `Share of ${parentNode.label}`,
            formatNumber(parentNode.value > 0 ? node.value / parentNode.value : 0, SHARE),
          ),
        );
      }
      rows.push(readout('Share of total', formatNumber(share, SHARE)));
      tiles.push({
        key: node.key,
        label: node.label,
        parent: node.parent < 0 ? -1 : (remap.get(node.parent) ?? -1),
        children: node.children
          .map((child) => remap.get(child))
          .filter((child): child is number => child !== undefined),
        depth: node.depth,
        value: node.value,
        share,
        row: node.row,
        seriesId: branch?.id ?? node.key,
        color: branch?.color ?? input.palette.color(node.key),
        valueText,
        readout: rows,
      });
    }

    const marks: NodeMark[] = tiles.map((tile) => ({
      mark: 'node',
      seriesId: tile.seriesId,
      datum: tile.row,
      key: tile.key,
      ...(tile.parent < 0 ? {} : { parent: tiles[tile.parent]?.key ?? '' }),
      value: tile.value,
      depth: tile.depth,
      label: tile.label,
    }));

    const plan: TreemapPlan = {
      ...basePlan,
      tiles,
      roots: roots
        .map((index) => remap.get(index))
        .filter((index): index is number => index !== undefined),
      total,
      measure,
      category: categoryLabel,
      valueFormat,
    };

    const axes: readonly AxisModel[] = [];
    const result: TreemapEncodeResult = {
      marks,
      series,
      scales: {
        x: createBandScale({ domain: tiles.map((tile) => tile.label), padding: 0 }),
        y: createContinuousScale('linear', { domain: [0, total > 0 ? total : 1] }),
      },
      axes,
      boundColumns: [
        categoryBound.column,
        ...(parentColumn === undefined ? [] : [parentColumn.column]),
        valueBound.column,
      ],
      a11yTable: treemapA11yTable(tiles, total, {
        caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
        categoryLabel,
        categoryType: categoryBound.column.type,
        parentLabel: parentColumn === undefined ? undefined : humaniseColumn(parentColumn.column),
        measure,
        valueType: valueBound.column.type,
        valueFormat,
        presentation: presentationOf(input.attrs),
      }),
      state: plan,
    };
    if (dropped > 0) result.droppedRows = dropped;
    const legend = buildLegend(input.attrs, series, 'rect');
    if (legend !== undefined) result.legend = legend;
    return result;
  },

  layout(encoded: EncodeResult<NodeMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<NodeMark, TreemapPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];
    if (plan.roots.length === 0 || !(frame.width > 0) || !(frame.height > 0)) {
      return { nodes, hits };
    }

    const gap = ctx.theme.marks.spacer.surfaceGap;
    const pad = Math.max(2, gap);
    const leafFont = tickFont(ctx.theme);
    const headFont = labelFont(ctx.theme);
    const ink = ctx.theme.tokens['text-primary'];

    const place = (indices: readonly number[], rect: Rect): { index: number; rect: Rect }[] => {
      const values = indices.map((index) => plan.tiles[index]?.value ?? 0);
      const rects = tileRects(values, rect, plan.tiling);
      const out: { index: number; rect: Rect }[] = [];
      for (let k = 0; k < indices.length; k += 1) {
        const index = indices[k];
        const placed = rects[k];
        if (index !== undefined && placed !== undefined) out.push({ index, rect: placed });
      }
      return out;
    };

    // Depth-first, parents painted before the children that sit on top of them,
    // siblings in document order — which is also the focus order (SPEC 12.4).
    const stack = place(plan.roots, frame).reverse();
    while (stack.length > 0) {
      const step = stack.pop();
      if (step === undefined) continue;
      const tile = plan.tiles[step.index];
      const rect = step.rect;
      if (tile === undefined) continue;
      // Below half a pixel there is no rectangle, only a seam in its neighbour.
      if (!(rect.width > 0.5) || !(rect.height > 0.5)) continue;

      const deeper = plan.depth === undefined || tile.depth + 1 < plan.depth;
      const nested = deeper && tile.children.length > 0;

      // A header is drawn only when the group can spare the band: taking half a
      // small tile for its own name leaves nothing for the parts it is naming.
      let headerHeight = 0;
      let headerText: string | undefined;
      let headerLine = 0;
      if (nested && plan.labels) {
        const metrics = ctx.metrics.measure(tile.label, headFont);
        const line = metrics.ascent + metrics.descent;
        const band = line + gap * 2;
        if (metrics.width + pad * 2 <= rect.width && band * 2 <= rect.height) {
          headerText = tile.label;
          headerHeight = band;
          headerLine = line;
        }
      }

      const top = headerText === undefined ? gap : headerHeight;
      const inner: Rect = {
        x: rect.x + gap,
        y: rect.y + top,
        width: rect.width - gap * 2,
        height: rect.height - top - gap,
      };
      const subdivide = nested && inner.width > 2 && inner.height > 2;

      const nodeId = ctx.ids.next('tile');
      nodes.push({
        kind: 'rect',
        id: nodeId,
        cls: subdivide ? 'mdv-mark mdv-mark-treemap mdv-mark-group' : 'mdv-mark mdv-mark-treemap',
        x: px(rect.x),
        y: px(rect.y),
        w: px(rect.width),
        h: px(rect.height),
        // A group shows only in its frame and header band, so it wears its own
        // colour lightly: the children carry the hue at full strength. A drawn
        // tile is opaque, and says so by omission — an explicit `1` would put a
        // `fill-opacity` on every rectangle in the document for no effect.
        fill: subdivide ? solid(tile.color, GROUP_TINT) : solid(tile.color),
      });

      if (subdivide) {
        if (headerText !== undefined) {
          nodes.push({
            kind: 'text',
            id: ctx.ids.next('label'),
            cls: 'mdv-label mdv-treemap-group-label',
            x: px(rect.x + pad),
            y: px(rect.y + gap + headerLine / 2),
            text: headerText,
            font: headFont,
            // The tint is barely above the surface, so the header takes the text
            // token rather than a colour computed against a fill it is not on.
            fill: solid(ink),
            anchor: 'start',
            baseline: 'middle',
          });
        }
        const children = place(tile.children, inner);
        for (let k = children.length - 1; k >= 0; k -= 1) {
          const child = children[k];
          if (child !== undefined) stack.push(child);
        }
        continue;
      }

      // A drawn tile is a target; a group whose parts are drawn is not — the
      // parts are what a reader is pointing at (SPEC 7.5).
      hits.push(
        hitRegion({
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          datumIndex: tile.row,
          seriesId: tile.seriesId,
          readout: [...tile.readout],
          markNodeId: nodeId,
        }),
      );

      if (!plan.labels || rect.width * rect.height < plan.labelMinArea) continue;
      const fill = readableOn(ctx.theme, tile.color);
      const nameMetrics = ctx.metrics.measure(tile.label, leafFont);
      const line = nameMetrics.ascent + nameMetrics.descent;
      if (nameMetrics.width + pad * 2 > rect.width || line + pad * 2 > rect.height) continue;
      nodes.push({
        kind: 'text',
        id: ctx.ids.next('label'),
        cls: 'mdv-label mdv-treemap-label',
        x: px(rect.x + pad),
        y: px(rect.y + pad + line / 2),
        text: tile.label,
        font: leafFont,
        fill: solid(fill),
        anchor: 'start',
        baseline: 'middle',
        width: px(nameMetrics.width),
      });

      // The number goes on a second line, and only if the tile can hold both:
      // a name without its value still identifies the area it labels.
      const valueMetrics = ctx.metrics.measure(tile.valueText, leafFont);
      if (valueMetrics.width + pad * 2 <= rect.width && line * 2 + pad * 2 <= rect.height) {
        nodes.push({
          kind: 'text',
          id: ctx.ids.next('label'),
          cls: 'mdv-label mdv-treemap-value',
          x: px(rect.x + pad),
          y: px(rect.y + pad + line * 1.5),
          text: tile.valueText,
          font: leafFont,
          fill: solid(fill),
          anchor: 'start',
          baseline: 'middle',
          width: px(valueMetrics.width),
          tabular: true,
        });
      }
    }

    return { nodes, hits };
  },

  describe(input: DescribeInput<NodeMark>): string {
    const plan = planOf<NodeMark, TreemapPlan>(input.encoded, DEFAULT_PLAN);
    if (plan.tiles.length === 0) return 'Treemap with no data.';
    const format = (value: number): string => formatNumber(value, plan.valueFormat);
    const leaves = plan.tiles.filter((tile) => tile.children.length === 0);
    const groups = plan.tiles.length - leaves.length;
    let largest: TreemapTile | undefined;
    for (const tile of leaves) {
      if (largest === undefined || tile.value > largest.value) largest = tile;
    }
    return composeDescription({
      chartKind: 'Treemap',
      ...(subjectPhrase(plan.measure, plan.category) === undefined
        ? {}
        : { subject: subjectPhrase(plan.measure, plan.category) as string }),
      scope:
        groups > 0
          ? `${countPhrase(leaves.length, 'tile')} in ${countPhrase(groups, 'group')}`
          : countPhrase(leaves.length, 'tile'),
      range: `They total ${format(plan.total)}`,
      ...(largest === undefined
        ? {}
        : {
            extreme: `Largest: ${largest.label}, ${format(largest.value)} (${formatNumber(
              largest.share,
              SHARE,
            )} of the whole)`,
          }),
    });
  },
};
