/**
 * Legend measurement, placement and rendering (SPEC 7.4, 11.5).
 *
 * Core owns all three. A chart type says *what* the legend contains
 * ({@link LegendModel}); where it goes, how it wraps and where the `maxItems`
 * fold falls are decided here so every block's legend behaves the same.
 *
 * Two details are normative and easy to get wrong:
 *
 * - **Symbols mirror the mark** — a rect for bars, areas and cells, a short line
 *   for lines, the point shape for scatter. A square next to a line chart makes
 *   the reader translate.
 * - **Text never wears the data colour** (SPEC 11.5). The swatch carries the
 *   identity; the label is a text token. `inline` is the one placement with no
 *   box at all: identity comes from direct labels on the marks themselves.
 */

import type { LegendEntry, LegendModel, LegendRamp } from '../types/encode.js';
import type { LayoutContext, Rect, Size } from '../types/layout.js';
import type { CircleNode, Font, LineNode, RectNode, SceneNode } from '../types/scene.js';
import type { ColorString } from '../types/theme.js';
import { foldLegendEntries } from '../encode/legend.js';
import { sampleRamp } from '../scale/color.js';
import { CLS } from './ids.js';
import { ellipsize, lineHeight, makeText, measureWidth, solid, themeFont } from './text.js';

/** Side of a legend swatch, in px. */
export const SWATCH_SIZE = 10;
/** Gap between a swatch and its label. */
export const SWATCH_GAP = 6;
/** Gap between two legend items on one row. */
export const ITEM_GAP = 16;
/** Gap between two legend rows. */
export const ROW_GAP = 4;
/** Gap between the legend box and the plot. */
export const LEGEND_GAP = 8;
/** Thickness of a continuous ramp, across its short axis (SPEC 8.9). */
export const RAMP_THICKNESS = 10;
/** The length a ramp asks for when the box allows it. */
export const RAMP_LENGTH = 160;
/** Clear space required between two ramp tick labels. */
const RAMP_LABEL_GAP = 8;
/**
 * Bands a *continuous* ramp is drawn with.
 *
 * A gradient `Def` would be smoother, but it would have to be registered on the
 * scene and honoured by all four backends; bands are exact in every one of them
 * and byte-identical between runs (SPEC 24.3). At the default 160 px length each
 * band is 5 px, which reads as a ramp rather than as classes.
 */
const RAMP_BANDS = 32;

/** One placed legend item. */
export interface LegendItemGeometry {
  entry: LegendEntry;
  /** Offset from the legend box's origin. */
  x: number;
  y: number;
  width: number;
}

/** One drawn band of a ramp, positioned along it. */
export interface LegendRampBand {
  /** Distance from the ramp's **low** end, whichever way it is drawn. */
  offset: number;
  length: number;
  color: ColorString;
}

/** One tick of a ramp that survived collision removal. */
export interface LegendRampTick {
  /** Distance from the ramp's **low** end. */
  offset: number;
  text: string;
  /** Ellipsis budget, in px. */
  width: number;
  /** How the text sits about {@link offset} along the ramp. */
  align: 'start' | 'middle' | 'end';
}

/** A measured ramp, in ramp-space: low end at offset 0, whichever way it draws. */
export interface LegendRampGeometry {
  ramp: LegendRamp;
  bands: LegendRampBand[];
  ticks: LegendRampTick[];
  /** Along-axis size of the bar. */
  length: number;
  thickness: number;
  /** `true` when the ramp runs bottom (low) to top (high). */
  vertical: boolean;
}

/** A measured legend, ready to place. */
export interface LegendGeometry {
  model: LegendModel;
  items: LegendItemGeometry[];
  /** Entries absorbed by the `maxItems` fold (`MDV3062`). */
  folded: number;
  /** Box size, excluding {@link LEGEND_GAP}. */
  size: Size;
  /** `true` for `inline`: identity comes from direct labels, so no box. */
  inline: boolean;
  titleHeight: number;
  /** Set instead of {@link items} when the model carries a ramp (SPEC 8.9). */
  ramp?: LegendRampGeometry;
}

