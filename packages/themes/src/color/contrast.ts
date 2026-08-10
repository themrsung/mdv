/**
 * WCAG 2.x relative luminance and contrast (SPEC 12.5).
 *
 * Graphical objects meet 3:1 against the surface (WCAG 1.4.11); text meets 4.5:1,
 * or 3:1 at ≥ 18.66 px bold / ≥ 24 px.
 */

import type { Rgb } from './rgb.js';
import { decodeGamma, over, parseColor } from './rgb.js';

/** WCAG 2.x relative luminance of an opaque color, `0…1`. */
export function relativeLuminance(c: Pick<Rgb, 'r' | 'g' | 'b'>): number {
  return 0.2126 * decodeGamma(c.r) + 0.7152 * decodeGamma(c.g) + 0.0722 * decodeGamma(c.b);
}

/**
 * Contrast ratio between two colors, `1…21`.
 *
 * A translucent foreground is composited over the other color first: the ratio
 * describes what the eye receives, and `rgba(11,11,11,0.10)` on the light surface
 * is not the same stimulus as opaque `#0b0b0b`.
 */
export function contrastRatioRgb(a: Rgb, b: Rgb): number {
  const bg = b.a >= 1 ? b : over(b, { r: 1, g: 1, b: 1, a: 1 });
  const fg = a.a >= 1 ? a : over(a, bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const hi = l1 > l2 ? l1 : l2;
  const lo = l1 > l2 ? l2 : l1;
  return (hi + 0.05) / (lo + 0.05);
}

/** {@link contrastRatioRgb} over color strings. */
export function contrastRatioOf(a: string, b: string): number {
  return contrastRatioRgb(parseColor(a), parseColor(b));
}

/** The WCAG minimum for a graphical object against its surface (1.4.11). */
export const GRAPHIC_CONTRAST_MIN = 3;

/** The WCAG minimum for body-size text (1.4.3). */
export const TEXT_CONTRAST_MIN = 4.5;

/** The WCAG minimum for large text: ≥ 18.66 px bold or ≥ 24 px (1.4.3). */
export const LARGE_TEXT_CONTRAST_MIN = 3;

/**
 * The floor an *ordinal* ramp step must clear against its surface (SPEC 11.3):
 * the step nearest the surface stays at ≥ 2:1.
 */
export const ORDINAL_RAMP_CONTRAST_MIN = 2;
