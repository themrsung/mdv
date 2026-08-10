/**
 * Axis geometry: the tick ladder, the labels, the collision fallbacks and the
 * title (SPEC 7.3, 11.4, 11.5).
 *
 * **Core draws every axis**, for every chart type, from this one module. That is
 * the whole reason the registry hands core an {@link AxisModel} rather than
 * letting a chart type emit its own ticks: two types with the same scale must
 * produce axes that agree to the pixel, and a plugin type must get the same
 * collision handling as `bar` without writing any of it.
 *
 * The collision policy, in order, is normative (SPEC 7.3 `tickRotate`, SPEC 11.5):
 *
 * 1. horizontal labels, if they fit with a gap between them;
 * 2. rotate to **−45°** — and only when they would otherwise collide;
 * 3. thin the ladder by an integer stride, keeping the first label;
 * 4. drop the labels entirely.
 *
 * Steps 3 and 4 emit `MDV5011` and point at the table view. **Nothing is ever
 * clipped**: cropping the first characters of a label is worse than not drawing
 * it (SPEC 11.5).
 */

import type { AxisModel, Scale, ScaleInput } from '../types/encode.js';
import type { LayoutContext, Rect } from '../types/layout.js';
import type { Font, LineNode, SceneNode, TextNode } from '../types/scene.js';
import { bandCenter } from '../scale/band.js';
import { CLS } from './ids.js';
import { lineHeight, makeText, measureWidth, rotatedHeight, solid, themeFont } from './text.js';

/** Length of a tick mark, outside the plot frame. */
export const TICK_LENGTH = 4;
/** Gap between a tick mark and its label. */
export const TICK_LABEL_GAP = 4;
/** Gap between the label band and the axis title. */
export const AXIS_TITLE_GAP = 6;
/** Minimum clear space between two horizontal tick labels. */
export const MIN_LABEL_GAP_X = 8;
/** Minimum clear space between two stacked tick labels. */
export const MIN_LABEL_GAP_Y = 4;
/** The one rotation the spec permits when labels collide. */
export const COLLISION_ROTATION = -45;
/** A rotated label band may not eat more than this fraction of the block. */
const MAX_ROTATED_FRACTION = 0.4;

/** One resolved tick: a domain value, its position, and its text. */
export interface AxisTick {
  value: ScaleInput;
  /** Position along the axis, in scene coordinates. */
  position: number;
  label: string;
  /** Measured label width, so the caller never re-measures. */
  width: number;
}

/** Everything layout needs to know about one axis before the frame is fixed. */
export interface AxisGeometry {
  model: AxisModel;
  ticks: AxisTick[];
  /** Rotation actually applied to the tick labels: `0` or `−45`. */
  rotate: number;
  /** Perpendicular space the axis needs outside the plot frame. */
  extent: number;
  /** `false` when no label could be placed without clipping. */
  showLabels: boolean;
  /** Labels omitted by thinning. Drives `MDV5011`. */
  dropped: number;
  /** The resolved title, or `false`. */
  title: string | false;
  font: Font;
  lineHeight: number;
}

/** `true` for a bottom or top axis. */
function isHorizontal(model: AxisModel): boolean {
  return model.position === 'bottom' || model.position === 'top';
}

/**
 * A tick-count hint from the space available (SPEC 7.3: `ticks` is a hint).
 *
 * Roughly one label per 90 px horizontally and per 44 px vertically — dense
 * enough to read a value off, sparse enough that the ladder stays recessive.
 */
export function tickCountHint(extent: number, horizontal: boolean): number {
  const per = horizontal ? 90 : 44;
  const raw = Math.round(extent / per);
  return Math.max(2, Math.min(horizontal ? 12 : 10, raw));
}

/** Position of a tick value along its scale, band centres included. */
export function tickPosition(scale: Scale, value: ScaleInput): number | undefined {
  if (scale.type === 'band') return bandCenter(scale, String(value));
  return scale.scale(value);
}

/**
 * Measure an axis: choose ticks, format them, resolve collisions, and report the
 * perpendicular space it needs.
 *
 * @param model - the chart type's axis model, already re-ranged onto the frame
 * @param alongExtent - the plot's extent along this axis, in px
 * @param blockExtent - the block's extent perpendicular to the axis; caps how
 * much a rotated label band may consume
 */
