/**
 * The internal color representation and the CSS color parser (SPEC 5.3.3).
 *
 * Every colorimetric routine in this package — OKLab, WCAG contrast, CVD
 * simulation — starts here, so there is exactly one place that decides what a
 * color string means. Parsing is deliberately total-or-throw: a theme carrying
 * an unparseable color is a configuration error the host must see, never a
 * silently-substituted black.
 */

import { MdvConfigError } from '@mdv/core';
import { NAMED_COLORS } from './named.js';

/**
 * A parsed color: non-linear sRGB channels in `0…1` plus straight (un-premultiplied)
 * alpha in `0…1`.
 *
 * Kept as floats rather than bytes because the OKLab round-trip and the ramp
 * generator both need sub-byte precision; quantisation happens once, in
 * {@link formatHex}.
 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX4 = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const FUNC = /^([a-z-]+)\(([^)]*)\)$/i;

/** Clamp to `0…1`. NaN collapses to 0 so a bad channel can never poison a matrix. */
export function clamp01(x: number): number {
  return x > 1 ? 1 : x > 0 ? x : 0;
}

function fail(input: string, why: string): never {
  throw new MdvConfigError(`Cannot parse color ${JSON.stringify(input)}: ${why}`, 'theme.color');
}

/** Split a CSS function's argument list on commas and/or whitespace, honouring `/`. */
function splitArgs(body: string): { positional: string[]; alpha: string | undefined } {
  const slash = body.indexOf('/');
  const head = slash === -1 ? body : body.slice(0, slash);
  const tail = slash === -1 ? undefined : body.slice(slash + 1).trim();
  const positional = head
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tail !== undefined) return { positional, alpha: tail };
  // Legacy comma syntax puts alpha in the fourth positional slot.
  if (positional.length === 4) {
    const last = positional[3];
    return { positional: positional.slice(0, 3), alpha: last };
  }
  return { positional, alpha: undefined };
}

/** A number, or a percentage resolved against `full`. */
function scalar(token: string, full: number, input: string): number {
  const pct = token.endsWith('%');
  const n = Number.parseFloat(pct ? token.slice(0, -1) : token);
  if (!Number.isFinite(n)) fail(input, `"${token}" is not a number`);
  return pct ? (n / 100) * full : n;
}

function alphaOf(token: string | undefined, input: string): number {
  if (token === undefined || token === 'none') return 1;
  return clamp01(scalar(token, 1, input));
}

/** An angle in degrees; `deg`, `rad`, `grad` and `turn` are all accepted. */
function angle(token: string, input: string): number {
  const m = /^(-?[\d.]+(?:e[+-]?\d+)?)(deg|rad|grad|turn)?$/i.exec(token.trim());
  if (m === null) fail(input, `"${token}" is not an angle`);
  const n = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(n)) fail(input, `"${token}" is not an angle`);
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'rad':
      return (n * 180) / Math.PI;
    case 'grad':
      return n * 0.9;
    case 'turn':
      return n * 360;
    default:
      return n;
  }
}

