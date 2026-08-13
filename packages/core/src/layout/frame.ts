/**
 * The block frame (SPEC 8.1, 18 stage 6).
 *
 * Core reserves space for the title, subtitle and caption, places the legend,
 * measures the axes, applies `padding`, and hands the chart type a bare
 * {@link Rect}. That division is the registry contract: *if two chart types
 * would have to draw it identically, core draws it.*
 *
 * The measurement is genuinely circular — how much room the tick labels need
 * depends on how many ticks there are, which depends on how much room the plot
 * has — so it is solved by iteration with a fixed bound. Two passes converge for
 * every realistic axis; a third is allowed and the loop then stops whether or
 * not it has settled, because a layout that sometimes runs four passes is a
 * layout whose output depends on how the floats fell (SPEC 24.3).
 */

import type { BlockAttrs } from '../types/attrs.js';
import type { AxisModel, LegendModel } from '../types/encode.js';
import type { Insets, LayoutContext, Rect, ReservedFrames, Size } from '../types/layout.js';
import type { SceneNode } from '../types/scene.js';
import type { Reporter } from '../encode/report.js';
import type { AxisGeometry } from './axis.js';
import { measureAxis } from './axis.js';
import { DEFAULT_PADDING, insetRect, resolvePadding } from './dimension.js';
import type { LegendGeometry } from './legend.js';
import { LEGEND_GAP, measureLegend } from './legend.js';
import { CLS } from './ids.js';
import { ellipsize, lineHeight, makeText, solid, themeFont, wrapText } from './text.js';

/** Gap between the title block and whatever is under it. */
export const TITLE_GAP = 6;
/** Gap between the plot and the caption. */
export const CAPTION_GAP = 8;
/** Below this width a block uses its compact variant (SPEC 8.1). */
export const DEFAULT_MIN_WIDTH = 240;
/** The narrowest plot worth drawing; below it, layout gives up on axes. */
const MIN_PLOT_EXTENT = 24;
/** Bound on the axis-measurement iteration. */
const MAX_FRAME_PASSES = 3;

/** What {@link computeFrame} needs. */
export interface FrameRequest {
  size: Size;
  attrs: BlockAttrs;
  axes: readonly AxisModel[];
  legend: LegendModel | undefined;
  /** Space the chart type asked for inside the frame. */
  reserved?: { top?: number; right?: number; bottom?: number; left?: number } | undefined;
  /** The type's minimum useful width. @defaultValue 240 */
  minWidth?: number | undefined;
  /**
   * Map an axis model onto a candidate plot rectangle (see
   * `scale/rerange.ts`).
   *
   * Tick *positions* are what the collision resolver measures, and a position is
   * meaningless until the scale knows the frame — but the frame is not known
   * until the labels are measured. The iteration below breaks that circle by
   * re-ranging on every pass, so pass *n*'s labels are measured against pass
   * *n−1*'s frame and the two converge.
   */
  rerange?: ((model: AxisModel, plot: Rect) => AxisModel) | undefined;
  ctx: LayoutContext;
  reporter: Reporter;
}

/** The computed frame and everything measured on the way to it. */
export interface BlockFrame {
  /** The whole block. */
  outer: Rect;
  /** Inside `padding`. */
  content: Rect;
  /** The plot rectangle handed to the chart type. */
  plot: Rect;
  /** Where {@link FrameRequest.reserved} landed, for the type that asked. */
  reservedFrames: ReservedFrames | undefined;
  /** Where the legend box was placed, when there is one. */
  legendBox: Rect | undefined;
  legend: LegendGeometry | undefined;
  axes: AxisGeometry[];
  /** Title, subtitle and caption nodes, ready to append. */
  chrome: SceneNode[];
  /** `true` when the block fell below the type's minimum useful width. */
  compact: boolean;
  padding: Insets;
}

/**
 * Compute the frame.
 *
 * Never throws and never returns a negative rectangle: a container measured at
 * zero yields an empty plot and `MDV5001`, and the caller still emits a valid
 * scene (SPEC 14.1 principle 1).
 */
