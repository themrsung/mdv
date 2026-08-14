/**
 * `sankey` — where a quantity goes as it divides and recombines (SPEC 8.12).
 *
 * ## What a sankey says, and the four decisions that follow
 *
 * A sankey says **"this much left here, and this much of it arrived there"**.
 * Thickness is the magnitude, and it is the *only* magnitude: a ribbon is the
 * same width at both ends because a flow that narrows in transit is a flow that
 * lost something the table never mentioned. Everything below falls out of that.
 *
 * 1. **A row is a flow, and the nodes are derived.** `source`, `target` and
 *    `value` are three columns of one table, so each row is one ribbon and one
 *    `datumIndex` — a reader pointing at a ribbon is pointing at a row. Nodes
 *    have no rows of their own: they are the distinct names the two endpoint
 *    columns contain, in first-appearance order, and each borrows the row that
 *    first named it so that every target still points at data that exists.
 *
 * 2. **A node's magnitude is the larger of what enters and what leaves.** A
 *    junction that takes 100 and passes on 60 is a node of 100 with 40 stopping
 *    there; drawing it as 160 would double-count the same quantity twice on the
 *    way through, and drawing it as 60 would make the ribbons wider than the bar
 *    they leave. The band is what passes through at its widest moment.
 *
 * 3. **Columns are a longest path, and `align` says which end is anchored.** A
 *    node sits one stage after the latest of its sources (`left`), or one stage
 *    before the earliest of its targets (`right`), or at the far edge when
 *    nothing leaves it (`justify`, the default — it is what makes the terminal
 *    states line up, which is the comparison a sankey is usually read for). A
 *    `source`/`target` pair that closes a loop has no stage order at all: the
 *    edge is refused before it is made and reported once (`MDV3070`).
 *
 * 4. **Colour names the node, and a ribbon wears its source's.** One slot per
 *    node from the allocator (SPEC 11.2 rule 1), ribbons at `linkOpacity` so
 *    crossings stay legible and the bar they leave stays the stronger mark. Past
 *    the palette cap several nodes share the "Other" colour: a sankey identifies
 *    a node by **column, position and label**, never by hue alone, so the cap
 *    costs colour and never identity.
 *
 * ## Order within a column, and why nothing is relaxed
 *
 * Nodes stack in the order their names first appear in the table, so an author
 * moves a band by moving a row and the picture does not rearrange itself after
 * an edit somewhere else. The usual iterative relaxation buys fewer crossings at
 * the price of an arrangement that is a function of the whole graph — a
 * dependency an author cannot see and cannot control. What *is* sorted is the
 * ribbons at each band: outgoing by where they land, incoming by where they came
 * from, which removes the crossings that come from stacking order alone and
 * costs nothing an author would want back.
 *
 * ## No axes
 *
 * There is no position channel and no scale a reader ticks: `axes` is empty and
 * the bundle carries the value extent only so annotations and downstream tooling
 * see a domain rather than nothing.
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
  LinkMark,
  PathCommand,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  RowIndex,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';
import { boolOrStringAttr, enumAttr, numberAttr, stringAttr } from './internal/attrs.js';
import {
  blockDiagnostic,
  incompatibleField,
  missingChannel,
  unknownEnum,
} from './internal/diagnostics.js';
import { hitRegion, readout } from './internal/hit.js';
import { isFiniteNumber } from './internal/num.js';
import { solid, tickFont } from './internal/paint.js';
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
import { formatNumber, keyValue } from './internal/format.js';
import { composeDescription, countPhrase, presentationOf, subjectPhrase } from './internal/a11y.js';
import { closePath, cubicTo, lineTo, moveTo, px } from './internal/geometry.js';

/** Which end of the diagram a node is anchored to (SPEC 8.12). */
const ALIGNMENTS = ['left', 'right', 'center', 'justify'] as const;
type Alignment = (typeof ALIGNMENTS)[number];

/** Share format for the readout and the table view. */
const SHARE = '.1%';

/** A band wide enough to point at, narrow enough not to be the picture. */
const DEFAULT_NODE_WIDTH = 16;

/** Enough gap that two bands read as two, at the default type size. */
const DEFAULT_NODE_PADDING = 12;

/**
 * Ribbons cross, so they are translucent by default: at 0.45 two overlapping
 * flows are still two flows, and the opaque bands stay the stronger mark.
 */