/**
 * Measure a legend against the space available.
 *
 * @param available - the box the legend may occupy. For top/bottom that is the
 * content width; for left/right it is the content height, and the width is
 * whatever the widest label needs, capped at a third of the block.
 */
export function measureLegend(
  model: LegendModel,
  available: Size,
  ctx: LayoutContext,
): LegendGeometry {
  const font = themeFont(ctx.theme, 'legend');
  const rowHeight = Math.max(SWATCH_SIZE, lineHeight(font, ctx.metrics));

  if (model.position === 'inline') {
    return {
      model,
      items: [],
      folded: 0,
      size: { width: 0, height: 0 },
      inline: true,
      titleHeight: 0,
    };
  }

  const folded = foldLegendEntries(
    model.entries,
    model.maxItems ?? 12,
    ctx.theme.tokens['text-muted'],
  );

  const titleText = model.title === false ? '' : (model.title ?? '');
  const titleHeight = titleText === '' ? 0 : rowHeight + ROW_GAP;

  const vertical =
    model.orient === 'vertical' || model.position === 'left' || model.position === 'right';

  // A continuous scale is read off a bar, not off a list of swatches (SPEC 8.9).
  // `ramp` wins when both are set: the marks would otherwise be identified twice.
  if (model.ramp !== undefined && model.ramp.stops.length > 0) {
    return measureRamp(model, model.ramp, available, ctx, {
      font,
      vertical,
      titleHeight,
      rowHeight,
    });
  }

  const maxWidth = vertical
    ? Math.max(60, Math.min(available.width, Math.floor(available.width)))
    : available.width;

  const measured = folded.entries.map((entry) => {
    const labelWidth = measureWidth(entry.label, font, ctx.metrics);
    return { entry, width: SWATCH_SIZE + SWATCH_GAP + labelWidth };
  });

  const items: LegendItemGeometry[] = [];
  let boxWidth = 0;
  let boxHeight = titleHeight;

  if (vertical) {
    let y = titleHeight;
    for (const { entry, width } of measured) {
      items.push({ entry, x: 0, y, width: Math.min(width, maxWidth) });
      boxWidth = Math.max(boxWidth, Math.min(width, maxWidth));
      y += rowHeight + ROW_GAP;
    }
    boxHeight = y - (items.length > 0 ? ROW_GAP : 0);
  } else {
    const columns = model.columns;
    let x = 0;
    let y = titleHeight;
    let rowMaxWidth = 0;
    let inRow = 0;
    for (const { entry, width } of measured) {
      const wraps =
        (columns !== undefined && inRow >= columns) ||
        (columns === undefined && inRow > 0 && x + width > maxWidth);
      if (wraps) {
        rowMaxWidth = Math.max(rowMaxWidth, x - ITEM_GAP);
        x = 0;
        y += rowHeight + ROW_GAP;
        inRow = 0;
      }
      items.push({ entry, x, y, width });
      x += width + ITEM_GAP;
      ++inRow;
    }
    rowMaxWidth = Math.max(rowMaxWidth, x - ITEM_GAP);
    boxWidth = Math.max(0, Math.min(maxWidth, rowMaxWidth));
    boxHeight = y + rowHeight;
  }

  return {
    model,
    items,
    folded: folded.folded,
    size: { width: boxWidth, height: boxHeight },
    inline: false,
    titleHeight,
  };
}

/**
 * Measure a continuous or class ramp (SPEC 8.9).
 *
 * The bar takes the space it is offered up to {@link RAMP_LENGTH}; ticks are
 * placed along it in ramp-space — offset 0 is always the **low** end — and any
 * that would collide with the one before are dropped. The ends survive by
 * construction: the low end is the first tick considered and the high end is
 * never dropped, because a ramp whose ends are unlabelled says nothing at all.
 */
