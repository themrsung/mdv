/**
 * Colour scales (SPEC 7.2, 11.3): `sequential`, diverging, and the three
 * discretizing scales `quantize`, `quantile` and `threshold`.
 *
 * Interpolation runs in sRGB between the theme's **listed** steps rather than in
 * a perceptual space computed on the fly. The steps in SPEC 11.3 were selected
 * and validated as a set; re-deriving them from an endpoint pair at render time
 * would quietly discard that work, and a ramp that differs by a rounding mode
 * between two machines is not a reproducible document (SPEC 24.3).
 */

import type { Scale } from '../types/encode.js';
import type { ColorString } from '../types/theme.js';
import { formatNumber } from './format.js';

// ─────────────────────────────────────────────────────────────────────────────
// Colour parsing — enough to interpolate a ramp, no more
// ─────────────────────────────────────────────────────────────────────────────

/** An 8-bit sRGB triple with alpha in 0…1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i;

/**
 * Parse a colour string into sRGB.
 *
 * @returns `undefined` for anything this parser does not understand — an
 * `oklch()` or a named colour. Callers fall back to the endpoint colour rather
 * than interpolating garbage; a slightly coarse ramp beats a black chart.
 */
export function parseColor(color: ColorString): Rgba | undefined {
  const text = color.trim();
  const hex = HEX_RE.exec(text);
  if (hex !== null) {
    const digits = hex[1] as string;
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b, a] = [...digits].map((d) => Number.parseInt(d + d, 16));
      return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: a === undefined ? 1 : a / 255 };
    }
    if (digits.length === 6 || digits.length === 8) {
      const byte = (i: number): number => Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
      return { r: byte(0), g: byte(1), b: byte(2), a: digits.length === 8 ? byte(3) / 255 : 1 };
    }
    return undefined;
  }
  const rgb = RGB_RE.exec(text);
  if (rgb !== null) {
    const num = (raw: string | undefined): number =>
      raw === undefined ? 0 : Number.parseFloat(raw);
    const alphaRaw = rgb[4];
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? Number.parseFloat(alphaRaw) / 100
          : Number.parseFloat(alphaRaw);
    return {
      r: clampByte(num(rgb[1])),
      g: clampByte(num(rgb[2])),
      b: clampByte(num(rgb[3])),
      a: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
    };
  }
  return undefined;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Serialise sRGB back to `#rrggbb`, or `#rrggbbaa` when translucent. */
export function toHex(color: Rgba): ColorString {
  const hex = (value: number): string => clampByte(value).toString(16).padStart(2, '0');
  const base = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  if (color.a >= 1) return base;
  return base + hex(color.a * 255);
}

/** Linear interpolation between two colours in sRGB. `t` is clamped to 0…1. */
export function mixColors(from: Rgba, to: Rgba, t: number): Rgba {
  const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  return {
    r: from.r + (to.r - from.r) * k,
    g: from.g + (to.g - from.g) * k,
    b: from.b + (to.b - from.b) * k,
    a: from.a + (to.a - from.a) * k,
  };
}

/**
 * Relative luminance (WCAG 2.x), used to decide whether a label inside a filled
 * mark should be ink or surface (SPEC 11.5).
 */