const DEFAULT_LINK_OPACITY = 0.45;

/** The most of the frame's height the gaps between bands may consume. */
const MAX_PADDING_SHARE = 0.5;

/** Below half a pixel there is no ribbon, only a seam in its neighbour. */
const MIN_DRAWN = 0.5;

/** One node of the flow graph, resolved to everything layout needs. */
interface SankeyNode {
  /** Identity — the endpoint cell, verbatim. */
  key: string;
  /** Display name. */
  label: string;
  /** Which column the node stands in, counting from the left. */
  depth: number;
  /** Total arriving. */
  incoming: number;
  /** Total leaving. */
  outgoing: number;
  /** The drawn magnitude: the larger of {@link incoming} and {@link outgoing}. */
  value: number;
  /** The row that first named this node. */
  row: RowIndex;
  seriesId: string;
  color: ColorString;
  /** The magnitude, already formatted (SPEC 12.3: layout never formats). */
  valueText: string;
  readout: readonly ReadoutRow[];
}

/** One flow — one row of the table. */
interface SankeyLink {
  /** Index into {@link SankeyPlan.nodes}. */
  source: number;
  target: number;
  value: number;
  /** Value already stacked below this ribbon where it leaves its source. */
  sourceOffset: number;
  /** Value already stacked below this ribbon where it meets its target. */
  targetOffset: number;
  row: RowIndex;
  seriesId: string;
  color: ColorString;
  valueText: string;
  readout: readonly ReadoutRow[];
}

/** Resolved attributes and the graph, carried from `encode` to `layout`. */
interface SankeyPlan {
  nodes: readonly SankeyNode[];
  links: readonly SankeyLink[];
  /** Node indices by column, each in stacking order. */
  layers: readonly (readonly number[])[];
  nodeWidth: number;
  nodePadding: number;
  align: Alignment;
  linkOpacity: number;
  labels: boolean;
  /** What enters the graph: the nodes nothing flows into, summed. */
  total: number;
  /** "Energy" — for the generated description. */
  measure: string;
  /** "Source" — for the generated description. */
  from: string;
  /** "Destination" — for the generated description. */
  to: string;
  valueFormat: string | undefined;
}

/** A sankey's marks are links, and its plan is the graph (SPEC 8.12). */
export type SankeyEncodeResult = PlannedEncodeResult<LinkMark, SankeyPlan>;

const DEFAULT_PLAN: SankeyPlan = {
  nodes: [],
  links: [],
  layers: [],
  nodeWidth: DEFAULT_NODE_WIDTH,
  nodePadding: DEFAULT_NODE_PADDING,
  align: 'justify',
  linkOpacity: DEFAULT_LINK_OPACITY,
  labels: true,
  total: 0,
  measure: '',
  from: '',
  to: '',
  valueFormat: undefined,
};

/**
 * Only `value` is a channel.
 *
 * SPEC 8.12 lists a sankey's inputs as `source`, `target` and `value`, but the
 * channel vocabulary of SPEC 7.1 is shared and closed, and `source`/`target` are
 * not in it. They are read the way `ohlc` reads `open`/`close` and `treemap`
 * reads `parent` (Appendix B): **attributes that name a column**. The author
 * writes them identically either way — `source: stage` is one line of the header
 * whichever side of the split it lands on — so this costs nothing at the page
 * and keeps every block type answering to one vocabulary.
 */
const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'value',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'How much flows. The ribbon is this thick at both ends.',
  },
];

