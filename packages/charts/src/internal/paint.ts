/**
 * Paint, stroke and font construction from theme tokens (SPEC 11.1, 11.4).
 *
 * Mark specifications are **fixed across every chart type** (SPEC 11.4), which is
 * why they are read from `theme.marks` here rather than hard-coded per type: a
 * bar in one chart and a bar in another are the same object.
 *
 * > **Text never wears the data color** (SPEC 11.5). The only exception is a
 * > label set inside a colored fill, which picks white or ink by the fill's
 * > luminance — see {@link readableOn}.
 */

import type { ColorString, Font, Paint, SeriesDescriptor, Stroke, Theme } from '@mdv/core';
import { clamp } from './num.js';

/** A flat fill in the given color. */
export function solid(color: ColorString, opacity?: number): Paint {
  return opacity === undefined
    ? { kind: 'solid', color }
    : { kind: 'solid', color, opacity: clamp(opacity, 0, 1) };
}

/**
 * The fill for a series' marks: its color, or its texture tile when the texture
 * channel is on (SPEC 12.6). The series color still rides underneath as the
 * pattern's background, so a backend without pattern support degrades to the
 * right hue rather than to nothing.
 */
export function seriesFill(series: SeriesDescriptor, opacity?: number): Paint {
  if (series.patternDef !== undefined) {
    const paint: Paint = { kind: 'pattern', def: series.patternDef, background: series.color };
    return opacity === undefined ? paint : { ...paint, opacity: clamp(opacity, 0, 1) };
  }
  return solid(series.color, opacity);
}

/** The line mark: **2 px, round join and cap** (SPEC 11.4). */
export function lineStroke(
  theme: Theme,
  color: ColorString,
  width?: number,
  dash?: readonly number[],
): Stroke {
  const stroke: Stroke = {
    paint: solid(color),
    width: width ?? theme.marks.line.width,
    cap: theme.marks.line.cap,
    join: theme.marks.line.join,
  };
  if (dash !== undefined && dash.length > 0) stroke.dash = [...dash];
  return stroke;
}

/**
 * The **surface ring** (SPEC 11.4): 2 px of surface color around dots and end
 * markers so they stay legible where they cross a line or each other.
 *
 * This is not a border on the mark — it is the surface showing through, which is
 * why it is painted in the surface token and never in the series color.
 */
export function surfaceRing(theme: Theme): Stroke {
  return {
    paint: solid(theme.tokens.surface),
    width: theme.marks.spacer.surfaceRing,
    cap: 'round',
    join: 'round',
  };
}

/** The hairline used by annotation rules. Solid unless the author asked for dashes. */
export function chromeStroke(theme: Theme, dashed: boolean): Stroke {
  const stroke: Stroke = {
    paint: solid(theme.tokens.border),
    width: theme.metrics.hairline,
    cap: 'butt',
    join: 'miter',
  };
  if (dashed) stroke.dash = [4, 3];
  return stroke;
}

/** The base label font. */
export function labelFont(theme: Theme, scale = 1, weight?: number): Font {
  const font: Font = {
    family: theme.type.fontFamily,
    size: Math.max(1, theme.type.fontSize * scale),
  };
  if (weight !== undefined) font.weight = weight;
  return font;
}

/** The tick/legend font (SPEC 11.1 `tickScale`). */
export function tickFont(theme: Theme): Font {
  return labelFont(theme, theme.type.tickScale);
}

// ─────────────────────────────────────────────────────────────────────────────
// Luminance
// ─────────────────────────────────────────────────────────────────────────────

/** Parse `#rgb`, `#rrggbb` or `rgb(r, g, b)` into 0–255 components. */
function parseColor(color: ColorString): [number, number, number] | undefined {
  const text = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    if (digits.length === 3) {
      const r = digits[0] ?? '0';
      const g = digits[1] ?? '0';
      const b = digits[2] ?? '0';
      return [Number.parseInt(r + r, 16), Number.parseInt(g + g, 16), Number.parseInt(b + b, 16)];
    }
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (rgb !== null) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r, g, b];
  }
  return undefined;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(color: ColorString): number {
  const parsed = parseColor(color);
  if (parsed === undefined) return 0.5;
  const channel = (value: number): number => {
    const c = clamp(value, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(parsed[0]) + 0.7152 * channel(parsed[1]) + 0.0722 * channel(parsed[2]);
}

/**
 * Pick white or ink for a label sitting **inside** a colored fill (SPEC 11.5).
 *
 * This is the one place text may be chosen by the data color, and even here the
 * text is never *tinted* — it is one of two fixed values.
 */
export function readableOn(theme: Theme, fill: ColorString): ColorString {
  return relativeLuminance(fill) > 0.45 ? theme.tokens['text-primary'] : '#ffffff';
}