export function measureAxis(
  model: AxisModel,
  alongExtent: number,
  blockExtent: number,
  ctx: LayoutContext,
): AxisGeometry {
  const horizontal = isHorizontal(model);
  const font = themeFont(ctx.theme, 'tick');
  const height = lineHeight(font, ctx.metrics);

  // A discrete scale asks for *every* category and lets the collision resolver
  // thin it. The scale can only thin by counting; the resolver knows how wide
  // each label actually is, and it is the one that reports `MDV5011`.
  const discrete = model.scale.type === 'band' || model.scale.type === 'point';
  const hint =
    model.ticks === 'auto'
      ? discrete
        ? Math.max(1, model.scale.domain.length)
        : tickCountHint(alongExtent, horizontal)
      : Math.max(1, model.ticks);
  const raw = model.tickValues ?? model.scale.ticks(hint);

  const ticks: AxisTick[] = [];
  for (const value of raw) {
    const position = tickPosition(model.scale, value);
    if (position === undefined || !Number.isFinite(position)) continue;
    const label = model.scale.format(value);
    ticks.push({ value, position, label, width: measureWidth(label, font, ctx.metrics) });
  }
  // A stable order along the axis keeps the DOM order and the tab order sensible
  // regardless of what order the scale produced them in.
  ticks.sort((a, b) => a.position - b.position);

  const resolution = resolveCollisions(ticks, model, horizontal, height, blockExtent);

  const labelExtent = resolution.showLabels
    ? horizontal
      ? maxRotatedHeight(resolution.ticks, height, resolution.rotate)
      : maxLabelWidth(resolution.ticks)
    : 0;

  const titleText = model.title === false ? false : model.title;
  const titleFont = themeFont(ctx.theme, 'tick');
  const titleExtent =
    titleText === false || titleText === ''
      ? 0
      : AXIS_TITLE_GAP + lineHeight(titleFont, ctx.metrics);

  const extent =
    TICK_LENGTH + (resolution.showLabels ? TICK_LABEL_GAP + labelExtent : 0) + titleExtent;

  return {
    model,
    ticks: resolution.ticks,
    rotate: resolution.rotate,
    extent,
    showLabels: resolution.showLabels,
    dropped: resolution.dropped,
    title: titleText,
    font,
    lineHeight: height,
  };
}

/** Widest label in a tick list. */
function maxLabelWidth(ticks: readonly AxisTick[]): number {
  let max = 0;
  for (const tick of ticks) if (tick.width > max) max = tick.width;
  return max;
}

/** Tallest rotated label box in a tick list. */
function maxRotatedHeight(ticks: readonly AxisTick[], height: number, rotate: number): number {
  if (rotate === 0) return height;
  let max = 0;
  for (const tick of ticks) {
    const boxed = rotatedHeight(tick.width, height, rotate);
    if (boxed > max) max = boxed;
  }
  return max;
}

/** Outcome of the collision cascade. */
interface CollisionResult {
  ticks: AxisTick[];
  rotate: number;
  showLabels: boolean;
  dropped: number;
}

/**
 * Apply the collision cascade.
 *
 * An explicit `tickRotate` from the author is honoured as written and skips the
 * automatic rotation — the spec auto-rotates *only* when labels would collide,
 * which means the author's number is a decision, not a hint.
 */
function resolveCollisions(
  ticks: AxisTick[],
  model: AxisModel,
  horizontal: boolean,
  height: number,
  blockExtent: number,
): CollisionResult {
  if (ticks.length === 0) return { ticks, rotate: 0, showLabels: false, dropped: 0 };

  const authored = model.tickRotate;
  if (authored !== undefined && authored !== 0) {
    const thinned = thinToFit(ticks, horizontal, height, authored);
    return {
      ticks: thinned.ticks,
      rotate: authored,
      showLabels: thinned.ticks.length > 0,
      dropped: thinned.dropped,
    };
  }

  if (fits(ticks, horizontal, height, 0)) {
    return { ticks, rotate: 0, showLabels: true, dropped: 0 };
  }

  if (horizontal) {
    const rotatedBand = maxRotatedHeight(ticks, height, COLLISION_ROTATION);
    if (
      fits(ticks, horizontal, height, COLLISION_ROTATION) &&
      rotatedBand <= blockExtent * MAX_ROTATED_FRACTION
    ) {
      return { ticks, rotate: COLLISION_ROTATION, showLabels: true, dropped: 0 };
    }
  }

  // Thin the ladder. Try upright first; a thinned upright ladder reads better
  // than a dense rotated one, and rotation is a cost the spec only pays to
  // avoid a collision.
  const upright = thinToFit(ticks, horizontal, height, 0);
  if (upright.ticks.length >= 2) {
    return {
      ticks: upright.ticks,
      rotate: 0,
      showLabels: true,
      dropped: upright.dropped,
    };
  }

  if (horizontal) {
    const rotated = thinToFit(ticks, horizontal, height, COLLISION_ROTATION);
    if (
      rotated.ticks.length >= 2 &&
      maxRotatedHeight(rotated.ticks, height, COLLISION_ROTATION) <=
        blockExtent * MAX_ROTATED_FRACTION
    ) {
      return {
        ticks: rotated.ticks,
        rotate: COLLISION_ROTATION,
        showLabels: true,
        dropped: rotated.dropped,
      };
    }
  }

  if (upright.ticks.length === 1) {
    return { ticks: upright.ticks, rotate: 0, showLabels: true, dropped: upright.dropped };
  }

  // Nothing fits without clipping. Draw the ladder, drop the text, and let
  // MDV5011 point the reader at the table view.
  return { ticks, rotate: 0, showLabels: false, dropped: ticks.length };
}