/** The two ends of a flow, and what each one is for (SPEC 8.12). */
const ENDS = [
  ['source', 'where each flow leaves'],
  ['target', 'where each flow arrives'],
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────────────────────

/** Attributes a sankey reads beyond the common set (SPEC 8.1). */
function readAttrs(input: EncodeInput): {
  nodeWidth: number;
  nodePadding: number;
  align: Alignment;
  linkOpacity: number;
  labels: boolean;
} {
  const { attrs, block } = input;
  const labelRequest = boolOrStringAttr(attrs, 'label');
  return {
    nodeWidth: numberAttr(attrs, 'nodeWidth', DEFAULT_NODE_WIDTH, 1, 200),
    nodePadding: numberAttr(attrs, 'nodePadding', DEFAULT_NODE_PADDING, 0, 200),
    align: enumAttr(attrs, 'align', ALIGNMENTS, 'justify', (given: string) => {
      input.diagnostic(unknownEnum(block, 'align', given, ALIGNMENTS, 'justify'));
    }),
    linkOpacity: numberAttr(attrs, 'linkOpacity', DEFAULT_LINK_OPACITY, 0.05, 1),
    // Labels default **on**: a sankey has no axis, so the bands are the only
    // place a name can appear at all.
    labels:
      labelRequest === undefined
        ? true
        : labelRequest.kind === 'bool'
          ? labelRequest.value
          : labelRequest.value !== 'none',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The graph
// ─────────────────────────────────────────────────────────────────────────────

/** A node under construction, before columns and magnitudes are known. */
interface Building {
  key: string;
  label: string;
  row: RowIndex;
  /** Link indices leaving, in the order they will be stacked. */
  out: number[];
  /** Link indices arriving, in the order they will be stacked. */
  in: number[];
  incoming: number;
  outgoing: number;
  depth: number;
}

/** A flow under construction. */
interface Edge {
  source: number;
  target: number;
  value: number;
  row: RowIndex;
}

/**
 * Assign every node a column.
 *
 * The graph is a DAG — every edge that would close a loop was refused before it
 * was made — so a topological order exists and one relaxation pass over it gives
 * the longest path from a node with nothing flowing into it. That is the `left`
 * answer; the other three are one adjustment on top of it.
 */
function assignDepths(nodes: readonly Building[], edges: readonly Edge[], align: Alignment): void {
  const pending = nodes.map((node) => node.in.length);
  const queue: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (pending[index] === 0) queue.push(index);
  }
  const order: number[] = [];
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    if (index === undefined) continue;
    order.push(index);
    for (const link of nodes[index]?.out ?? []) {
      const target = edges[link]?.target;
      if (target === undefined) continue;
      const left = (pending[target] ?? 0) - 1;
      pending[target] = left;
      if (left === 0) queue.push(target);
    }
  }

  const forward = nodes.map(() => 0);
  for (const index of order) {
    for (const link of nodes[index]?.out ?? []) {
      const target = edges[link]?.target;
      if (target === undefined) continue;
      forward[target] = Math.max(forward[target] ?? 0, (forward[index] ?? 0) + 1);
    }
  }
  let last = 0;
  for (const depth of forward) last = Math.max(last, depth);

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    node.depth = forward[index] ?? 0;
  }

  if (align === 'left') return;

  if (align === 'right') {
    // The longest path *to* a node with nothing leaving it, measured from the
    // right edge: walk the topological order backwards so targets are settled
    // before the sources that feed them.
    const back = nodes.map(() => 0);
    for (let position = order.length - 1; position >= 0; position -= 1) {
      const index = order[position];
      if (index === undefined) continue;
      for (const link of nodes[index]?.out ?? []) {
        const target = edges[link]?.target;
        if (target === undefined) continue;
        back[index] = Math.max(back[index] ?? 0, (back[target] ?? 0) + 1);
      }
    }
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) continue;
      node.depth = last - (back[index] ?? 0);
    }
    return;
  }

  if (align === 'justify') {
    // Terminal states line up at the right edge, which is the comparison a
    // sankey is usually read for: how much ended *here* rather than there.
    for (const node of nodes) {
      if (node.out.length === 0) node.depth = last;
    }
    return;
  }

  // 'center': a node nothing flows into sits directly against the earliest
  // thing it feeds, rather than against the left edge it has no claim on.
  for (const node of nodes) {
    if (node.in.length > 0 || node.out.length === 0) continue;
    let earliest = last;
    for (const link of node.out) {
      const target = edges[link]?.target;
      if (target === undefined) continue;
      earliest = Math.min(earliest, nodes[target]?.depth ?? last);
    }
    node.depth = Math.max(0, earliest - 1);
  }
}

