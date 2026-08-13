/**
 * `funnel` — what is left of a population at each stage (SPEC 8.12).
 *
 * A funnel is a sequence, not a distribution. Each row is a stage, each stage
 * holds fewer than the one before it, and the reader's question is always the
 * same: *where did they go?* Three decisions follow from that question, and all
 * three are load-bearing.
 *
 * 1. **Order is data.** Rows are walked in document order and never sorted — a
 *    funnel read out of order is a different claim about the same numbers. Two
 *    stages may legitimately carry the same label, so the band domain is the
 *    *stage index* and the axis label comes back through
 *    {@link BandScaleOptions.labelOf}, exactly as `waterfall` does it.
 *
 * 2. **There is no value axis.** A stage is drawn centred, so its two edges move
 *    with its own value and neither edge sits at a fixed origin. An axis along
 *    that direction would invite reading a *position* that means nothing. The
 *    numbers reach the reader instead through direct labels (on by default here,
 *    precisely because there is no axis to read), the readout, and the table
 *    view — three routes, none of them a ruler drawn against a shape that has no
 *    baseline.
 *
 * 3. **Colour encodes progress, not identity.** The stages take an *ordinal*
 *    ramp (SPEC 11.3) deepening away from the surface, whose lightest step still
 *    clears 2:1. The ramp is therefore not a set of palette slots, and the
 *    stages are not series — folding them into `series` would have put them in
 *    the legend as though a sixth stage were a sixth *thing*, when the category
 *    axis already names every one of them. `waterfall` declines the legend for
 *    the same reason.
 *
 * `orientation` is inherited from `bar` (SPEC 8.2) and means the direction the
 * funnel **flows**, which inverts the bar's reading of the same word: `vertical`
 * (the default) runs top to bottom and so puts the category axis on the *left*,
 * while `horizontal` runs left to right and puts it at the *bottom*. That is not
 * an inconsistency to fix — a "vertical funnel" is the shape everyone draws, and
 * naming it after the flow is the only naming a reader would predict.
 */

import type {
  A11yTable,
  AxisModel,
  BarMark,
  BlockAttrs,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  Column,
  DescribeInput,
  Diagnostic,
  DirectLabel,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  PathCommand,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  ScaleInput,
  ScaleSpec,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';

import {
  alignFor,
  composeDescription,
  countPhrase,
  presentationOf,
  subjectPhrase,
} from './internal/a11y.js';
import type { Annotation } from './internal/annotations.js';
import { annotationNodes, parseAnnotations } from './internal/annotations.js';
import { boolAttr, boolOrStringAttr, enumAttr } from './internal/attrs.js';
import {
  axisSpecFor,
  isDegenerateFrame,
  makeAxis,
  rangeDownFrame,
  rangeToFrame,
} from './internal/cartesian.js';
import {
  blockDiagnostic,
  incompatibleField,
  missingChannel,
  unknownEnum,
} from './internal/diagnostics.js';
import { closePath, lineTo, moveTo, px } from './internal/geometry.js';
import { hitRegion, readout } from './internal/hit.js';
import { isFiniteNumber } from './internal/num.js';
import { ordinalRamp, solid } from './internal/paint.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import { planOf } from './internal/plan.js';
import { createBandScale, createContinuousScale } from './internal/scale.js';
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

/** Which way the funnel flows. */
const ORIENTATIONS = ['vertical', 'horizontal'] as const;
type Orientation = (typeof ORIENTATIONS)[number];

/** How a stage is drawn. */
const SHAPES = ['trapezoid', 'rect'] as const;
type FunnelShape = (typeof SHAPES)[number];

/** Share formats: compact where it is drawn, precise where it is read. */
const SHARE_DRAWN = '.0%';
const SHARE_READ = '.1%';

/**
 * The value-scale knobs a funnel cannot honour.
 *
 * A funnel's widths *are* its numbers: the domain is pinned to zero and the
 * widest stage, and the scale is linear, so that half the width reads as half
 * the count. Every knob here would break that reading, so none is applied — and
 * an author who pinned a domain should be told, not left measuring the stages
 * and wondering. The list is in declaration order so the message is stable.
 */
const INERT_SCALE_KNOBS: readonly (keyof ScaleSpec)[] = [
  'type',
  'base',
  'exponent',
  'constant',
  'domain',
  'range',
  'zero',
  'nice',
  'clamp',
  'padding',
  'reverse',
];

/** One stage, in the order the document listed it. */
interface FunnelEntry {
  /** The axis label and the readout's subject. */
  label: string;
  value: number;
  /**
   * Fraction of the *first* stage; `1` for the first stage itself, `undefined`
   * when the first stage was zero and there is no whole to be a share of.
   */
  share: number | undefined;
  /**
   * **Signed** change since the previous stage: negative is the loss a funnel
   * expects, positive is a stage that grew. `undefined` for the first stage and
   * for any stage whose predecessor was zero — nothing can be lost from nothing.
   *
   * Storing the loss unsigned would have been the shorter field and the wrong
   * one: a funnel whose third stage *gains* is real (re-entry, a stage counted
   * twice, a broken join) and is exactly the thing the reader must be shown,
   * not silently rendered as though it fell.
   */
  change: number | undefined;
  /** Row this stage was read from, for the readout and the hit region. */
  row: number;
  color: ColorString;
  readout: ReadoutRow[];
  /** Direct label text, when the block asked for labels. */
  text: string | undefined;
}

/** Per-mark data a funnel owns, carried from `encode` to `layout`. */
interface FunnelPlan {
  entries: FunnelEntry[];
  orientation: Orientation;
  shape: FunnelShape;
  /** Whether the stage-to-stage loss is *drawn*; it is always in the readout. */
  showDropoff: boolean;
  /** What the stages measure, for the generated description. */
  measure: string | undefined;
  /** What the stages are of, for the generated description. */
  category: string | undefined;
  valueFormat: string | undefined;
  annotations: readonly Annotation[];
}

/** A funnel's stages are magnitudes against a common origin, so its marks are {@link BarMark}s. */
export type FunnelEncodeResult = PlannedEncodeResult<BarMark, FunnelPlan>;

const DEFAULT_PLAN: FunnelPlan = {
  entries: [],
  orientation: 'vertical',
  shape: 'trapezoid',
  showDropoff: true,
  measure: undefined,
  category: undefined,
  valueFormat: undefined,
  annotations: [],
};

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'category',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime'],
    defaultScale: 'band',
    doc: 'The stage each band names. Row order is the funnel and is never sorted.',
  },
  {
    name: 'value',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'How many reached each stage. Negative rows are dropped.',
  },
];

