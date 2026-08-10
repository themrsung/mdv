/**
 * `ColorString` → device RGB, for the PDF `rg`/`RG` operators.
 *
 * `@mdv/themes` has a fuller parser, but the PDF backend deliberately does not
 * depend on it (SPEC 17.2's dependency table): a renderer takes a resolved
 * `Scene` and nothing else. The forms accepted here are exactly the forms
 * `ColorString` documents.
 */

import { clamp } from './number.js';

/** Non-premultiplied device RGB, each channel 0…1, plus an alpha 0…1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Opaque black — what an unparseable color degrades to. */
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
/** Opaque white. */
export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

/**
 * The handful of CSS named colors a theme or an author may realistically reach
 * for. Not the full CSS list: a renderer that silently accepts `rebeccapurple`
 * but not `lightgoldenrodyellow` is worse than one with a stated, small set,
 * and `parseColor` reports the miss through {@link parseColorStrict}.
 */
const NAMED: Readonly<Record<string, string>> = {
  black: '#000000',
  white: '#ffffff',
  transparent: '#00000000',
  currentcolor: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  none: '#00000000',
};

function hexPair(text: string, at: number): number {
  const hi = text.charCodeAt(at);
  const lo = text.charCodeAt(at + 1);
  return (hexDigit(hi) * 16 + hexDigit(lo)) / 255;
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return 0;
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

function parseChannel(token: string): number {
  const text = token.trim();
  if (text.endsWith('%')) return clamp(Number.parseFloat(text) / 100, 0, 1);
  return clamp(Number.parseFloat(text) / 255, 0, 1);
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1;
  const text = token.trim();
  if (text === '') return 1;
  if (text.endsWith('%')) return clamp(Number.parseFloat(text) / 100, 0, 1);
  return clamp(Number.parseFloat(text), 0, 1);
}

/**
 * Parse a color, or `undefined` when the string is not one this backend knows.
 *
 * Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`,
 * `hsl()`/`hsla()` (both comma and space separated) and the small named set.
 */
export function parseColor(input: string): Rgba | undefined {
  const text = input.trim().toLowerCase();
  if (text === '') return undefined;

  const named = NAMED[text];
  if (named !== undefined) return parseColor(named);

  if (text.startsWith('#')) {
    const body = text.slice(1);
    if (!/^[0-9a-f]+$/.test(body)) return undefined;
    if (body.length === 3 || body.length === 4) {
      const expanded = [...body].map((c) => c + c).join('');
      return parseColor(`#${expanded}`);
    }
    if (body.length === 6) {
      return { r: hexPair(body, 0), g: hexPair(body, 2), b: hexPair(body, 4), a: 1 };
    }
    if (body.length === 8) {
      return {
        r: hexPair(body, 0),
        g: hexPair(body, 2),
        b: hexPair(body, 4),
        a: hexPair(body, 6),
      };
    }
    return undefined;
  }

  const fn = /^(rgba?|hsla?)\s*\(([^)]*)\)$/.exec(text);
  if (fn === null) return undefined;
  const name = fn[1];
  const body = fn[2];
  if (name === undefined || body === undefined) return undefined;
  const parts = body
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter((p) => p !== '');
  const [c0, c1, c2, c3] = parts;
  if (c0 === undefined || c1 === undefined || c2 === undefined) return undefined;

  if (name.startsWith('rgb')) {
    return { r: parseChannel(c0), g: parseChannel(c1), b: parseChannel(c2), a: parseAlpha(c3) };
  }

  const hue = (((Number.parseFloat(c0) % 360) + 360) % 360) / 360;
  const sat = clamp(Number.parseFloat(c1) / 100, 0, 1);
  const light = clamp(Number.parseFloat(c2) / 100, 0, 1);
  if (sat === 0) return { r: light, g: light, b: light, a: parseAlpha(c3) };
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  return {
    r: hueToRgb(p, q, hue + 1 / 3),
    g: hueToRgb(p, q, hue),
    b: hueToRgb(p, q, hue - 1 / 3),
    a: parseAlpha(c3),
  };
}

/**
 * Parse a color, degrading to black.
 *
 * A backend is total (SPEC 17.3 invariant 3): an unparseable color is not worth
 * failing a 50-page export over, and black is the one value that is never
 * mistaken for "it worked".
 */
export function parseColorOr(input: string, fallback: Rgba = BLACK): Rgba {
  return parseColor(input) ?? fallback;
}

/** Relative luminance, for the grayscale profile. */
export function luminance(c: Rgba): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Collapse to gray, preserving alpha. Used by `pdf.grayscale`. */
export function toGray(c: Rgba): Rgba {
  const y = luminance(c);
  return { r: y, g: y, b: y, a: c.a };
}
