/**
 * The hit index (SPEC 7.5, 12.4, 12.5, 20).
 *
 * > `hitIndex` is computed in layout, so DOM and Canvas hit-testing behave
 * > identically and a **24 px minimum target** is enforced in one place.
 *
 * That "one place" is {@link growToMinimum}. An 8 px dot with an 8 px target is
 * unhittable with a finger and nearly unhittable with a trackpad, so the region
 * grows around the painted mark and is allowed to overlap its neighbours —
 * overlapping targets resolve to the nearest anchor, which is still better than
 * a target nobody can hit.
 *
 * The focus order (SPEC 12.4) is built here too, because arrow keys walk the
 * same regions the pointer hits and Page Up/Page Down jump between their
 * `group` boundaries. One list, two input devices, identical readouts.
 */

import type { ChartHitRegion } from '../registry.js';
import type { IdFactory, Rect } from '../types/layout.js';
import type { HitRegion } from '../types/scene.js';

/** The minimum interactive target, in px (SPEC 7.5, 12.5). */
export const MIN_HIT_SIZE = 24;

/**
 * Grow a rectangle to at least {@link MIN_HIT_SIZE} in both axes, keeping its
 * centre.
 *
 * Growth is symmetric so the target stays centred on what the reader sees.
 */
export function growToMinimum(rect: Rect, minimum = MIN_HIT_SIZE): Rect {
  const width = Math.max(rect.width, minimum);
  const height = Math.max(rect.height, minimum);
  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height,
  };
}

/**
 * Slide a rectangle back inside `bounds` without shrinking it.
 *
 * Shifting rather than clipping: a target that has been clipped to 24 × 12 is
 * exactly the failure the minimum exists to prevent. A region larger than the
 * bounds is left alone — it is already as reachable as it can be.
 */
export function clampIntoBounds(rect: Rect, bounds: Rect): Rect {
  let { x, y } = rect;
  if (rect.width <= bounds.width) {
    x = Math.min(Math.max(x, bounds.x), bounds.x + bounds.width - rect.width);
  }
  if (rect.height <= bounds.height) {
    y = Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - rect.height);
  }
  return { ...rect, x, y };
}

/** Options for {@link buildHitIndex}. */
export interface HitIndexOptions {
  ids: IdFactory;
  /** Keeps targets inside the block. Usually the scene rectangle. */
  bounds?: Rect | undefined;
  /** Overrides the 24 px floor. Only a test should. */
  minimum?: number;
}

/**
 * Turn a chart type's proposed regions into the resolved {@link HitRegion} list.
 *
 * Ids are assigned here unless the chart supplied one, so focus order is stable
 * across re-renders even when a chart re-emits its regions in a different order.
 */
export function buildHitIndex(
  regions: readonly ChartHitRegion[],
  options: HitIndexOptions,
): HitRegion[] {
  const minimum = options.minimum ?? MIN_HIT_SIZE;
  const out: HitRegion[] = [];

  for (const region of regions) {
    const grown = growToMinimum(
      { x: region.x, y: region.y, width: region.w, height: region.h },
      minimum,
    );
    const placed = options.bounds === undefined ? grown : clampIntoBounds(grown, options.bounds);

    const resolved: HitRegion = {
      id: region.id ?? options.ids.next('hit'),
      x: placed.x,
      y: placed.y,
      w: placed.width,
      h: placed.height,
      anchor: region.anchor,
      datumIndex: region.datumIndex,
      readout: region.readout,
    };
    if (region.seriesId !== undefined) resolved.seriesId = region.seriesId;
    if (region.group !== undefined) resolved.group = region.group;
    if (region.markNodeId !== undefined) resolved.markNodeId = region.markNodeId;
    out.push(resolved);
  }

  return out;
}

/**
 * Keyboard traversal order (SPEC 12.4).
 *
 * Regions are grouped by their `group` (falling back to `seriesId`), groups in
 * first-appearance order and members in emission order. Arrow keys then walk a
 * series left to right and Page Up/Page Down step between series, which is what
 * the spec's key map describes.
 */
export function focusOrderOf(regions: readonly HitRegion[]): string[] {
  const groups = new Map<string, string[]>();
  for (const region of regions) {
    const key = region.group ?? region.seriesId ?? '';
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [region.id]);
    else bucket.push(region.id);
  }
  // Map iteration is insertion order, which is first-appearance order here —
  // deterministic without sorting (SPEC 24.3 rule 5).
  const order: string[] = [];
  for (const ids of groups.values()) order.push(...ids);
  return order;
}

/**
 * The bounding box of a set of regions, for a container's focus ring.
 *
 * `undefined` for an empty set: a chart with no marks has no interactive area,
 * and returning a zero-size rectangle at the origin would put a focus ring in
 * the corner.
 */
export function hitBounds(regions: readonly HitRegion[]): Rect | undefined {
  if (regions.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const region of regions) {
    if (region.x < minX) minX = region.x;
    if (region.y < minY) minY = region.y;
    if (region.x + region.w > maxX) maxX = region.x + region.w;
    if (region.y + region.h > maxY) maxY = region.y + region.h;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