/**
 * The one series a funnel has.
 *
 * See the note at the top of the file: the ordinal ramp encodes *progress*, and
 * a legend of progress is the category axis.
 */
function singleSeries(input: EncodeInput, column: Column | undefined): SeriesDescriptor {
  const { palette } = input;
  const patternDef = palette.patternDef('');
  return {
    id: '',
    label: column === undefined ? 'Value' : humaniseColumn(column),
    slot: palette.slot(''),
    color: palette.color(''),
    source: column?.name ?? '',
    ...(patternDef === undefined ? {} : { patternDef }),
  };
}

/**
 * A stage-to-stage change, with its sign spelled out.
 *
 * `formatNumber` carries the minus itself; only a rise needs the `+` added, and
 * it needs it badly — direction must survive a greyscale print, where the label
 * is all that is left to say the funnel went the wrong way.
 */
function changeText(change: number, format: string): string {
  const text = formatNumber(change, format);
  return change > 0 && !text.startsWith('+') ? `+${text}` : text;
}

/**
 * The readout for one stage.
 *
 * The drop-off is here whether or not `showDropoff` drew it. Accessibility never
 * depends on a decoration attribute: turning a label off is a request about ink,
 * not a request to withhold the number from the reader who cannot see ink.
 */
function stageReadout(
  categoryLabel: string,
  measure: string,
  entry: FunnelEntry,
  previous: FunnelEntry | undefined,
  series: SeriesDescriptor,
  format: (value: number) => string,
): ReadoutRow[] {
  const rows: ReadoutRow[] = [
    readout(categoryLabel, entry.label),
    readout(measure, format(entry.value), series, true),
  ];
  if (previous !== undefined && entry.share !== undefined) {
    rows.push(readout('Share of first', formatNumber(entry.share, SHARE_READ)));
  }
  if (previous !== undefined && entry.change !== undefined) {
    rows.push(readout(`Change from ${previous.label}`, changeText(entry.change, SHARE_READ)));
  }
  return rows;
}