export function computeFrame(request: FrameRequest): BlockFrame {
  const { ctx, attrs, size } = request;
  const theme = ctx.theme;

  const outer: Rect = {
    x: 0,
    y: 0,
    width: Math.max(0, size.width),
    height: Math.max(0, size.height),
  };
  const padding = resolvePadding(
    attrs.padding,
    { reference: outer.width, rootFontSize: 16, fontSize: theme.type.fontSize },
    request.reporter,
  );
  const content = insetRect(outer, padding);

  const compact = outer.width < (request.minWidth ?? DEFAULT_MIN_WIDTH);

  // ── Title, subtitle, caption ────────────────────────────────────────────────
  const chrome: SceneNode[] = [];
  let top = content.y;
  let bottom = content.y + content.height;

  const titleFont = themeFont(theme, 'title');
  const subtitleFont = themeFont(theme, 'subtitle');
  const captionFont = themeFont(theme, 'caption');

  if (typeof attrs.title === 'string' && attrs.title !== '') {
    const height = lineHeight(titleFont, ctx.metrics);
    const text = ellipsize(attrs.title, titleFont, ctx.metrics, content.width);
    if (text !== '') {
      chrome.push(
        makeText(
          {
            x: content.x,
            y: top,
            text,
            font: titleFont,
            fill: solid(theme.tokens['text-primary']),
            anchor: 'start',
            baseline: 'top',
            cls: CLS.title,
            id: ctx.ids.next('title'),
          },
          ctx.metrics,
        ),
      );
    }
    top += height + 2;
  }

  if (typeof attrs.subtitle === 'string' && attrs.subtitle !== '') {
    const height = lineHeight(subtitleFont, ctx.metrics);
    const text = ellipsize(attrs.subtitle, subtitleFont, ctx.metrics, content.width);
    if (text !== '') {
      chrome.push(
        makeText(
          {
            x: content.x,
            y: top,
            text,
            font: subtitleFont,
            fill: solid(theme.tokens['text-secondary']),
            anchor: 'start',
            baseline: 'top',
            cls: CLS.subtitle,
            id: ctx.ids.next('subtitle'),
          },
          ctx.metrics,
        ),
      );
    }
    top += height;
  }
  if (top > content.y) top += TITLE_GAP;

  if (typeof attrs.caption === 'string' && attrs.caption !== '') {
    const height = lineHeight(captionFont, ctx.metrics);
    const lines = wrapText(attrs.caption, captionFont, ctx.metrics, content.width, 3);
    const block = lines.length * height;
    const start = bottom - block;
    lines.forEach((line, index) => {
      chrome.push(
        makeText(
          {
            x: content.x,
            y: start + index * height,
            text: line,
            font: captionFont,
            fill: solid(theme.tokens['text-secondary']),
            anchor: 'start',
            baseline: 'top',
            cls: CLS.caption,
            id: ctx.ids.next('caption'),
          },
          ctx.metrics,
        ),
      );
    });
    bottom -= block + CAPTION_GAP;
  }

  const body: Rect = {
    x: content.x,
    y: top,
    width: content.width,
    height: Math.max(0, bottom - top),
  };

  // ── Legend ──────────────────────────────────────────────────────────────────
  let legend: LegendGeometry | undefined;
  let legendBox: Rect | undefined;
  let afterLegend = body;

  if (request.legend !== undefined) {
    // SPEC 8.1: below the type's minimum useful width, drop the legend below the
    // plot — a side legend on a 200 px block leaves no plot at all.
    const model: LegendModel =
      compact && (request.legend.position === 'left' || request.legend.position === 'right')
        ? { ...request.legend, position: 'bottom', orient: 'horizontal' }
        : request.legend;

    const side = model.position;
    const available: Size =
      side === 'left' || side === 'right'
        ? { width: Math.max(0, Math.min(body.width / 3, body.width)), height: body.height }
        : { width: body.width, height: body.height };

    legend = measureLegend(model, available, ctx);
    if (!legend.inline && legend.size.width > 0 && legend.size.height > 0) {
      const placed = placeLegend(body, legend.size, side);
      legendBox = placed.box;
      afterLegend = placed.remaining;
    }
  }

  // ── Chart-reserved space ────────────────────────────────────────────────────
  const reserved = request.reserved;
  const reservedInsets: Insets | undefined =
    reserved === undefined
      ? undefined
      : {
          top: Math.max(0, reserved.top ?? 0),
          right: Math.max(0, reserved.right ?? 0),
          bottom: Math.max(0, reserved.bottom ?? 0),
          left: Math.max(0, reserved.left ?? 0),
        };
  const afterReserved: Rect =
    reservedInsets === undefined ? afterLegend : insetRect(afterLegend, reservedInsets);
  const reservedFrames =
    reservedInsets && reservedBands(afterLegend, afterReserved, reservedInsets);

  // ── Axes, by iteration ──────────────────────────────────────────────────────
  let plot = afterReserved;
  let axes: AxisGeometry[] = [];

  const rerange = request.rerange;
  for (let pass = 0; pass < MAX_FRAME_PASSES; ++pass) {
    const models =
      rerange === undefined ? request.axes : request.axes.map((model) => rerange(model, plot));
    axes = measureAxes(models, plot, outer, ctx);
    const insets = axisInsets(axes);
    const next = insetRect(afterReserved, insets);
    const settled =
      Math.abs(next.width - plot.width) < 0.5 && Math.abs(next.height - plot.height) < 0.5;
    plot = next;
    if (settled) break;
  }

  // A plot narrower than a couple of tick marks is not a plot. Keep the chrome,
  // hand the chart type an empty frame, and let the caller report MDV5001.
  if (plot.width < MIN_PLOT_EXTENT || plot.height < MIN_PLOT_EXTENT) {
    plot = { ...plot, width: Math.max(0, plot.width), height: Math.max(0, plot.height) };
  }

  return {
    outer,
    content,
    plot,
    reservedFrames,
    legendBox,
    legend,
    axes,
    chrome,
    compact,
    padding: padding ?? DEFAULT_PADDING,
  };
}