/** `true` when every adjacent pair of labels clears the minimum gap. */
function fits(
  ticks: readonly AxisTick[],
  horizontal: boolean,
  height: number,
  rotate: number,
): boolean {
  if (ticks.length < 2) return true;
  for (let i = 1; i < ticks.length; ++i) {
    const previous = ticks[i - 1] as AxisTick;
    const current = ticks[i] as AxisTick;
    const gap = Math.abs(current.position - previous.position);
    if (gap < requiredGap(previous, current, horizontal, height, rotate)) return false;
  }
  return true;
}

/** Along-axis space two adjacent labels need. */
function requiredGap(
  a: AxisTick,
  b: AxisTick,
  horizontal: boolean,
  height: number,
  rotate: number,
): number {
  if (!horizontal) return height + MIN_LABEL_GAP_Y;
  if (rotate === 0) return (a.width + b.width) / 2 + MIN_LABEL_GAP_X;
  // Rotated labels stack along a diagonal: what limits them is the line height
  // projected onto the axis, not their length.
  const radians = (Math.abs(rotate) * Math.PI) / 180;
  const sin = Math.sin(radians);
  if (sin < 1e-6) return (a.width + b.width) / 2 + MIN_LABEL_GAP_X;
  return height / sin + MIN_LABEL_GAP_X / 2;
}

/**
 * Keep every `k`-th label, for the smallest `k` that fits.
 *
 * The first label is always kept: it anchors the reader at the domain's start,
 * and a ladder whose first rung is missing looks like a rendering bug.
 */
function thinToFit(
  ticks: readonly AxisTick[],
  horizontal: boolean,
  height: number,
  rotate: number,
): { ticks: AxisTick[]; dropped: number } {
  for (let stride = 2; stride <= ticks.length; ++stride) {
    const kept: AxisTick[] = [];
    for (let i = 0; i < ticks.length; i += stride) kept.push(ticks[i] as AxisTick);
    if (fits(kept, horizontal, height, rotate)) {
      return { ticks: kept, dropped: ticks.length - kept.length };
    }
  }
  const first = ticks[0];
  return first === undefined
    ? { ticks: [], dropped: 0 }
    : { ticks: [first], dropped: ticks.length - 1 };
}

/** Nodes an axis contributes, split by paint order. */
export interface AxisNodes {
  /** Gridlines, painted under the marks. */
  grid: SceneNode[];
  /** Baseline, tick marks, labels and title, painted over the surface. */
  axis: SceneNode[];
}

/**
 * Emit the nodes for a measured axis.
 *
 * @param frame - the plot rectangle, in scene coordinates
 */