/**
 * The table view for a funnel (SPEC 12.3).
 *
 * Share and change are **derived**, not columns the document holds, and they are
 * here anyway: they are what the shape shows, and a table of raw counts would
 * leave a reader to divide the column the bands already divided.
 */
function funnelA11yTable(
  caption: string,
  categoryLabel: string,
  categoryType: Column['type'],
  measure: string,
  entries: readonly FunnelEntry[],
  attrs: BlockAttrs,
  format: (value: number) => string,
): A11yTable {
  return {
    caption,
    columns: [
      { name: categoryLabel, type: categoryType, align: alignFor(categoryType) },
      { name: measure, type: 'number', align: 'right' as const },
      { name: 'Share of first', type: 'number', align: 'right' as const },
      { name: 'Change', type: 'number', align: 'right' as const },
    ],
    rows: entries.map((entry) => [
      entry.label,
      format(entry.value),
      entry.share === undefined ? '' : formatNumber(entry.share, SHARE_READ),
      entry.change === undefined ? '' : changeText(entry.change, SHARE_READ),
    ]),
    presentation: presentationOf(attrs),
  };
}

/** Attributes a funnel reads beyond the common set (SPEC 8.1). */
function readAttrs(input: EncodeInput): {
  orientation: Orientation;
  shape: FunnelShape;
  showDropoff: boolean;
  labels: boolean;
} {
  const { attrs, block } = input;
  const report =
    (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
      input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
    };
  const labelRequest = boolOrStringAttr(attrs, 'label');
  return {
    orientation: enumAttr(
      attrs,
      'orientation',
      ORIENTATIONS,
      'vertical',
      report('orientation', ORIENTATIONS, 'vertical'),
    ),
    shape: enumAttr(attrs, 'shape', SHAPES, 'trapezoid', report('shape', SHAPES, 'trapezoid')),
    showDropoff: boolAttr(attrs, 'showDropoff', true),
    // Labels default **on**: decision 2 at the top of the file removed the axis
    // that would otherwise have carried the numbers.
    labels:
      labelRequest === undefined
        ? true
        : labelRequest.kind === 'bool'
          ? labelRequest.value
          : labelRequest.value !== 'none',
  };
}