/**
 * The four bands between the box a reservation was taken out of and what was
 * left of it.
 *
 * Each band spans the *outer* box along its own edge, so the corners belong to
 * the vertical bands — a chart reserving both `bottom` and `left` gets a full
 * width volume pane and a left gutter that stops above it. Zero-width edges are
 * omitted rather than returned empty, so `frames.bottom !== undefined` is a
 * usable test for "I asked and I got it".
 */
function reservedBands(outer: Rect, inner: Rect, insets: Insets): ReservedFrames {
  const bands: ReservedFrames = {};
  if (insets.top > 0) {
    bands.top = { x: outer.x, y: outer.y, width: outer.width, height: insets.top };
  }
  if (insets.bottom > 0) {
    const y = inner.y + inner.height;
    bands.bottom = { x: outer.x, y, width: outer.width, height: insets.bottom };
  }
  if (insets.left > 0) {
    bands.left = { x: outer.x, y: inner.y, width: insets.left, height: inner.height };
  }
  if (insets.right > 0) {
    bands.right = {
      x: inner.x + inner.width,
      y: inner.y,
      width: insets.right,
      height: inner.height,
    };
  }
  return bands;
}

/** Measure every axis against a candidate plot rectangle. */
function measureAxes(
  models: readonly AxisModel[],
  plot: Rect,
  outer: Rect,
  ctx: LayoutContext,
): AxisGeometry[] {
  return models.map((model) => {
    const horizontal = model.position === 'top' || model.position === 'bottom';
    const along = horizontal ? plot.width : plot.height;
    const perpendicularBudget = horizontal ? outer.height : outer.width;
    return measureAxis(model, Math.max(0, along), Math.max(0, perpendicularBudget), ctx);
  });
}

/** Total space the axes take on each edge. Axes on one edge do not stack. */
export function axisInsets(axes: readonly AxisGeometry[]): Insets {
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const axis of axes) {
    const side = axis.model.position;
    if (axis.extent > insets[side]) insets[side] = axis.extent;
  }
  return insets;
}

/** Carve a legend box out of one edge of `body`. */
function placeLegend(
  body: Rect,
  size: Size,
  position: LegendModel['position'],
): { box: Rect; remaining: Rect } {
  switch (position) {
    case 'top':
      return {
        box: { x: body.x, y: body.y, width: body.width, height: size.height },
        remaining: {
          x: body.x,
          y: body.y + size.height + LEGEND_GAP,
          width: body.width,
          height: Math.max(0, body.height - size.height - LEGEND_GAP),
        },
      };
    case 'bottom':
      return {
        box: {
          x: body.x,
          y: body.y + body.height - size.height,
          width: body.width,
          height: size.height,
        },
        remaining: {
          x: body.x,
          y: body.y,
          width: body.width,
          height: Math.max(0, body.height - size.height - LEGEND_GAP),
        },
      };
    case 'left':
      return {
        box: { x: body.x, y: body.y, width: size.width, height: body.height },
        remaining: {
          x: body.x + size.width + LEGEND_GAP,
          y: body.y,
          width: Math.max(0, body.width - size.width - LEGEND_GAP),
          height: body.height,
        },
      };
    case 'right':
    case 'inline':
    default:
      return {
        box: {
          x: body.x + body.width - size.width,
          y: body.y,
          width: size.width,
          height: body.height,
        },
        remaining: {
          x: body.x,
          y: body.y,
          width: Math.max(0, body.width - size.width - LEGEND_GAP),
          height: body.height,
        },
      };
  }
}