export function relativeLuminance(color: ColorString): number {
  const rgb = parseColor(color);
  if (rgb === undefined) return 0;
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Sample a ramp of listed steps at `t` ∈ 0…1, interpolating between them. */
export function sampleRamp(steps: readonly ColorString[], t: number): ColorString {
  if (steps.length === 0) return '#000000';
  const first = steps[0] as ColorString;
  if (steps.length === 1) return first;
  const k = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const position = k * (steps.length - 1);
  const index = Math.min(steps.length - 2, Math.floor(position));
  const lower = parseColor(steps[index] as ColorString);
  const upper = parseColor(steps[index + 1] as ColorString);
  if (lower === undefined || upper === undefined) return steps[Math.round(position)] as ColorString;
  return toHex(mixColors(lower, upper, position - index));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequential
// ─────────────────────────────────────────────────────────────────────────────

/** Construction options for {@link createSequentialScale}. */
export interface SequentialScaleOptions {
  domain: readonly [number, number];
  /** Ramp steps, lightest first (SPEC 11.3). */
  steps: readonly ColorString[];
  /** Restrict the usable window of the ramp — the ordinal floor/ceiling. */
  clampSteps?: readonly [number, number];
  format?: string;
  locale?: string;
  reverse?: boolean;
}

/**
 * A continuous value → one-hue ramp scale (SPEC 11.3). Never a rainbow: a
 * rainbow has no perceptual order, so cells cannot be ranked without the legend.
 */
export function createSequentialScale(options: SequentialScaleOptions): Scale<number, ColorString> {
  const [d0, d1] = options.domain;
  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);
  const span = hi - lo;
  const locale = options.locale ?? 'en-US';

  const window = options.clampSteps;
  const steps =
    window === undefined
      ? [...options.steps]
      : options.steps.slice(
          Math.max(0, Math.min(options.steps.length - 1, window[0])),
          Math.max(1, Math.min(options.steps.length, window[1] + 1)),
        );
  const usable = steps.length > 0 ? steps : [...options.steps];

  const scale: Scale<number, ColorString> = {
    type: 'linear',
    domain: Object.freeze([d0, d1]),
    range: Object.freeze([...usable]) as readonly ColorString[],
    scale(value: number): ColorString | undefined {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      const t = span === 0 ? 0.5 : (value - lo) / span;
      return sampleRamp(usable, options.reverse === true ? 1 - t : t);
    },
    ticks(count?: number): readonly number[] {
      const n = Math.max(2, count ?? 5);
      const out: number[] = [];
      for (let i = 0; i < n; ++i) out.push(lo + (span * i) / (n - 1));
      return out;
    },
    format: (value: number) => formatNumber(value, options.format, locale),
  };
  return Object.freeze(scale);
}

/** Construction options for {@link createDivergingScale}. */
export interface DivergingScaleOptions {
  /** `[low, mid, high]`. The midpoint is where the neutral gray sits. */
  domain: readonly [number, number, number];
  lowSteps: readonly ColorString[];
  highSteps: readonly ColorString[];
  mid: ColorString;
  format?: string;
  locale?: string;
}

/**
 * A diverging scale: two hues meeting at a **neutral gray midpoint** (SPEC 11.3).
 * Never a hue at the midpoint — zero must read as "nothing".
 */
export function createDivergingScale(options: DivergingScaleOptions): Scale<number, ColorString> {
  const [d0, dm, d1] = options.domain;
  const locale = options.locale ?? 'en-US';
  // Both arms are listed light→dark; the low arm runs outward from the midpoint,
  // so it is sampled in reverse.
  const lowRamp = [...options.lowSteps].reverse();
  const highRamp = [...options.highSteps];

  const scale: Scale<number, ColorString> = {
    type: 'linear',
    domain: Object.freeze([d0, dm, d1]),
    range: Object.freeze([...lowRamp, options.mid, ...highRamp]) as readonly ColorString[],
    scale(value: number): ColorString | undefined {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      if (value === dm) return options.mid;
      if (value < dm) {
        const span = dm - d0;
        const t = span === 0 ? 1 : (dm - value) / span;
        return sampleRamp([options.mid, ...lowRamp], t);
      }
      const span = d1 - dm;
      const t = span === 0 ? 1 : (value - dm) / span;
      return sampleRamp([options.mid, ...highRamp], t);
    },
    ticks(count?: number): readonly number[] {
      const n = Math.max(3, count ?? 5);
      const out: number[] = [];
      for (let i = 0; i < n; ++i) out.push(d0 + ((d1 - d0) * i) / (n - 1));
      return out;
    },
    format: (value: number) => formatNumber(value, options.format, locale),
  };
  return Object.freeze(scale);
}

// ─────────────────────────────────────────────────────────────────────────────
// Discretizing scales
// ─────────────────────────────────────────────────────────────────────────────

/** Construction options for {@link createQuantizeScale}. */
export interface QuantizeScaleOptions<R> {
  domain: readonly [number, number];
  range: readonly R[];
  format?: string;
  locale?: string;
}

/** Equal-width binning of a continuous domain (SPEC 7.2, `quantize`). */
export function createQuantizeScale<R>(options: QuantizeScaleOptions<R>): Scale<number, R> {
  const [d0, d1] = options.domain;
  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);
  const range = [...options.range];
  const n = Math.max(1, range.length);
  const locale = options.locale ?? 'en-US';

  const scale: Scale<number, R> = {
    type: 'quantize',
    domain: Object.freeze([d0, d1]),
    range: Object.freeze(range) as readonly R[],
    scale(value: number): R | undefined {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      if (hi === lo) return range[0];
      const t = (value - lo) / (hi - lo);
      const index = Math.max(0, Math.min(n - 1, Math.floor(t * n)));
      return range[index];
    },
    ticks(count?: number): readonly number[] {
      const wanted = count ?? n;
      const out: number[] = [];
      for (let i = 0; i <= wanted; ++i) out.push(lo + ((hi - lo) * i) / Math.max(1, wanted));
      return out;
    },
    format: (value: number) => formatNumber(value, options.format, locale),
  };
  return Object.freeze(scale);
}

