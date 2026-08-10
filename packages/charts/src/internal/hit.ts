/**
 * Hit regions and readouts (SPEC 7.5, 12.4).
 *
 * A chart type emits the region around its painted mark; **core grows every one
 * to the 24 × 24 px minimum** (registry.ts) so that rule is enforced in exactly
 * one place. Nothing here pads a target.
 *
 * The readout is built once and used for **both hover and keyboard focus** — they
 * are required to be identical (SPEC 12.4). The value is the prominent element
 * and the series name is secondary (SPEC 7.5).
 */

import type { ChartHitRegion, ReadoutRow, SeriesDescriptor } from '@mdv/core';
import { finite } from './num.js';
import { px } from './geometry.js';

/** Build a readout row. The swatch is a short line stroke, never a filled box. */
export function readout(label: string, value: string, series?: SeriesDescriptor, emphasis = false): ReadoutRow {
  const row: ReadoutRow = { label, value };
  if (series !== undefined) row.swatch = series.color;
  if (emphasis) row.emphasis = true;
  return row;
}

/** Arguments for {@link hitRegion}. */
export interface HitRegionInput {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the tooltip points; defaults to the rectangle's centre. */
  anchor?: { x: number; y: number };
  datumIndex: number;
  seriesId?: string | undefined;
  group?: string | undefined;
  readout: ReadoutRow[];
  markNodeId?: string | undefined;
}

/**
 * A hit region in scene coordinates, normalised so width and height are never
 * negative — a bar drawn upward from its baseline produces an inverted rectangle
 * otherwise, and inverted rectangles never match a pointer.
 */
export function hitRegion(input: HitRegionInput): ChartHitRegion {
  const x0 = finite(input.x, 0);
  const y0 = finite(input.y, 0);
  const w = finite(input.w, 0);
  const h = finite(input.h, 0);
  const x = w < 0 ? x0 + w : x0;
  const y = h < 0 ? y0 + h : y0;
  const width = Math.abs(w);
  const height = Math.abs(h);
  const region: ChartHitRegion = {
    x: px(x),
    y: px(y),
    w: px(width),
    h: px(height),
    anchor: {
      x: px(finite(input.anchor?.x, x + width / 2)),
      y: px(finite(input.anchor?.y, y + height / 2)),
    },
    datumIndex: input.datumIndex,
    readout: input.readout,
  };
  if (input.seriesId !== undefined && input.seriesId !== '') region.seriesId = input.seriesId;
  if (input.group !== undefined && input.group !== '') region.group = input.group;
  if (input.markNodeId !== undefined) region.markNodeId = input.markNodeId;
  return region;
}

/**
 * A point target: a square centred on the mark.
 *
 * Sized to the painted mark, not to the 24 px minimum — growing it is core's job,
 * and doing it here as well would double the padding.
 */
export function pointHit(
  cx: number,
  cy: number,
  radius: number,
  rest: Omit<HitRegionInput, 'x' | 'y' | 'w' | 'h' | 'anchor'>,
): ChartHitRegion {
  const r = Math.max(0, finite(radius, 0));
  return hitRegion({
    x: finite(cx, 0) - r,
    y: finite(cy, 0) - r,
    w: r * 2,
    h: r * 2,
    anchor: { x: finite(cx, 0), y: finite(cy, 0) },
    ...rest,
  });
}
