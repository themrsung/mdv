/**
 * Dimension resolution (SPEC 5.3.3, 8.1).
 *
 * > A bare number is device pixels, a string carries a CSS-like unit
 * > (`"320px"`, `"100%"`, `"16rem"`, `"8cm"`). A malformed value is `MDV1221`.
 *
 * Physical units convert at the CSS reference of 96 dpi, which is the only
 * conversion that keeps a `"8cm"` chart the same size in the browser and in the
 * PDF exporter.
 */

import type { Dimension, PaddingAttr } from '../types/attrs.js';
import type { Insets } from '../types/layout.js';
import type { Reporter } from '../encode/report.js';

/** CSS reference pixels per inch. */
const PX_PER_INCH = 96;

const UNIT_RE = /^\s*(-?(?:\d+\.?\d*|\.\d+))\s*(px|%|rem|em|pt|pc|in|cm|mm|q|vw|vh)?\s*$/i;

/** What a relative unit resolves against. */
export interface DimensionBasis {
  /** 100 % of what. */
  reference: number;
  /** Root font size, for `rem`. @defaultValue 16 */
  rootFontSize?: number;
  /** Local font size, for `em`. @defaultValue rootFontSize */
  fontSize?: number;
  /** Viewport box, for `vw`/`vh`. Defaults to the reference. */
  viewport?: { width: number; height: number };
}

/**
 * Resolve a dimension to CSS pixels.
 *
 * @returns `undefined` for a malformed value, after reporting `MDV1221`. The
 * caller substitutes its default rather than rendering a `NaN`-sized box.
 */
export function resolveDimension(
  value: Dimension | undefined,
  basis: DimensionBasis,
  reporter?: Reporter,
  attribute = 'dimension',
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;

  const match = UNIT_RE.exec(value);
  if (match === null) {
    reporter?.emit('MDV1221', {
      message: `\`${attribute}: ${value}\` is not a dimension`,
      detail:
        'Write a bare number for device pixels, or a number with a unit: ' +
        '`320px`, `100%`, `16rem`, `8cm`.',
    });
    return undefined;
  }

  const magnitude = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(magnitude)) return undefined;
  const unit = (match[2] ?? 'px').toLowerCase();
  const rootFontSize = basis.rootFontSize ?? 16;
  const fontSize = basis.fontSize ?? rootFontSize;
  const viewport = basis.viewport ?? { width: basis.reference, height: basis.reference };

  switch (unit) {
    case 'px':
      return magnitude;
    case '%':
      return (magnitude / 100) * basis.reference;
    case 'rem':
      return magnitude * rootFontSize;
    case 'em':
      return magnitude * fontSize;
    case 'pt':
      return (magnitude * PX_PER_INCH) / 72;
    case 'pc':
      return (magnitude * PX_PER_INCH) / 6;
    case 'in':
      return magnitude * PX_PER_INCH;
    case 'cm':
      return (magnitude * PX_PER_INCH) / 2.54;
    case 'mm':
      return (magnitude * PX_PER_INCH) / 25.4;
    case 'q':
      return (magnitude * PX_PER_INCH) / 101.6;
    case 'vw':
      return (magnitude / 100) * viewport.width;
    case 'vh':
      return (magnitude / 100) * viewport.height;
    default:
      return magnitude;
  }
}

/** The default padding of every visual block (SPEC 8.1). */
export const DEFAULT_PADDING: Insets = Object.freeze({
  top: 8,
  right: 8,
  bottom: 8,
  left: 8,
});

/**
 * Resolve `padding:` from either spelling: one dimension for all four sides, or
 * a per-side box. Missing sides fall back to the default, not to zero — a box
 * that sets only `left` should keep its breathing room elsewhere.
 */
export function resolvePadding(
  attr: PaddingAttr | undefined,
  basis: DimensionBasis,
  reporter?: Reporter,
): Insets {
  if (attr === undefined) return DEFAULT_PADDING;

  if (typeof attr === 'number' || typeof attr === 'string') {
    const all = resolveDimension(attr, basis, reporter, 'padding');
    if (all === undefined) return DEFAULT_PADDING;
    return { top: all, right: all, bottom: all, left: all };
  }

  const side = (name: 'top' | 'right' | 'bottom' | 'left'): number =>
    resolveDimension(attr[name], basis, reporter, `padding.${name}`) ?? DEFAULT_PADDING[name];

  return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
}

/** Shrink a rectangle by insets, never past zero. */
export function insetRect(
  rect: { x: number; y: number; width: number; height: number },
  insets: Insets,
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x + insets.left,
    y: rect.y + insets.top,
    width: Math.max(0, rect.width - insets.left - insets.right),
    height: Math.max(0, rect.height - insets.top - insets.bottom),
  };
}