/** Construction options for {@link createQuantileScale}. */
export interface QuantileScaleOptions<R> {
  /** The **sample**, not an extent: quantile bins are data-defined. */
  values: readonly number[];
  range: readonly R[];
  format?: string;
  locale?: string;
}

/**
 * Quantile binning: equal *counts* per bin (SPEC 7.2, `quantile`).
 *
 * The sample is sorted numerically with an explicit comparator — the default
 * `Array.prototype.sort` is lexicographic and would put 10 before 9 (SPEC 24.3).
 */
export function createQuantileScale<R>(options: QuantileScaleOptions<R>): Scale<number, R> {
  const sample = options.values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  sample.sort((a, b) => a - b);
  const range = [...options.range];
  const n = Math.max(1, range.length);
  const locale = options.locale ?? 'en-US';

  const thresholds: number[] = [];
  for (let i = 1; i < n; ++i) thresholds.push(quantileSorted(sample, i / n));

  const lo = sample.length > 0 ? (sample[0] as number) : 0;
  const hi = sample.length > 0 ? (sample[sample.length - 1] as number) : 1;

  const scale: Scale<number, R> = {
    type: 'quantile',
    domain: Object.freeze([lo, hi]),
    range: Object.freeze(range) as readonly R[],
    scale(value: number): R | undefined {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      let index = 0;
      while (index < thresholds.length && value >= (thresholds[index] as number)) ++index;
      return range[Math.min(n - 1, index)];
    },
    ticks: () => Object.freeze([...thresholds]),
    format: (value: number) => formatNumber(value, options.format, locale),
  };
  return Object.freeze(scale);
}

/** The p-quantile of an already-sorted sample, by linear interpolation. */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const base = Math.floor(position);
  const rest = position - base;
  const lower = sorted[base] as number;
  const upper = sorted[base + 1];
  return upper === undefined ? lower : lower + (upper - lower) * rest;
}

/** Construction options for {@link createThresholdScale}. */
export interface ThresholdScaleOptions<R> {
  /** Cut points, ascending. `range` must have one more entry than this. */
  thresholds: readonly number[];
  range: readonly R[];
  format?: string;
  locale?: string;
}

/** Author-supplied cut points (SPEC 7.2, `threshold`). */
export function createThresholdScale<R>(options: ThresholdScaleOptions<R>): Scale<number, R> {
  const thresholds = [...options.thresholds].sort((a, b) => a - b);
  const range = [...options.range];
  const locale = options.locale ?? 'en-US';

  const scale: Scale<number, R> = {
    type: 'threshold',
    domain: Object.freeze([...thresholds]),
    range: Object.freeze(range) as readonly R[],
    scale(value: number): R | undefined {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      let index = 0;
      while (index < thresholds.length && value >= (thresholds[index] as number)) ++index;
      return range[Math.min(range.length - 1, index)];
    },
    ticks: () => Object.freeze([...thresholds]),
    format: (value: number) => formatNumber(value, options.format, locale),
  };
  return Object.freeze(scale);
}
