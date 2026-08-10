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

import type { LegendEntry, LegendModel } from '../types/encode.js';
import type { LayoutContext, Rect, Size } from '../types/layout.js';
import type { CircleNode, LineNode, RectNode, SceneNode } from '../types/scene.js';
import { foldLegendEntries } from '../encode/legend.js';
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

/** One placed legend item. */
export interface LegendItemGeometry {
  entry: LegendEntry;
  /** Offset from the legend box's origin. */
  x: number;
  y: number;
  width: number;
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
 * Emit legend nodes.
 *
 * @param box - where the legend box was placed, in scene coordinates
 */
export function renderLegend(geometry: LegendGeometry, box: Rect, ctx: LayoutContext): SceneNode[] {
  if (geometry.inline || geometry.items.length === 0) return [];
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
