/**
 * The outer box of a block, in CSS pixels (SPEC 8.1).
 *
 * `layoutBlock` takes a `Size` and asks no questions about where it came from;
 * turning `width: 100%` and `aspect: 16/9` into two numbers is the host's job,
 * and this is the host. Everything is resolved through core's `resolveDimension`
 * so `"8cm"` means the same thing here, in the PDF exporter and in the CLI.
 */

import type { BlockAttrs, Size } from '@mdv/core';
import { resolveDimension } from '@mdv/core/layout/index.js';

/** SPEC 8.1: `height` defaults to 300 device pixels. */
export const DEFAULT_HEIGHT = 300;

/**
 * The width used when nothing has measured the container yet — server
 * rendering, and the first client render before the `ResizeObserver` fires.
 *
 * 800 is `HtmlOptions.width`'s default, so an SSR document and an
 * `mdv export --html` of the same source lay out identically.
 */
export const DEFAULT_WIDTH = 800;

/** Inputs to {@link resolveBlockSize}. */
export interface SizeRequest {
  attrs: BlockAttrs;
  /** The measured content-box width of the container, when there is one. */
  containerWidth: number | undefined;
  /** Fallback width when the container has not been measured. */
  fallbackWidth?: number;
  /** An explicit height from a component prop, which outranks `attrs.height`. */
  heightOverride?: number | undefined;
}

/**
 * Resolve `width`/`height`/`aspect` into a concrete box.
 *
 * - `width` defaults to `100%` of the container.
 * - `height` defaults to 300.
 * - `aspect` **overrides `height` when the width is fluid** (SPEC 8.1), which is
 *   the only way to keep a responsive chart from changing shape as it grows.
 *
 * A malformed dimension has already been reported as `MDV1221` by
 * `resolveDimension`; here it simply falls back, because a `NaN`-sized box is
 * worse than a default-sized one.
 */
export function resolveBlockSize(request: SizeRequest): Size {
  const fallbackWidth = request.fallbackWidth ?? DEFAULT_WIDTH;
  const reference =
    request.containerWidth !== undefined && request.containerWidth > 0
      ? request.containerWidth
      : fallbackWidth;

  const basis = { reference, rootFontSize: 16 };
  const declaredWidth = resolveDimension(request.attrs.width, basis);
  const width = declaredWidth !== undefined && declaredWidth > 0 ? declaredWidth : reference;

  const fluid = request.attrs.width === undefined || String(request.attrs.width).endsWith('%');
  const aspect =
    typeof request.attrs.aspect === 'number' && request.attrs.aspect > 0
      ? request.attrs.aspect
      : undefined;

  if (request.heightOverride !== undefined && request.heightOverride > 0) {
    return { width: round(width), height: round(request.heightOverride) };
  }
  if (aspect !== undefined && fluid) {
    return { width: round(width), height: round(width / aspect) };
  }

  const declaredHeight = resolveDimension(request.attrs.height, {
    ...basis,
    // A percentage height has nothing to resolve against in a fluid document
    // flow, so it resolves against the block's own width — the same convention
    // CSS `padding-bottom` percentages use for aspect boxes.
    reference: width,
  });
  const height =
    declaredHeight !== undefined && declaredHeight > 0 ? declaredHeight : DEFAULT_HEIGHT;
  return { width: round(width), height: round(height) };
}

/**
 * Snap to whole pixels.
 *
 * The scene is a cache key: a container that reports `640.0000000001` on one
 * frame and `640` on the next must not produce two scenes, and a sub-pixel
 * difference is invisible anyway (SPEC 22.3, "width changes below 1 px are
 * ignored").
 */
function round(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