/** `funnel` (SPEC 8.12). */
export const funnelChart: ChartType<BarMark> = {
  name: 'funnel',
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: {
    orientation: 'vertical',
    shape: 'trapezoid',
    showDropoff: true,
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/funnel.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const categoryChannel = firstChannelOf(block.encoding, ['category', 'x', 'label']);
    if (categoryChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'category', 'the stage each band names'));
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
      diagnostics.push(missingChannel(block, 'value', 'how many reached each stage'));
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
      return diagnostics;
    }

    // A scale spec on the value channel is inert here (see INERT_SCALE_KNOBS),
    // and silently dropping one costs an author an afternoon. `MDV1501` is the
    // code for a knob that is read and then ignored (SPEC 15.2), which is what
    // `table` already reports for `pageSize` on a static render.
    const inert = INERT_SCALE_KNOBS.filter((knob) => valueChannel.scale?.[knob] !== undefined);
    if (inert.length > 0) {
      const names = inert.map((knob) => `\`value.scale.${knob}\``);
      const last = names.pop() ?? '';
      diagnostics.push(
        blockDiagnostic(
          'MDV1501',
          block,
          'encode',
          `${names.length === 0 ? last : `${names.join(', ')} and ${last}`} ${
            names.length === 0 ? 'has' : 'have'
          } no effect on a funnel`,
          'A funnel is read as a share of its first stage, so its widths stay proportional to the counts. A bar chart can crop or transform a value axis.',
        ),
      );
    }

    // A stage cannot hold fewer than nobody. A negative row is a data error or a
    // column that means something other than a population, and either way the
    // band it would draw points the wrong way out of the funnel.
    for (let row = 0; row < table.rows.length; row += 1) {
      const numeric = cellNumber(cell(table, row, bound.index));
      if (numeric !== null && numeric < 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3001',
            block,
            'encode',
            `\`${bound.column.name}\` contains negative values`,
            'A funnel stage counts what is left, which cannot be below zero. Use a bar chart, which can show values below a baseline.',
          ),
        );
        break;
      }
    }

    return diagnostics;
  },

  encode(input: EncodeInput): FunnelEncodeResult {
    const { table, encoding, attrs } = input;
    const options = readAttrs(input);

    const categoryChannel = firstChannelOf(encoding, ['category', 'x', 'label']);
    const valueChannel = firstChannelOf(encoding, ['value', 'y']);
    const categoryBound = bindField(table, categoryChannel);
    const valueBound = bindField(table, valueChannel);
    const series = singleSeries(input, valueBound?.column);

    if (categoryBound === undefined || valueBound === undefined) {
      return emptyResult(input, [series], options);
    }

    const categoryFormat = channelFormat(categoryChannel, categoryBound.column);
    const valueFormat = channelFormat(valueChannel, valueBound.column);
    const categoryLabel = humaniseColumn(categoryBound.column);
    const measure = humaniseColumn(valueBound.column);

    // ── The stages ────────────────────────────────────────────────────────────
    // Zero is kept. A stage nobody reached is the most important fact a funnel
    // can carry, and dropping the row would close the gap in the sequence and
    // hide it. Negative and unreadable rows go, and are counted.
    const entries: FunnelEntry[] = [];
    let dropped = 0;
    for (let row = 0; row < table.rows.length; row += 1) {
      const numeric = cellNumber(cell(table, row, valueBound.index));
      if (numeric === null || !isFiniteNumber(numeric) || numeric < 0) {
        dropped += 1;
        continue;
      }
      entries.push({
        label: formatValue(cell(table, row, categoryBound.index), categoryFormat),
        value: numeric,
        share: undefined,
        change: undefined,
        row,
        color: '#000000',
        readout: [],
        text: undefined,
      });
    }

    if (entries.length === 0) return emptyResult(input, [series], options);

    const first = entries[0]?.value ?? 0;
    const ramp = ordinalRamp(input.theme, entries.length);
    const format = (value: number): string => formatNumber(value, valueFormat);

    for (const [index, entry] of entries.entries()) {
      const previous = index === 0 ? undefined : entries[index - 1];
      // A zero first stage leaves no whole to be a share of, and 0 / 0 = 1 would
      // have claimed every later stage held "100 % of the first".
      entry.share = first === 0 ? undefined : entry.value / first;
      entry.change =
        previous === undefined || previous.value === 0
          ? undefined
          : (entry.value - previous.value) / previous.value;
      entry.color = ramp[index] ?? series.color;
      entry.readout = stageReadout(categoryLabel, measure, entry, previous, series, format);
      if (options.labels) entry.text = format(entry.value);
    }

    // ── Scales ────────────────────────────────────────────────────────────────
    // The domain is the stage index, not the label: see the note at the top of
    // the file about repeated stage names. Padding is zero because the stages of
    // a funnel are one silhouette; they are separated by the theme's 2 px
    // surface gap at layout, which is what separates adjacent marks everywhere
    // else (SPEC 11.4) and, unlike band padding, does not scale with the frame.
    const categoryScale = createBandScale({
      domain: entries.map((_, index) => index),
      padding: 0,
      labelOf: (value: ScaleInput): string =>
        typeof value === 'number' ? (entries[value]?.label ?? String(value)) : String(value),
    });

    // The widest stage sets the scale and every other stage is read against it.
    // A funnel is a part-of-the-first picture, so the domain starts at zero and
    // is never cropped — an axis-less chart has nothing to warn a reader with.
    let peak = 0;
    for (const entry of entries) peak = Math.max(peak, entry.value);
    const valueScale = createContinuousScale('linear', {
      domain: [0, peak > 0 ? peak : 1],
      ...(valueFormat === undefined ? {} : { format: valueFormat }),
    });

    // ── Marks ─────────────────────────────────────────────────────────────────
    const marks: BarMark[] = entries.map((entry, index) => {
      const mark: BarMark = {
        mark: 'bar',
        seriesId: '',
        datum: entry.row,
        x: index,
        y0: 0,
        y1: entry.value,
      };
      if (entry.text !== undefined) mark.label = entry.text;
      return mark;
    });

    // ── Axes ──────────────────────────────────────────────────────────────────
    // The category axis, and only the category axis. There is no value axis by
    // construction, so there is no `axis: { y: … }` for an author to reach for
    // and no second axis for SPEC 7.3.1 to forbid.
    const vertical = options.orientation === 'vertical';
    const categoryAxis = makeAxis({
      channel: 'x',
      position: vertical ? 'left' : 'bottom',
      scale: categoryScale,
      binding: categoryChannel,
      column: categoryBound.column,
      spec: axisSpecFor(attrs, 'x', categoryChannel),
      gridByDefault: false,
      baselineByDefault: false,
    });
    const axes: AxisModel[] = categoryAxis === undefined ? [] : [categoryAxis];

    const result: FunnelEncodeResult = {
      marks,
      series: [series],
      scales: { x: categoryScale, y: valueScale },
      axes,
      boundColumns: [categoryBound.column, valueBound.column],
      a11yTable: funnelA11yTable(
        attrs.title ?? attrs.caption ?? 'Chart data',
        categoryLabel,
        categoryBound.column.type,
        measure,
        entries,
        attrs,
        format,
      ),
      state: {
        entries,
        orientation: options.orientation,
        shape: options.shape,
        showDropoff: options.showDropoff,
        measure,
        category: categoryLabel,
        valueFormat,
        annotations: parseAnnotations(attrs),
      },
    };
    if (dropped > 0) result.droppedRows = dropped;
    return result;
  },

  layout(encoded: EncodeResult<BarMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<BarMark, FunnelPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];
    const labels: DirectLabel[] = [];

    const categoryScale = encoded.scales.x;
    const valueScale = encoded.scales.y;
    if (categoryScale === undefined || valueScale === undefined) return { nodes, hits };

    const vertical = plan.orientation === 'vertical';
    if (vertical) {
      rangeDownFrame(frame, categoryScale);
      rangeToFrame(frame, valueScale, undefined);
    } else {
      rangeToFrame(frame, categoryScale, valueScale);
    }
    if (isDegenerateFrame(frame) || encoded.marks.length === 0) return { nodes, hits };

    const theme = ctx.theme;
    const gap = theme.marks.spacer.surfaceGap;
    const band = typeof categoryScale.bandwidth === 'function' ? categoryScale.bandwidth() : 0;
    const origin = valueScale.scale(0);
    if (!isFiniteNumber(origin) || !(band > 0)) return { nodes, hits };

    // The axis the funnel is centred on. Both edges of a stage move with its own
    // value, which is exactly why there is no scale drawn along this direction.
    const centre = vertical ? frame.x + frame.width / 2 : frame.y + frame.height / 2;

    /** Pixels across the flow for one stage's value; never zero, so a dead stage still shows. */
    const spanOf = (value: number): number => {
      const end = valueScale.scale(value);
      return isFiniteNumber(end) ? Math.max(1, Math.abs(end - origin)) : 1;
    };

    // Geometry first, for every stage, because a trapezoid's trailing edge is
    // its *successor's* leading edge and cannot be drawn without it.
    const placed: { start: number; end: number; span: number; entry: FunnelEntry }[] = [];
    for (const [index, mark] of encoded.marks.entries()) {
      const entry = plan.entries[index];
      if (entry === undefined) continue;
      const bandStart = categoryScale.scale(mark.x);
      if (!isFiniteNumber(bandStart)) continue;
      // Half the surface gap at each end: the stages meet edge to edge and the
      // page shows through the seam, rather than a stroke being painted into it.
      const inset = Math.min(gap / 2, band / 4);
      placed.push({
        start: bandStart + inset,
        end: bandStart + band - inset,
        span: spanOf(mark.y1),
        entry,
      });
    }

    for (const [index, stage] of placed.entries()) {
      const { start, end, span, entry } = stage;
      // A trapezoid leaves at the width its successor arrives with, so the
      // silhouette stays continuous across the seam. The last stage has no
      // successor to taper towards, so it closes square.
      const trailing = plan.shape === 'trapezoid' ? (placed[index + 1]?.span ?? span) : span;
      const nodeId = ctx.ids.next('funnel');
      const near = centre - span / 2;
      const far = centre - trailing / 2;

      const d: PathCommand[] = vertical
        ? [
            moveTo(px(near), px(start)),
            lineTo(px(near + span), px(start)),
            lineTo(px(far + trailing), px(end)),
            lineTo(px(far), px(end)),
            closePath(),
          ]
        : [
            moveTo(px(start), px(near)),
            lineTo(px(start), px(near + span)),
            lineTo(px(end), px(far + trailing)),
            lineTo(px(end), px(far)),
            closePath(),
          ];

      nodes.push({
        kind: 'path',
        id: nodeId,
        cls: 'mdv-mark mdv-mark-funnel',
        d,
        fill: solid(entry.color),
      });

      // The hit region is the stage's bounding box, not its trapezoid: a pointer
      // near a tapering edge is still pointing at that stage, and SPEC 7.5 would
      // have grown a thin shape to 24 px anyway.
      const outer = Math.max(span, trailing);
      hits.push(
        hitRegion({
          x: vertical ? centre - outer / 2 : start,
          y: vertical ? start : centre - outer / 2,
          w: vertical ? outer : end - start,
          h: vertical ? end - start : outer,
          datumIndex: entry.row,
          readout: entry.readout,
          markNodeId: nodeId,
        }),
      );

      if (entry.text !== undefined) {
        // The value sits inside its own band. `insideFill` is how core picks
        // white or ink against the ramp step — the text is never *tinted*
        // (SPEC 11.5). Core drops it if the stage has narrowed too far to hold it.
        labels.push({
          x: vertical ? centre : (start + end) / 2,
          y: vertical ? (start + end) / 2 : centre,
          text: entry.text,
          placement: 'inside',
          priority: span,
          seriesId: '',
          datum: entry.row,
          insideFill: entry.color,
        });
      }

      if (plan.showDropoff && index > 0 && entry.change !== undefined) {
        const previous = placed[index - 1];
        if (previous !== undefined) {
          // The loss belongs to the seam, not to either stage, so it is anchored
          // in the gap and pushed clear of the wider of the two silhouettes.
          const reach = Math.max(previous.span, span) / 2;
          const seam = (previous.end + start) / 2;
          labels.push({
            x: vertical ? centre + reach : seam,
            y: vertical ? seam : centre - reach,
            text: changeText(entry.change, SHARE_DRAWN),
            placement: vertical ? 'end' : 'above',
            // Below both stages it joins: when space is short the reader should
            // lose the derived number before either of the two it derives from.
            priority: Math.min(previous.span, span) / 2,
            seriesId: '',
            datum: entry.row,
          });
        }
      }
    }

    nodes.push(
      ...annotationNodes(plan.annotations, { x: categoryScale, y: valueScale }, frame, ctx),
    );

    return labels.length > 0 ? { nodes, hits, labels } : { nodes, hits };
  },

  describe(input: DescribeInput<BarMark>): string {
    const { encoded } = input;
    const plan = planOf<BarMark, FunnelPlan>(encoded, DEFAULT_PLAN);
    const entries = plan.entries;
    if (entries.length === 0) return 'Funnel chart with no data.';

    const valueScale = encoded.scales.y;
    const format = (value: number): string =>
      valueScale === undefined ? formatNumber(value, plan.valueFormat) : valueScale.format(value);

    const first = entries[0];
    const last = entries[entries.length - 1];
    const subject = subjectPhrase(plan.measure, plan.category);

    // The steepest *fall*. A funnel that only ever rises has no drop-off to
    // name, and saying "largest drop-off: +12 %" would be worse than silence.
    let steepest: FunnelEntry | undefined;
    for (const entry of entries) {
      if (entry.change === undefined || entry.change >= 0) continue;
      if (steepest?.change === undefined || entry.change < steepest.change) steepest = entry;
    }

    const range =
      first === undefined || last === undefined || entries.length < 2
        ? undefined
        : `${format(first.value)} at ${first.label} ${last.value > first.value ? 'rises' : 'falls'} to ${format(last.value)} at ${last.label}${last.share === undefined ? '' : `, ${formatNumber(last.share, SHARE_DRAWN)} of the first stage`}`;

    return composeDescription({
      chartKind: 'Funnel chart',
      ...(subject === undefined ? {} : { subject }),
      scope: countPhrase(entries.length, 'stage'),
      ...(range === undefined ? {} : { range }),
      ...(steepest?.change === undefined
        ? {}
        : {
            extreme: `Steepest fall at ${steepest.label}, ${changeText(steepest.change, SHARE_DRAWN)}`,
          }),
    });
  },
};

/** A well-formed empty result, for a block whose stages resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  series: readonly SeriesDescriptor[],
  options: ReturnType<typeof readAttrs>,
): FunnelEncodeResult {
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
    state: {
      ...DEFAULT_PLAN,
      entries: [],
      orientation: options.orientation,
      shape: options.shape,
      showDropoff: options.showDropoff,
    },
  };
}

export default funnelChart;