function measureRamp(
  model: LegendModel,
  ramp: LegendRamp,
  available: Size,
  ctx: LayoutContext,
  opts: { font: Font; vertical: boolean; titleHeight: number; rowHeight: number },
): LegendGeometry {
  const { font, vertical, titleHeight, rowHeight } = opts;
  const span = vertical ? available.height - titleHeight : available.width;
  const length = Math.max(0, Math.min(Math.floor(span), RAMP_LENGTH));

  const bands = rampBands(ramp, length);
  const ticks = cullTicks(
    (ramp.labels ?? []).map((label) => {
      const textWidth = measureWidth(label.text, font, ctx.metrics);
      return {
        at: Math.max(0, Math.min(1, label.at)),
        text: label.text,
        textWidth,
        // Along the bar: labels stack by row height when the bar is upright and
        // by their own width when it lies flat.
        size: vertical ? rowHeight : textWidth,
      };
    }),
    length,
    vertical,
  );

  const labelWidth = vertical
    ? ticks.reduce((widest, tick) => Math.max(widest, tick.width), 0)
    : 0;
  const size: Size = vertical
    ? {
        width: Math.min(
          available.width,
          RAMP_THICKNESS + (labelWidth > 0 ? SWATCH_GAP + labelWidth : 0),
        ),
        height: titleHeight + length,
      }
    : { width: Math.max(length, 0), height: titleHeight + RAMP_THICKNESS + ROW_GAP + rowHeight };

  return {
    model,
    items: [],
    folded: 0,
    size: length > 0 ? size : { width: 0, height: 0 },
    inline: false,
    titleHeight,
    ramp: { ramp, bands, ticks, length, thickness: RAMP_THICKNESS, vertical },
  };
}

/**
 * Cut a ramp into drawn bands, low end first.
 *
 * Band edges are rounded to whole pixels *and shared* between neighbours, so the
 * bar tiles exactly however the length divides — no seams, no overlap, and the
 * same bytes on every run (SPEC 24.3).
 */
function rampBands(ramp: LegendRamp, length: number): LegendRampBand[] {
  if (length <= 0 || ramp.stops.length === 0) return [];
  const discrete = ramp.discrete === true;
  const count = discrete ? ramp.stops.length : RAMP_BANDS;
  const bands: LegendRampBand[] = [];
  for (let i = 0; i < count; ++i) {
    const offset = Math.round((length * i) / count);
    const end = Math.round((length * (i + 1)) / count);
    const color = discrete
      ? (ramp.stops[i] as ColorString)
      : sampleRamp(ramp.stops, count === 1 ? 0 : i / (count - 1));
    if (end > offset) bands.push({ offset, length: end - offset, color });
  }
  return bands;
}

/**
 * Drop ramp ticks that would collide, keeping both ends.
 *
 * Ticks arrive in ramp order. The first is kept, then each next one is kept only
 * if it clears the last kept by `gap`. The high end is forced in at the finish,
 * evicting whatever it lands on — except the low end, which stays even when the
 * two overlap, in which case both are given half the bar to ellipsize into. A
 * ramp labelled at one end only would be read as a scale it is not.
 */
function cullTicks(
  input: readonly RampTickInput[],
  length: number,
  vertical: boolean,
): LegendRampTick[] {
  if (length <= 0 || input.length === 0) return [];
  const gap = vertical ? RAMP_LABEL_GAP / 2 : RAMP_LABEL_GAP;
  const sorted = [...input].sort((a, b) => a.at - b.at);
  const last = sorted[sorted.length - 1] as RampTickInput;

  /** Where a tick's own extent begins, with the two ends turned inward. */
  const start = (tick: RampTickInput): number =>
    tick.at <= 0
      ? 0
      : tick.at >= 1
        ? length - tick.size
        : tick.at * length - tick.size / 2;
  const clears = (before: RampTickInput, after: RampTickInput): boolean =>
    start(before) + before.size + gap <= start(after);

  const kept: RampTickInput[] = [];
  for (const tick of sorted) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && !clears(previous, tick)) continue;
    kept.push(tick);
  }

  if (kept[kept.length - 1] !== last) {
    while (kept.length > 1 && !clears(kept[kept.length - 1] as RampTickInput, last)) kept.pop();
    kept.push(last);
  }

  // Both ends left, and colliding: give each half the bar rather than drop one.
  const squeezed =
    !vertical && kept.length === 2 && !clears(kept[0] as RampTickInput, kept[1] as RampTickInput);
  const budget = Math.max(0, Math.floor((length - gap) / 2));

  return kept.map((tick) => ({
    offset: tick.at * length,
    text: tick.text,
    width: vertical ? tick.textWidth : squeezed ? budget : Math.min(tick.textWidth, length),
    align: tick.at <= 0 ? 'start' : tick.at >= 1 ? 'end' : 'middle',
  }));
}