function hueToRgb(p: number, q: number, tRaw: number): number {
  let t = tRaw;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * Parse any color string a theme may carry: `#rgb`, `#rgba`, `#rrggbb`,
 * `#rrggbbaa`, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`, `oklab()`,
 * `transparent`, and the CSS named colors.
 *
 * @throws MdvConfigError when the string is not a color this implementation knows.
 */
export function parseColor(input: string): Rgb {
  const s = input.trim();
  if (s.length === 0) fail(input, 'empty string');
  const lower = s.toLowerCase();

  if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const named = NAMED_COLORS[lower];
  if (named !== undefined) return parseColor(named);

  if (s.charCodeAt(0) === 0x23 /* # */) return parseHex(s);

  const fn = FUNC.exec(s);
  if (fn === null) fail(input, 'unrecognised syntax');
  const name = (fn[1] ?? '').toLowerCase();
  const { positional, alpha } = splitArgs(fn[2] ?? '');
  const a = alphaOf(alpha, input);
  const [p0 = '', p1 = '', p2 = ''] = positional;
  if (positional.length < 3) fail(input, `${name}() needs three components`);

  switch (name) {
    case 'rgb':
    case 'rgba': {
      // Modern `rgb(r g b)` takes 0…255 numbers or percentages; both resolve here.
      const r = p0.endsWith('%') ? scalar(p0, 1, input) : scalar(p0, 255, input) / 255;
      const g = p1.endsWith('%') ? scalar(p1, 1, input) : scalar(p1, 255, input) / 255;
      const b = p2.endsWith('%') ? scalar(p2, 1, input) : scalar(p2, 255, input) / 255;
      return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a };
    }
    case 'hsl':
    case 'hsla': {
      const h = (((angle(p0, input) % 360) + 360) % 360) / 360;
      const sat = clamp01(scalar(p1, 1, input) / (p1.endsWith('%') ? 1 : 100));
      const l = clamp01(scalar(p2, 1, input) / (p2.endsWith('%') ? 1 : 100));
      if (sat === 0) return { r: l, g: l, b: l, a };
      const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
      const p = 2 * l - q;
      return {
        r: clamp01(hueToRgb(p, q, h + 1 / 3)),
        g: clamp01(hueToRgb(p, q, h)),
        b: clamp01(hueToRgb(p, q, h - 1 / 3)),
        a,
      };
    }
    case 'oklab': {
      const L = p0.endsWith('%') ? scalar(p0, 1, input) : scalar(p0, 1, input);
      const A = p1.endsWith('%') ? scalar(p1, 0.4, input) : scalar(p1, 1, input);
      const B = p2.endsWith('%') ? scalar(p2, 0.4, input) : scalar(p2, 1, input);
      return withAlpha(oklabToRgbLocal(L, A, B), a);
    }
    case 'oklch': {
      const L = p0.endsWith('%') ? scalar(p0, 1, input) : scalar(p0, 1, input);
      const C = p1.endsWith('%') ? scalar(p1, 0.4, input) : scalar(p1, 1, input);
      const h = (angle(p2, input) * Math.PI) / 180;
      return withAlpha(oklabToRgbLocal(L, C * Math.cos(h), C * Math.sin(h)), a);
    }
    default:
      return fail(input, `unsupported color function ${name}()`);
  }
}

function withAlpha(c: { r: number; g: number; b: number }, a: number): Rgb {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a };
}

/**
 * OKLab → sRGB, duplicated here (rather than imported from `./oklab.js`) to keep
 * the module graph acyclic: `oklab.ts` imports the parser.
 */
function oklabToRgbLocal(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: encodeGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encodeGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encodeGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/**
 * sRGB transfer function, linear → non-linear.
 *
 * Sign-symmetric: out-of-gamut negatives arise routinely in the middle of an
 * OKLab round-trip, and folding them to zero here would hide the excursion from
 * {@link inGamut} instead of letting the ramp generator correct it.
 */
export function encodeGamma(c: number): number {
  const sign = c < 0 ? -1 : 1;
  const x = Math.abs(c);
  return sign * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
}

/** sRGB transfer function, non-linear → linear. Sign-symmetric, as above. */
export function decodeGamma(c: number): number {
  const sign = c < 0 ? -1 : 1;
  const x = Math.abs(c);
  return sign * (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
}

function parseHex(s: string): Rgb {
  const h8 = HEX8.exec(s);
  if (h8 !== null) {
    return {
      r: Number.parseInt(h8[1] ?? '', 16) / 255,
      g: Number.parseInt(h8[2] ?? '', 16) / 255,
      b: Number.parseInt(h8[3] ?? '', 16) / 255,
      a: Number.parseInt(h8[4] ?? '', 16) / 255,
    };
  }
  const h6 = HEX6.exec(s);
  if (h6 !== null) {
    return {
      r: Number.parseInt(h6[1] ?? '', 16) / 255,
      g: Number.parseInt(h6[2] ?? '', 16) / 255,
      b: Number.parseInt(h6[3] ?? '', 16) / 255,
      a: 1,
    };
  }
  const h4 = HEX4.exec(s);
  if (h4 !== null) {
    const d = (t: string): number => Number.parseInt(t + t, 16) / 255;
    return { r: d(h4[1] ?? ''), g: d(h4[2] ?? ''), b: d(h4[3] ?? ''), a: d(h4[4] ?? '') };
  }
  const h3 = HEX3.exec(s);
  if (h3 !== null) {
    const d = (t: string): number => Number.parseInt(t + t, 16) / 255;
    return { r: d(h3[1] ?? ''), g: d(h3[2] ?? ''), b: d(h3[3] ?? ''), a: 1 };
  }
  return fail(s, 'malformed hex');
}

/** Byte-quantise one channel, round-half-away-from-zero, clamped. */
function byte(c: number): number {
  const n = Math.round(clamp01(c) * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Serialise to lowercase `#rrggbb`, or `#rrggbbaa` when `a < 1`.
 *
 * The canonical output form for generated ramps: hex is what the theme tables in
 * SPEC 11 use, and a stable spelling keeps golden files stable.
 */
export function formatHex(c: Rgb): string {
  const hx = (n: number): string => n.toString(16).padStart(2, '0');
  const base = `#${hx(byte(c.r))}${hx(byte(c.g))}${hx(byte(c.b))}`;
  return c.a >= 1 ? base : `${base}${hx(byte(c.a))}`;
}

/**
 * Composite a possibly-translucent color over an opaque backdrop (source-over).
 *
 * Contrast and CVD are only meaningful for what the eye actually receives, so
 * every check composites first. Compositing is done in **linear** light, which is
 * what the physical mixture does.
 */
export function over(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return { ...fg, a: 1 };
  const a = fg.a;
  const mix = (f: number, b: number): number =>
    encodeGamma(decodeGamma(f) * a + decodeGamma(b) * (1 - a));
  return {
    r: clamp01(mix(fg.r, bg.r)),
    g: clamp01(mix(fg.g, bg.g)),
    b: clamp01(mix(fg.b, bg.b)),
    a: 1,
  };
}

/** True when every channel is inside `0…1` — i.e. the color is inside the sRGB gamut. */
export function inGamut(c: { r: number; g: number; b: number }, epsilon = 1e-6): boolean {
  return (
    c.r >= -epsilon &&
    c.r <= 1 + epsilon &&
    c.g >= -epsilon &&
    c.g <= 1 + epsilon &&
    c.b >= -epsilon &&
    c.b <= 1 + epsilon
  );
}
