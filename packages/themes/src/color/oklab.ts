/**
 * OKLab and OKLCh (Björn Ottosson, 2020).
 *
 * The perceptual space the whole palette discipline is expressed in: SPEC 11.2's
 * separation gates and SPEC 16.4's thresholds are all "ΔE in OKLab ×100". OKLab
 * is used rather than CIELAB because its hue lines stay straight under lightness
 * changes, which is what makes "darken this slot until it clears 3:1" a
 * hue-preserving operation.
 *
 * All matrices below are Ottosson's published constants for the D65 sRGB
 * primaries. Nothing here is fitted or tweaked.
 */

import type { Rgb } from './rgb.js';
import { clamp01, decodeGamma, encodeGamma, inGamut, parseColor } from './rgb.js';

/** A color in OKLab: `L` in `0…1`, `a`/`b` roughly `-0.4…0.4`. */
export interface Oklab {
  readonly L: number;
  readonly a: number;
  readonly b: number;
}

/** A color in OKLCh: `L` in `0…1`, `C` ≥ 0, `h` in degrees `0…360`. */
export interface Oklch {
  readonly L: number;
  readonly C: number;
  readonly h: number;
}

/** Non-linear sRGB → OKLab. Alpha is dropped; composite first if it matters. */
export function rgbToOklab(c: Pick<Rgb, 'r' | 'g' | 'b'>): Oklab {
  const r = decodeGamma(c.r);
  const g = decodeGamma(c.g);
  const b = decodeGamma(c.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * OKLab → non-linear sRGB, **unclamped**.
 *
 * Callers that need a displayable color must either check {@link inGamut} or go
 * through {@link gamutMap}; silently clamping here would turn an out-of-gamut
 * ramp step into a hue shift nobody asked for.
 */
export function oklabToRgbUnclamped(c: Oklab): { r: number; g: number; b: number } {
  const l_ = c.L + 0.3963377774 * c.a + 0.2158037573 * c.b;
  const m_ = c.L - 0.1055613458 * c.a - 0.0638541728 * c.b;
  const s_ = c.L - 0.0894841775 * c.a - 1.291485548 * c.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: encodeGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encodeGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encodeGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** OKLab → opaque sRGB, clamped per channel. */
export function oklabToRgb(c: Oklab): Rgb {
  const v = oklabToRgbUnclamped(c);
  return { r: clamp01(v.r), g: clamp01(v.g), b: clamp01(v.b), a: 1 };
}

/** OKLab → OKLCh. Hue of a neutral is reported as 0, not NaN. */
export function oklabToOklch(c: Oklab): Oklch {
  const C = Math.hypot(c.a, c.b);
  if (C < 1e-9) return { L: c.L, C: 0, h: 0 };
  const h = (Math.atan2(c.b, c.a) * 180) / Math.PI;
  return { L: c.L, C, h: h < 0 ? h + 360 : h };
}

/** OKLCh → OKLab. */
export function oklchToOklab(c: Oklch): Oklab {
  const rad = (c.h * Math.PI) / 180;
  return { L: c.L, a: c.C * Math.cos(rad), b: c.C * Math.sin(rad) };
}

/** Parse and convert in one step. */
export function toOklab(color: string): Oklab {
  return rgbToOklab(parseColor(color));
}

/** Parse and convert in one step. */
export function toOklch(color: string): Oklch {
  return oklabToOklch(rgbToOklab(parseColor(color)));
}

/**
 * Bring an OKLCh color into the sRGB gamut by **reducing chroma only**, holding
 * L and h fixed — the standard CSS Color 4 approach, and the only one that keeps
 * a generated ramp monotone in lightness.
 *
 * Deterministic: a fixed 24-step bisection, never a tolerance-driven loop whose
 * iteration count could vary with the input.
 */
export function gamutMap(c: Oklch): Rgb {
  const direct = oklabToRgbUnclamped(oklchToOklab(c));
  if (inGamut(direct)) {
    return { r: clamp01(direct.r), g: clamp01(direct.g), b: clamp01(direct.b), a: 1 };
  }
  if (c.L <= 0) return { r: 0, g: 0, b: 0, a: 1 };
  if (c.L >= 1) return { r: 1, g: 1, b: 1, a: 1 };

  let lo = 0;
  let hi = c.C;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToRgbUnclamped(oklchToOklab({ L: c.L, C: mid, h: c.h })))) lo = mid;
    else hi = mid;
  }
  const v = oklabToRgbUnclamped(oklchToOklab({ L: c.L, C: lo, h: c.h }));
  return { r: clamp01(v.r), g: clamp01(v.g), b: clamp01(v.b), a: 1 };
}

/** Euclidean OKLab distance ×100 — the unit every SPEC 16.4 threshold is quoted in. */
export function deltaEOklabRgb(
  x: Pick<Rgb, 'r' | 'g' | 'b'>,
  y: Pick<Rgb, 'r' | 'g' | 'b'>,
): number {
  const p = rgbToOklab(x);
  const q = rgbToOklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b) * 100;
}