/** A ramp label with what measurement needs to know about it. */
interface RampTickInput {
  at: number;
  text: string;
  /** The label's own width, whichever way the bar runs. */
  textWidth: number;
  /** The label's extent *along* the bar. */
  size: number;
}

/**
 * Emit legend nodes.
 *
 * @param box - where the legend box was placed, in scene coordinates
 */
export function renderLegend(geometry: LegendGeometry, box: Rect, ctx: LayoutContext): SceneNode[] {
  if (geometry.inline) return [];
  if (geometry.ramp === undefined && geometry.items.length === 0) return [];
  const font = themeFont(ctx.theme, 'legend');
  const rowHeight = Math.max(SWATCH_SIZE, lineHeight(font, ctx.metrics));
  const labelFill = solid(ctx.theme.tokens['text-secondary']);
  const nodes: SceneNode[] = [];

  const titleText = geometry.model.title === false ? '' : (geometry.model.title ?? '');
  if (titleText !== '') {
    nodes.push(
      makeText(
        {
          x: box.x,
          y: box.y + rowHeight / 2,
          text: titleText,
          font: { ...font, weight: 600 },
          fill: solid(ctx.theme.tokens['text-secondary']),
          anchor: 'start',
          baseline: 'middle',
          cls: CLS.legendTitle,
        },
        ctx.metrics,
      ),
    );
  }

  if (geometry.ramp !== undefined) {
    nodes.push(...rampNodes(geometry.ramp, box, geometry.titleHeight, rowHeight, ctx));
    return [
      {
        kind: 'group',
        cls: CLS.legend,
        id: ctx.ids.next('legend'),
        role: 'group',
        label: titleText === '' ? 'Colour scale' : titleText,
        children: nodes,
      },
    ];
  }

  for (const item of geometry.items) {
    const x = box.x + item.x;
    const centerY = box.y + item.y + rowHeight / 2;
    const children: SceneNode[] = [];

    children.push(...symbolNodes(item.entry, x, centerY, ctx));

    const labelX = x + SWATCH_SIZE + SWATCH_GAP;
    const labelBudget = Math.max(0, item.width - (SWATCH_SIZE + SWATCH_GAP));
    const label = ellipsize(item.entry.label, font, ctx.metrics, labelBudget);
    children.push(
      makeText(
        {
          x: labelX,
          y: centerY,
          text: label,
          font,
          fill: labelFill,
          anchor: 'start',
          baseline: 'middle',
          cls: CLS.legendLabel,
        },
        ctx.metrics,
      ),
    );

    nodes.push({
      kind: 'group',
      cls: CLS.legendItem,
      id: ctx.ids.next('legend'),
      role: 'listitem',
      label: item.entry.label,
      children,
    });
  }

  return [
    {
      kind: 'group',
      cls: CLS.legend,
      id: ctx.ids.next('legend'),
      role: 'list',
      children: nodes,
    },
  ];
}

/**
 * The bar, its outline and its surviving ticks (SPEC 8.9).
 *
 * Ramp space runs low → high; upright bars put the low end at the **bottom**,
 * which is the direction every colour scale in the spec is read in. The outline
 * is chrome, not data: without it a pale low end dissolves into the surface.
 */
