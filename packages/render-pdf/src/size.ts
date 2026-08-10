/**
 * Natural size of a block on the printed page (SPEC 5.4 `width`/`height`/
 * `aspect`, SPEC 28.5).
 *
 * The exporter has to decide how big a block *wants* to be before it can ask
 * layout for a scene, because `layoutBlock` takes the size as given. On screen
 * the host does this against the viewport; here the basis is the text column,
 * which is the whole reason a chart re-lays out for print instead of being
 * scaled: at 400 pt the axis gets the ticks that fit 400 pt.
 *
 * *CONTRACT: `@mdv/core` exports `resolveDimension`, which does exactly this
 * unit arithmetic, but it is not reachable through the package's built
 * declarations at the time of writing. The table below mirrors
 * `packages/core/src/layout/dimension.ts` (`PX_PER_INCH = 96`) and should be
 * replaced by an import once core re-exports it.*
 */

import type { BlockAttrs, Size, Theme } from '@mdv/core';

/** CSS reference pixels per inch. */
const PX_PER_INCH = 96;

/** Absolute units, in CSS pixels per unit. */
const ABSOLUTE: Readonly<Record<string, number>> = {
  px: 1,
  pt: PX_PER_INCH / 72,
  pc: PX_PER_INCH / 6,
  in: PX_PER_INCH,
  cm: PX_PER_INCH / 2.54,
  mm: PX_PER_INCH / 25.4,
  q: PX_PER_INCH / 101.6,
};

/** Default block height in CSS pixels (SPEC 5.4). */
export const DEFAULT_HEIGHT = 300;

const DIMENSION = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*([a-z%]*)\s*$/;

/**
 * Resolve one dimension to CSS pixels.
 *
 * `vw`/`vh` resolve against the text column: a printed page has no viewport,
 * and refusing the unit outright would silently drop a block that renders
 * perfectly well on screen.
 *
 * @returns `undefined` when the value is absent or unparseable, so the caller
 * can apply its own default rather than being handed a zero.
 */
export function resolveLengthPx(value: unknown, basisPx: number, theme: Theme): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = DIMENSION.exec(value.toLowerCase());
  if (match === null) return undefined;
  const amount = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? '';
  if (unit === '' || unit === 'px') return amount;
  if (unit === '%') return (amount / 100) * basisPx;
  if (unit === 'rem') return amount * 16;
  if (unit === 'em') return amount * theme.type.fontSize;
  if (unit === 'vw' || unit === 'vh') return (amount / 100) * basisPx;
  const scale = ABSOLUTE[unit];
  return scale === undefined ? undefined : amount * scale;
}

/** `true` when the width is a fraction of its container rather than fixed. */
function isFluid(width: unknown): boolean {
  if (width === undefined) return true;
  return typeof width === 'string' && (width.includes('%') || width.trim() === 'auto');
}

/**
 * How large a block wants to be, in CSS pixels, in a column `columnPx` wide.
 *
 * `aspect` wins over `height` when the width is fluid, which is what makes a
 * chart keep its proportions as the column narrows (SPEC 5.4).
 */
export function naturalSize(attrs: BlockAttrs, columnPx: number, theme: Theme): Size {
  const column = Math.max(1, columnPx);
  const width = resolveLengthPx(attrs.width, column, theme) ?? column;
  const aspect = typeof attrs.aspect === 'number' && attrs.aspect > 0 ? attrs.aspect : undefined;

  let height: number;
  if (aspect !== undefined && (isFluid(attrs.width) || attrs.height === undefined)) {
    height = width / aspect;
  } else {
    height = resolveLengthPx(attrs.height, width, theme) ?? DEFAULT_HEIGHT;
  }

  return {
    width: Math.max(1, Math.min(width, column)),
    height: Math.max(1, height),
  };
}
