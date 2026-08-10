/**
 * Shared machinery for the cartesian types (`bar`, `line`, `area`, `scatter`).
 *
 * Axes are **modelled** here and **drawn** by core: "if two different chart types
 * would have to draw it identically, core draws it" (registry.ts). What lives
 * here is only the decision of which axes exist, which scale each ticks, and
 * where they sit.
 */

import type { AxisModel, AxisSpec, BlockAttrs, Channel, ChannelName, Column, Rect, Scale } from '@mdv/core';
import { channelFormat, channelTitle } from './table.js';
import { finite } from './num.js';
import { setScaleRange } from './scale.js';

/** The author's axis request for one channel, or `false` to suppress the axis. */
export function axisSpecFor(attrs: BlockAttrs, channel: ChannelName, binding: Channel | undefined): AxisSpec | false {
  const fromChannel = binding?.axis;
  if (fromChannel === false) return false;
  const axes = attrs.axis;
  const fromAttrs = channel === 'x' ? axes?.x : channel === 'y' ? axes?.y : undefined;
  if (fromAttrs === false) return false;
  return { ...(fromAttrs ?? {}), ...(fromChannel ?? {}) };
}

/** Inputs to {@link makeAxis}. */
export interface AxisRequest {
  channel: ChannelName;
  position: 'left' | 'right' | 'top' | 'bottom';
  scale: Scale;
  binding: Channel | undefined;
  column: Column | undefined;
  spec: AxisSpec | false;
  /** Gridlines default to `true` on the value axis, `false` on the category axis. */
  gridByDefault: boolean;
  /** Overrides the resolved format, e.g. `.0%` under `stack: percent`. */
  formatOverride?: string | undefined;
  /** The baseline defaults to on for a category axis and off for a value axis. */
  baselineByDefault: boolean;
}

/**
 * Build one {@link AxisModel}, or `undefined` when the author suppressed it.
 *
 * There is deliberately no way to ask for a second value axis: SPEC 7.3.1 forbids
 * it, and the absence of the option is the enforcement.
 */
export function makeAxis(request: AxisRequest): AxisModel | undefined {
  if (request.spec === false) return undefined;
  const spec = request.spec;
  const title = spec.title !== undefined ? spec.title : channelTitle(request.binding, request.column);
  const format = request.formatOverride ?? spec.format ?? channelFormat(request.binding, request.column);
  const axis: AxisModel = {
    channel: request.channel,
    position: spec.position ?? request.position,
    scale: request.scale,
    title,
    grid: spec.grid ?? request.gridByDefault,
    ticks: spec.ticks ?? 'auto',
    baseline: request.baselineByDefault,
  };
  if (spec.tickValues !== undefined) axis.tickValues = spec.tickValues;
  if (spec.tickRotate !== undefined) axis.tickRotate = spec.tickRotate;
  if (format !== undefined) axis.format = format;
  return axis;
}

/**
 * Fix the scales' output ranges to the plot frame.
 *
 * The vertical scale is **inverted** — scene y grows downward (SPEC 20) while a
 * value axis grows upward — so the range is `[bottom, top]`, not `[top, bottom]`.
 * Getting this backwards is the classic upside-down chart, so it happens in one
 * place for every type.
 */
export function rangeToFrame(frame: Rect, horizontal: Scale | undefined, vertical: Scale | undefined): void {
  const x = finite(frame.x, 0);
  const y = finite(frame.y, 0);
  const width = Math.max(0, finite(frame.width, 0));
  const height = Math.max(0, finite(frame.height, 0));
  setScaleRange(horizontal, x, x + width);
  setScaleRange(vertical, y + height, y);
}

/**
 * Range a **discrete** scale down the frame: the first category at the top.
 *
 * Used for the category axis of a horizontal bar chart, where reading order runs
 * top to bottom rather than bottom up.
 */
export function rangeDownFrame(frame: Rect, scale: Scale | undefined): void {
  const y = finite(frame.y, 0);
  const height = Math.max(0, finite(frame.height, 0));
  setScaleRange(scale, y, y + height);
}

/** `true` when the frame has no usable area — core reports `MDV5001` for this. */
export function isDegenerateFrame(frame: Rect): boolean {
  return !(finite(frame.width, 0) > 0) || !(finite(frame.height, 0) > 0);
}