function rampNodes(
  geometry: LegendRampGeometry,
  box: Rect,
  titleHeight: number,
  rowHeight: number,
  ctx: LayoutContext,
): SceneNode[] {
  const { bands, ticks, length, thickness, vertical } = geometry;
  if (length <= 0 || bands.length === 0) return [];
  const font = themeFont(ctx.theme, 'legend');
  const labelFill = solid(ctx.theme.tokens['text-secondary']);
  const top = box.y + titleHeight;
  const nodes: SceneNode[] = [];

  for (const band of bands) {
    nodes.push({
      kind: 'rect',
      cls: CLS.legendRampBand,
      x: vertical ? box.x : box.x + band.offset,
      y: vertical ? top + (length - band.offset - band.length) : top,
      w: vertical ? thickness : band.length,
      h: vertical ? band.length : thickness,
      fill: solid(band.color),
    });
  }

  nodes.push({
    kind: 'rect',
    cls: CLS.legendRamp,
    x: box.x,
    y: top,
    w: vertical ? thickness : length,
    h: vertical ? length : thickness,
    stroke: { paint: solid(ctx.theme.tokens.border), width: ctx.theme.metrics.hairline },
  });

  for (const tick of ticks) {
    const text = ellipsize(tick.text, font, ctx.metrics, tick.width);
    if (text === '') continue;
    if (vertical) {
      const centre = top + (length - tick.offset);
      nodes.push(
        makeText(
          {
            x: box.x + thickness + SWATCH_GAP,
            y: Math.max(top + rowHeight / 2, Math.min(top + length - rowHeight / 2, centre)),
            text,
            font,
            fill: labelFill,
            anchor: 'start',
            baseline: 'middle',
            cls: CLS.legendRampLabel,
          },
          ctx.metrics,
        ),
      );
      continue;
    }
    nodes.push(
      makeText(
        {
          x: box.x + tick.offset,
          y: top + thickness + ROW_GAP + rowHeight / 2,
          text,
          font,
          fill: labelFill,
          anchor: tick.align,
          baseline: 'middle',
          cls: CLS.legendRampLabel,
        },
        ctx.metrics,
      ),
    );
  }

  return nodes;
}

/** The swatch for one entry: it mirrors the mark (SPEC 7.4). */
function symbolNodes(
  entry: LegendEntry,
  x: number,
  centerY: number,
  ctx: LayoutContext,
): SceneNode[] {
  const fill =
    entry.patternDef === undefined
      ? solid(entry.color)
      : { kind: 'pattern' as const, def: entry.patternDef, background: entry.color };

  switch (entry.symbol) {
    case 'line': {
      // A short stroke, not a filled box: SPEC 7.5 says series keys are strokes.
      const line: LineNode = {
        kind: 'line',
        x1: x,
        y1: centerY,
        x2: x + SWATCH_SIZE,
        y2: centerY,
        stroke: {
          paint: solid(entry.color),
          width: ctx.theme.marks.line.width,
          cap: ctx.theme.marks.line.cap,
        },
        cls: CLS.legendSwatch,
      };
      const dot: CircleNode = {
        kind: 'circle',
        cx: x + SWATCH_SIZE / 2,
        cy: centerY,
        r: ctx.theme.marks.marker.minDiameter / 2 - 1,
        fill: solid(entry.color),
        cls: CLS.legendSwatch,
      };
      return [line, dot];
    }
    case 'point': {
      const dot: CircleNode = {
        kind: 'circle',
        cx: x + SWATCH_SIZE / 2,
        cy: centerY,
        r: ctx.theme.marks.marker.minDiameter / 2,
        fill,
        cls: CLS.legendSwatch,
      };
      return [dot];
    }
    case 'area': {
      const wash: RectNode = {
        kind: 'rect',
        x,
        y: centerY - SWATCH_SIZE / 2,
        w: SWATCH_SIZE,
        h: SWATCH_SIZE,
        r: 2,
        fill: solid(entry.color, ctx.theme.marks.area.fillOpacity * 3),
        cls: CLS.legendSwatch,
      };
      const cap: LineNode = {
        kind: 'line',
        x1: x,
        y1: centerY - SWATCH_SIZE / 2,
        x2: x + SWATCH_SIZE,
        y2: centerY - SWATCH_SIZE / 2,
        stroke: { paint: solid(entry.color), width: ctx.theme.marks.line.width },
        cls: CLS.legendSwatch,
      };
      return [wash, cap];
    }
    case 'rect':
    default: {
      const swatch: RectNode = {
        kind: 'rect',
        x,
        y: centerY - SWATCH_SIZE / 2,
        w: SWATCH_SIZE,
        h: SWATCH_SIZE,
        r: 2,
        fill,
        cls: CLS.legendSwatch,
      };
      return [swatch];
    }
  }
}