/** The table view: every flow, as the author wrote it (SPEC 12.3). */
function sankeyA11yTable(
  links: readonly SankeyLink[],
  nodes: readonly SankeyNode[],
  total: number,
  options: {
    caption: string;
    fromLabel: string;
    fromType: Column['type'];
    toLabel: string;
    toType: Column['type'];
    measure: string;
    valueType: Column['type'];
    presentation: ReturnType<typeof presentationOf>;
  },
): A11yTable {
  return {
    caption: options.caption,
    columns: [
      { name: options.fromLabel, type: options.fromType, align: 'left' },
      { name: options.toLabel, type: options.toType, align: 'left' },
      { name: options.measure, type: options.valueType, align: 'right' },
      { name: 'Share', type: 'number', align: 'right' },
    ],
    rows: links.map((link) => [
      nodes[link.source]?.label ?? '',
      nodes[link.target]?.label ?? '',
      link.valueText,
      formatNumber(total > 0 ? link.value / total : 0, SHARE),
    ]),
    presentation: options.presentation,
  };
}

/** A well-formed empty result, for a block whose rows resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  series: readonly SeriesDescriptor[],
  plan: SankeyPlan,
): SankeyEncodeResult {
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

/** `sankey` (SPEC 8.12). */
export const sankeyChart: ChartType<LinkMark> = {
  name: 'sankey',
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  // A sankey's entity is its node, and a node is named by the `source` and
  // `target` *attributes* — a node reached from either end is one identity
  // holding one slot, so a ribbon is the same colour at both ends.
  colorIdentityFields: (block) =>
    [stringAttr(block.attrs, 'source'), stringAttr(block.attrs, 'target')].filter(
      (field): field is string => field !== undefined,
    ),
  defaultEncoding: {},
  defaults: {
    nodeWidth: DEFAULT_NODE_WIDTH,
    nodePadding: DEFAULT_NODE_PADDING,
    align: 'justify',
    linkOpacity: DEFAULT_LINK_OPACITY,
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/sankey.json',
  // Two columns of bands, the gap the ribbons need to bend in, and a name
  // outside each column: below this the diagram is a stack of coloured stubs.
  minWidth: 320,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    for (const [name, what] of ENDS) {
      const field = stringAttr(block.attrs, name);
      if (field === undefined) {
        diagnostics.push(missingChannel(block, name, what));
      } else if (findColumn(table, field) === undefined && table.fields.length > 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3000',
            block,
            'encode',
            `\`${name}\` names \`${field}\`, which is not a column`,
            `Point \`${name}:\` at the column holding ${what}.`,
          ),
        );
      }
    }

    const valueChannel = firstChannelOf(block.encoding, ['value']);
    if (valueChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'value', 'how much flows'));
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

    // A ribbon has no direction to run backwards in: a negative flow is two
    // names in the wrong order, and saying so is more use than drawing it.
    for (let row = 0; row < table.rows.length; row += 1) {
      const numeric = cellNumber(cell(table, row, bound.index));
      if (numeric !== null && isFiniteNumber(numeric) && numeric < 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3001',
            block,
            'encode',
            `\`${bound.column.name}\` contains negative values`,
            'A flow cannot be negative. Drop the sign, or swap `source` and `target`.',
          ),
        );
        break;
      }
    }

    return diagnostics;
  },

  encode(input: EncodeInput): SankeyEncodeResult {
    const { table, encoding, block } = input;
    const options = readAttrs(input);

    const valueChannel = firstChannelOf(encoding, ['value']);
    const sourceBound = findColumn(table, stringAttr(block.attrs, 'source'));
    const targetBound = findColumn(table, stringAttr(block.attrs, 'target'));
    const valueBound = bindField(table, valueChannel);

    const basePlan: SankeyPlan = {
      ...DEFAULT_PLAN,
      nodeWidth: options.nodeWidth,
      nodePadding: options.nodePadding,
      align: options.align,
      linkOpacity: options.linkOpacity,
      labels: options.labels,
    };
    if (sourceBound === undefined || targetBound === undefined || valueBound === undefined) {
      return emptyResult(input, [], basePlan);
    }

    const sourceFormat = sourceBound.column.format;
    const targetFormat = targetBound.column.format;
    const valueFormat = channelFormat(valueChannel, valueBound.column);
    const fromLabel = humaniseColumn(sourceBound.column);
    const toLabel = humaniseColumn(targetBound.column);
    const measure = humaniseColumn(valueBound.column);
    const named: SankeyPlan = { ...basePlan, measure, from: fromLabel, to: toLabel, valueFormat };

    // ── Nodes and flows, in first-appearance order ───────────────────────────
    const nodes: Building[] = [];
    const edges: Edge[] = [];
    const byKey = new Map<string, number>();
    const nodeAt = (key: string, row: RowIndex): number => {
      const found = byKey.get(key);
      if (found !== undefined) return found;
      const index = nodes.length;
      byKey.set(key, index);
      nodes.push({
        key,
        label: key,
        row,
        out: [],
        in: [],
        incoming: 0,
        outgoing: 0,
        depth: 0,
      });
      return index;
    };

    /**
     * Can `from` reach `to` along the flows accepted so far? The graph is a DAG
     * while it is being built, so this walk visits each node at most once and a
     * malformed table cannot hang a render.
     */
    const reaches = (from: number, to: number): boolean => {
      const stack = [from];
      const seen = new Set<number>([from]);
      while (stack.length > 0) {
        const index = stack.pop();
        if (index === undefined) continue;
        if (index === to) return true;
        for (const link of nodes[index]?.out ?? []) {
          const next = edges[link]?.target;
          if (next === undefined || seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      return false;
    };

    let dropped = 0;
    let cycles = 0;
    for (let row = 0; row < table.rows.length; row += 1) {
      const sourceKey = keyValue(cell(table, row, sourceBound.index), sourceFormat);
      const targetKey = keyValue(cell(table, row, targetBound.index), targetFormat);
      // A flow needs two ends it can name. One missing end is not a band called
      // "nothing": it is a row that does not say where the energy went.
      if (sourceKey === undefined || targetKey === undefined) {
        dropped += 1;
        continue;
      }
      const numeric = cellNumber(cell(table, row, valueBound.index));
      if (numeric === null || !isFiniteNumber(numeric) || numeric < 0) {
        dropped += 1;
        continue;
      }
      // A flow into its own source is the shortest loop there is, and catching
      // it here keeps it from conjuring a band that nothing else names.
      if (sourceKey === targetKey) {
        cycles += 1;
        dropped += 1;
        continue;
      }
      const source = nodeAt(sourceKey, row);
      const target = nodeAt(targetKey, row);
      // A node created for this row has nothing leaving it yet, so it cannot
      // reach anything: only an established pair can close a loop.
      if (reaches(target, source)) {
        cycles += 1;
        dropped += 1;
        continue;
      }
      const link = edges.length;
      edges.push({ source, target, value: numeric, row });
      nodes[source]?.out.push(link);
      nodes[target]?.in.push(link);
    }

    if (cycles > 0) {
      input.diagnostic(
        blockDiagnostic(
          'MDV3070',
          block,
          'encode',
          cycles === 1
            ? 'One row sends a flow back into what it came from'
            : `${countPhrase(cycles, 'row')} send a flow back into what it came from`,
          'A sankey runs one way, so a loop has no order to draw it in. Those rows are left out.',
        ),
      );
    }

    if (edges.length === 0) {
      return emptyResult(input, [], named);
    }

    for (const edge of edges) {
      const source = nodes[edge.source];
      const target = nodes[edge.target];
      if (source !== undefined) source.outgoing += edge.value;
      if (target !== undefined) target.incoming += edge.value;
    }

    // ── Columns, and the stacking order inside each ──────────────────────────
    assignDepths(nodes, edges, options.align);

    let columns = 0;
    for (const node of nodes) columns = Math.max(columns, node.depth + 1);
    const layers: number[][] = Array.from({ length: columns }, () => []);
    for (let index = 0; index < nodes.length; index += 1) {
      layers[nodes[index]?.depth ?? 0]?.push(index);
    }
    // Where a node sits in its column — the key the ribbons sort by.
    const position = new Map<number, number>();
    for (const layer of layers) layer.forEach((index, at) => position.set(index, at));

    // Outgoing ribbons leave in the order they land, incoming arrive in the
    // order they left: two flows between the same pair of columns cross only
    // when the data crosses, never because of the order the rows were written.
    const rank = (index: number): number => position.get(index) ?? 0;
    for (const node of nodes) {
      node.out.sort((a, b) => {
        const left = edges[a];
        const right = edges[b];
        if (left === undefined || right === undefined) return a - b;
        return rank(left.target) - rank(right.target) || a - b;
      });
      node.in.sort((a, b) => {
        const left = edges[a];
        const right = edges[b];
        if (left === undefined || right === undefined) return a - b;
        return rank(left.source) - rank(right.source) || a - b;
      });
    }

    const sourceOffset = edges.map(() => 0);
    const targetOffset = edges.map(() => 0);
    for (const node of nodes) {
      let leaving = 0;
      for (const link of node.out) {
        sourceOffset[link] = leaving;
        leaving += edges[link]?.value ?? 0;
      }
      let arriving = 0;
      for (const link of node.in) {
        targetOffset[link] = arriving;
        arriving += edges[link]?.value ?? 0;
      }
    }

    // What enters the graph, counted once: the bands nothing flows into.
    let total = 0;
    for (const node of nodes) {
      if (node.in.length === 0) total += Math.max(node.incoming, node.outgoing);
    }

    // ── Colour: one slot per node (decision 4) ───────────────────────────────
    const series: SeriesDescriptor[] = nodes.map((node) => {
      const patternDef = input.palette.patternDef(node.key);
      return {
        id: node.key,
        label: node.label,
        slot: input.palette.slot(node.key),
        color: input.palette.color(node.key),
        source: sourceBound.column.name,
        ...(patternDef === undefined ? {} : { patternDef }),
      };
    });

    const format = (value: number): string => formatNumber(value, valueFormat);
    const shareOf = (value: number, whole: number): string =>
      formatNumber(whole > 0 ? value / whole : 0, SHARE);

    const resolved: SankeyNode[] = nodes.map((node, index) => {
      const descriptor = series[index];
      const value = Math.max(node.incoming, node.outgoing);
      const valueText = format(value);
      const rows: ReadoutRow[] = [readout(node.label, valueText, descriptor, true)];
      // Both sides only when they disagree: repeating one number under two
      // headings tells a reader nothing they cannot see in the band.
      if (node.in.length > 0 && node.out.length > 0 && node.incoming !== node.outgoing) {
        rows.push(readout('In', format(node.incoming)));
        rows.push(readout('Out', format(node.outgoing)));
      }
      rows.push(readout('Share of total', shareOf(value, total)));
      return {
        key: node.key,
        label: node.label,
        depth: node.depth,
        incoming: node.incoming,
        outgoing: node.outgoing,
        value,
        row: node.row,
        seriesId: descriptor?.id ?? node.key,
        color: descriptor?.color ?? input.palette.color(node.key),
        valueText,
        readout: rows,
      };
    });

    const links: SankeyLink[] = edges.map((edge, index) => {
      const source = resolved[edge.source];
      const target = resolved[edge.target];
      const valueText = format(edge.value);
      const rows: ReadoutRow[] = [
        readout(
          `${source?.label ?? ''} → ${target?.label ?? ''}`,
          valueText,
          series[edge.source],
          true,
        ),
      ];
      if (source !== undefined && source.value > edge.value) {
        rows.push(readout(`Share of ${source.label}`, shareOf(edge.value, source.value)));
      }
      if (target !== undefined && target.value > edge.value) {
        rows.push(readout(`Share of ${target.label}`, shareOf(edge.value, target.value)));
      }
      rows.push(readout('Share of total', shareOf(edge.value, total)));
      return {
        source: edge.source,
        target: edge.target,
        value: edge.value,
        sourceOffset: sourceOffset[index] ?? 0,
        targetOffset: targetOffset[index] ?? 0,
        row: edge.row,
        seriesId: source?.seriesId ?? '',
        color: source?.color ?? input.palette.color(source?.key ?? ''),
        valueText,
        readout: rows,
      };
    });

    const marks: LinkMark[] = links.map((link) => ({
      mark: 'link',
      seriesId: link.seriesId,
      datum: link.row,
      source: resolved[link.source]?.key ?? '',
      target: resolved[link.target]?.key ?? '',
      value: link.value,
    }));

    let tallest = 0;
    for (const layer of layers) {
      let sum = 0;
      for (const index of layer) sum += resolved[index]?.value ?? 0;
      tallest = Math.max(tallest, sum);
    }

    const plan: SankeyPlan = { ...named, nodes: resolved, links, layers, total };

    const axes: readonly AxisModel[] = [];
    const result: SankeyEncodeResult = {
      marks,
      series,
      scales: {
        x: createBandScale({ domain: resolved.map((node) => node.label), padding: 0 }),
        y: createContinuousScale('linear', { domain: [0, tallest > 0 ? tallest : 1] }),
      },
      axes,
      boundColumns: [sourceBound.column, targetBound.column, valueBound.column],
      a11yTable: sankeyA11yTable(links, resolved, total, {
        caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
        fromLabel,
        fromType: sourceBound.column.type,
        toLabel,
        toType: targetBound.column.type,
        measure,
        valueType: valueBound.column.type,
        presentation: presentationOf(input.attrs),
      }),
      state: plan,
    };
    if (dropped > 0) result.droppedRows = dropped;
    const legend = buildLegend(input.attrs, series, 'rect');
    if (legend !== undefined) result.legend = legend;
    return result;
  },

  layout(encoded: EncodeResult<LinkMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<LinkMark, SankeyPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];
    if (plan.layers.length === 0 || !(frame.width > 0) || !(frame.height > 0)) {
      return { nodes, hits };
    }

    const gap = ctx.theme.marks.spacer.surfaceGap;
    const pad = Math.max(2, gap);
    const font = tickFont(ctx.theme);
    const ink = ctx.theme.tokens['text-primary'];

    // ── Horizontal: one band per column, the rest of the width for ribbons ───
    const columns = plan.layers.length;
    const width = Math.max(1, Math.min(plan.nodeWidth, frame.width / Math.max(2, columns * 2)));
    const step = columns > 1 ? (frame.width - width) / (columns - 1) : 0;
    const middle = frame.x + (frame.width - width) / 2;
    const xOf = (depth: number): number => (columns > 1 ? frame.x + depth * step : middle);

    // ── Vertical: one scale for the whole diagram, set by its fullest column ─
    let mostBands = 1;
    for (const layer of plan.layers) mostBands = Math.max(mostBands, layer.length);
    // Gaps never take more than half the height: past that the bands they are
    // separating have nothing left to be.
    const spread =
      mostBands > 1
        ? Math.min(plan.nodePadding, (frame.height * MAX_PADDING_SHARE) / (mostBands - 1))
        : 0;

    let scale = Number.POSITIVE_INFINITY;
    for (const layer of plan.layers) {
      let sum = 0;
      for (const index of layer) sum += plan.nodes[index]?.value ?? 0;
      const room = frame.height - spread * Math.max(0, layer.length - 1);
      if (sum > 0 && room > 0) scale = Math.min(scale, room / sum);
    }
    // Every column summed to nothing, so there is no thickness to draw.
    if (!Number.isFinite(scale)) return { nodes, hits };

    const top = new Map<number, number>();
    const height = new Map<number, number>();
    for (const layer of plan.layers) {
      let stack = spread * Math.max(0, layer.length - 1);
      for (const index of layer) stack += (plan.nodes[index]?.value ?? 0) * scale;
      // Columns are centred against each other: a short column hanging from the
      // top edge would read as a fall in the quantity rather than in the count.
      let y = frame.y + (frame.height - stack) / 2;
      for (const index of layer) {
        const band = (plan.nodes[index]?.value ?? 0) * scale;
        top.set(index, y);
        height.set(index, band);
        y += band + spread;
      }
    }

    // ── Ribbons first, so the bands they meet are painted over them ──────────
    for (const link of plan.links) {
      const source = plan.nodes[link.source];
      const target = plan.nodes[link.target];
      if (source === undefined || target === undefined) continue;
      const thickness = link.value * scale;
      if (!(thickness > MIN_DRAWN)) continue;
      const x0 = xOf(source.depth) + width;
      const x1 = xOf(target.depth);
      const y0 = (top.get(link.source) ?? 0) + link.sourceOffset * scale;
      const y1 = (top.get(link.target) ?? 0) + link.targetOffset * scale;
      const bend = (x0 + x1) / 2;
      // Both control points on the halfway line: the curve leaves and arrives
      // horizontally, so a ribbon meets its band square rather than at a slant.
      const d: PathCommand[] = [
        moveTo(x0, y0),
        cubicTo(bend, y0, bend, y1, x1, y1),
        lineTo(x1, y1 + thickness),
        cubicTo(bend, y1 + thickness, bend, y0 + thickness, x0, y0 + thickness),
        closePath(),
      ];
      const id = ctx.ids.next('flow');
      nodes.push({
        kind: 'path',
        id,
        cls: 'mdv-mark mdv-mark-sankey-link',
        d,
        fill: solid(link.color, plan.linkOpacity),
      });

      // A ribbon is not a rectangle, and a target over its whole span would
      // swallow every ribbon it crosses. The middle third is where it is
      // unambiguously itself — and with both control points on the halfway
      // line, its centre there is exactly the mean of the two ends.
      const span = Math.max(1, (x1 - x0) / 3);
      hits.push(
        hitRegion({
          x: bend - span / 2,
          y: (y0 + y1) / 2,
          w: span,
          h: thickness,
          anchor: { x: bend, y: (y0 + y1) / 2 + thickness / 2 },
          datumIndex: link.row,
          seriesId: link.seriesId,
          readout: [...link.readout],
          markNodeId: id,
        }),
      );
    }

    // ── Bands, then their names ──────────────────────────────────────────────
    for (let index = 0; index < plan.nodes.length; index += 1) {
      const node = plan.nodes[index];
      const y = top.get(index);
      const band = height.get(index);
      if (node === undefined || y === undefined || band === undefined) continue;
      if (!(band > MIN_DRAWN)) continue;
      const x = xOf(node.depth);

      const id = ctx.ids.next('node');
      nodes.push({
        kind: 'rect',
        id,
        cls: 'mdv-mark mdv-mark-sankey-node',
        x: px(x),
        y: px(y),
        w: px(width),
        h: px(band),
        fill: solid(node.color),
      });
      hits.push(
        hitRegion({
          x,
          y,
          w: width,
          h: band,
          datumIndex: node.row,
          seriesId: node.seriesId,
          readout: [...node.readout],
          markNodeId: id,
        }),
      );

      if (!plan.labels) continue;
      const metrics = ctx.metrics.measure(node.label, font);
      const line = metrics.ascent + metrics.descent;
      // A band plus the gap under it is the room the name has before it starts
      // reading as the neighbour's.
      if (band + spread < line) continue;
      // Outside and to the right, except in the last column where there is no
      // outside to the right — then the name goes on the other side of the band.
      const trailing = node.depth === columns - 1;
      const right = { anchor: 'start' as const, x: x + width + pad };
      const left = { anchor: 'end' as const, x: x - pad };
      const fits = (side: { anchor: 'start' | 'end'; x: number }): boolean =>
        side.anchor === 'start'
          ? side.x + metrics.width <= frame.x + frame.width
          : side.x - metrics.width >= frame.x;
      const first = trailing ? left : right;
      const second = trailing ? right : left;
      const side = fits(first) ? first : fits(second) ? second : undefined;
      // Half a name beside a band is worse than none, and the table view has
      // every name anyway (SPEC 11.5).
      if (side === undefined) continue;
      nodes.push({
        kind: 'text',
        id: ctx.ids.next('label'),
        cls: 'mdv-label mdv-sankey-label',
        x: px(side.x),
        y: px(y + band / 2),
        text: node.label,
        font,
        fill: solid(ink),
        anchor: side.anchor,
        baseline: 'middle',
        width: px(metrics.width),
      });
    }

    return { nodes, hits };
  },

  describe(input: DescribeInput<LinkMark>): string {
    const plan = planOf<LinkMark, SankeyPlan>(input.encoded, DEFAULT_PLAN);
    if (plan.links.length === 0) return 'Sankey diagram with no data.';
    const format = (value: number): string => formatNumber(value, plan.valueFormat);
    let largest: SankeyLink | undefined;
    for (const link of plan.links) {
      if (largest === undefined || link.value > largest.value) largest = link;
    }
    const subject = subjectPhrase(plan.measure, plan.from);
    return composeDescription({
      chartKind: 'Sankey diagram',
      ...(subject === undefined ? {} : { subject }),
      scope: `${countPhrase(plan.links.length, 'flow')} between ${countPhrase(
        plan.nodes.length,
        'node',
      )} in ${countPhrase(plan.layers.length, 'stage')}`,
      range: `${format(plan.total)} enters the diagram`,
      ...(largest === undefined
        ? {}
        : {
            extreme: `Largest flow: ${plan.nodes[largest.source]?.label ?? ''} to ${
              plan.nodes[largest.target]?.label ?? ''
            }, ${format(largest.value)}`,
          }),
    });
  },
};