export function renderAxis(geometry: AxisGeometry, frame: Rect, ctx: LayoutContext): AxisNodes {
  const model = geometry.model;
  const horizontal = isHorizontal(model);
  const theme = ctx.theme;
  const grid: SceneNode[] = [];
  const axis: SceneNode[] = [];

  const gridStroke = {
    paint: solid(theme.tokens.grid),
    width: theme.marks.grid.width,
  };
  const axisStroke = { paint: solid(theme.tokens.axis), width: theme.metrics.hairline };
  const labelFill = solid(theme.tokens['text-muted']);
  const titleFill = solid(theme.tokens['text-secondary']);

  // Gridlines. Always solid, one step off the surface, recessive (SPEC 11.4).
  if (model.grid) {
    for (const tick of geometry.ticks) {
      const line: LineNode = horizontal
        ? {
            kind: 'line',
            x1: tick.position,
            y1: frame.y,
            x2: tick.position,
            y2: frame.y + frame.height,
            stroke: gridStroke,
            cls: CLS.gridLine,
          }
        : {
            kind: 'line',
            x1: frame.x,
            y1: tick.position,
            x2: frame.x + frame.width,
            y2: tick.position,
            stroke: gridStroke,
            cls: CLS.gridLine,
          };
      grid.push(line);
    }
  }

  const edge = axisEdge(model.position, frame);
  const outward = outwardSign(model.position);

  if (model.baseline) {
    axis.push(
      horizontal
        ? {
            kind: 'line',
            x1: frame.x,
            y1: edge,
            x2: frame.x + frame.width,
            y2: edge,
            stroke: axisStroke,
            cls: CLS.axisLine,
          }
        : {
            kind: 'line',
            x1: edge,
            y1: frame.y,
            x2: edge,
            y2: frame.y + frame.height,
            stroke: axisStroke,
            cls: CLS.axisLine,
          },
    );
  }

  for (const tick of geometry.ticks) {
    axis.push(
      horizontal
        ? {
            kind: 'line',
            x1: tick.position,
            y1: edge,
            x2: tick.position,
            y2: edge + TICK_LENGTH * outward,
            stroke: axisStroke,
            cls: CLS.axisTick,
          }
        : {
            kind: 'line',
            x1: edge,
            y1: tick.position,
            x2: edge + TICK_LENGTH * outward,
            y2: tick.position,
            stroke: axisStroke,
            cls: CLS.axisTick,
          },
    );
  }

  if (geometry.showLabels) {
    const offset = TICK_LENGTH + TICK_LABEL_GAP;
    for (const tick of geometry.ticks) {
      const node: TextNode = horizontal
        ? makeText(
            {
              x: tick.position,
              y: edge + offset * outward,
              text: tick.label,
              font: geometry.font,
              fill: labelFill,
              anchor: geometry.rotate === 0 ? 'middle' : outward > 0 ? 'end' : 'start',
              baseline: outward > 0 ? 'top' : 'bottom',
              ...(geometry.rotate !== 0 ? { rotate: geometry.rotate } : {}),
              cls: CLS.axisLabel,
            },
            ctx.metrics,
          )
        : makeText(
            {
              x: edge + offset * outward,
              y: tick.position,
              text: tick.label,
              font: geometry.font,
              fill: labelFill,
              anchor: outward > 0 ? 'start' : 'end',
              baseline: 'middle',
              // SPEC 11.5: y-axis ticks use tabular figures so the column of
              // numbers lines up digit for digit.
              tabular: true,
              cls: CLS.axisLabel,
            },
            ctx.metrics,
          );
      axis.push(node);
    }
  }

  if (geometry.title !== false && geometry.title !== '') {
    const titleFont = themeFont(theme, 'tick');
    const band =
      TICK_LENGTH +
      (geometry.showLabels
        ? TICK_LABEL_GAP +
          (horizontal
            ? maxRotatedHeight(geometry.ticks, geometry.lineHeight, geometry.rotate)
            : maxLabelWidth(geometry.ticks))
        : 0) +
      AXIS_TITLE_GAP;
    axis.push(
      horizontal
        ? makeText(
            {
              x: frame.x + frame.width / 2,
              y: edge + (band + (outward > 0 ? 0 : lineHeight(titleFont, ctx.metrics))) * outward,
              text: geometry.title,
              font: titleFont,
              fill: titleFill,
              anchor: 'middle',
              baseline: outward > 0 ? 'top' : 'bottom',
              cls: CLS.axisTitle,
            },
            ctx.metrics,
          )
        : makeText(
            {
              x: edge + band * outward,
              y: frame.y + frame.height / 2,
              text: geometry.title,
              font: titleFont,
              fill: titleFill,
              anchor: 'middle',
              baseline: outward > 0 ? 'bottom' : 'top',
              // A left-edge title reads bottom-to-top; a right-edge one top-to-bottom.
              rotate: outward > 0 ? 90 : -90,
              cls: CLS.axisTitle,
            },
            ctx.metrics,
          ),
    );
  }

  return { grid, axis };
}

/** The coordinate of the frame edge an axis sits on. */
export function axisEdge(position: AxisModel['position'], frame: Rect): number {
  switch (position) {
    case 'top':
      return frame.y;
    case 'bottom':
      return frame.y + frame.height;
    case 'left':
      return frame.x;
    case 'right':
    default:
      return frame.x + frame.width;
  }
}

/** `+1` when "outside the plot" means increasing coordinates. */
export function outwardSign(position: AxisModel['position']): number {
  return position === 'bottom' || position === 'right' ? 1 : -1;
}
