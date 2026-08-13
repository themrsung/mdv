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
import { sampleRamp } from '@mdv/core';
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

/**
 * A gridline or axis rule: **one step off surface, 1 px hairline, solid, never
 * dashed, recessive** (SPEC 11.4).
 *
 * Core owns the gridlines of a cartesian chart, because it owns the axes they
 * belong to. A polar grid has no {@link AxisModel} to hang off, so the one chart
 * that has one draws it — and it must draw it to the same specification, which
 * is why the numbers come from here rather than from that chart.
 *
 * @param role - `grid` for a ring or a gridline, `axis` for a spoke or a
 * baseline: the axis token is the darker of the two, so the line a reader
 * measures *along* stays distinguishable from the ones they measure *against*.
 */
export function gridStroke(theme: Theme, role: 'grid' | 'axis' = 'grid'): Stroke {
  return {
    paint: solid(role === 'axis' ? theme.tokens.axis : theme.tokens.grid),
    width: theme.marks.grid.width,
    cap: 'butt',
    join: 'miter',
  };
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

/**
 * WCAG contrast between two opaque colors, `1…21`.
 *
 * The statistic SPEC 16.4's validator computes, over the luminance
 * {@link relativeLuminance} already derives for {@link readableOn}. Theme colors
 * are opaque, so there is nothing to composite first.
 */
export function contrastRatio(a: ColorString, b: ColorString): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/**
 * The contrast a ramp step must clear against its own surface (SPEC 11.3).
 *
 * The same number `@mdv/themes` calls `ORDINAL_RAMP_CONTRAST_MIN` and the same
 * one SPEC 16.4's validator enforces. It is restated rather than imported
 * because `@mdv/charts` does not depend on `@mdv/themes` — a chart type is
 * handed a {@link Theme}, not the machinery that built one.
 */
export const ORDINAL_CONTRAST_MIN = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Ordinal ramps (SPEC 11.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The band of ramp steps an **ordered set of discrete marks** may use, ordered
 * nearest the surface first.
 *
 * SPEC 11.3 sets the rule these two functions exist to keep:
 *
 * > **Ordinal ramps** (discrete ordered marks: funnel stages, tiers) must keep
 * > the step nearest the surface at ≥ 2:1 — on light, start no lighter than step
 * > 250 (`#86b6ef`); on dark, go no darker than step 600 (`#184f95`).
 *
 * Steps run light → dark, so "away from the surface" is *darker* on a light
 * scheme and *lighter* on a dark one, and the theme's declared band
 * (`ordinalFloor` / `ordinalCeiling`) is read from whichever end faces the page.
 *
 * That declared index is a **starting hint, not an answer**. `@mdv/themes`
 * derives it by running exactly this check, but SPEC 11.6 lets an author
 * hand-write a palette and a hand-written one can declare a floor its own ramp
 * never earned. SPEC 16.4 is explicit that "palette safety is computed, never
 * eyeballed" — so it is computed here, on the theme actually in hand, and the
 * search walks away from the surface until the floor is really cleared. A ramp
 * where nothing clears it degrades to its single closest step rather than to a
 * band of marks that all vanish into the page.
 */
export function ordinalWindow(theme: Theme): readonly ColorString[] {
  const ramp = theme.sequential;
  const steps = ramp.steps;
  const last = steps.length - 1;
  if (last < 0) return [ramp.hue];

  const dark = theme.scheme === 'dark';
  const surface = theme.tokens.surface;
  const declared = clamp(Math.trunc(dark ? ramp.ordinalCeiling : ramp.ordinalFloor), 0, last);
  const far = clamp(Math.trunc(dark ? ramp.ordinalFloor : ramp.ordinalCeiling), 0, last);
  const step = dark ? -1 : 1;

  let near = declared;
  for (let i = declared; i >= 0 && i <= last; i += step) {
    const candidate = steps[i];
    if (candidate === undefined) continue;
    near = i;
    if (contrastRatio(candidate, surface) >= ORDINAL_CONTRAST_MIN) break;
  }

  // The recomputed near step can walk *past* the far end — a ramp whose deep end
  // is the only thing clearing 2:1 has a band of one.
  if (dark ? near <= far : near >= far) return [steps[near] ?? ramp.hue];

  const window: ColorString[] = [];
  for (let i = near; dark ? i >= far : i <= far; i += step) {
    const color = steps[i];
    if (color !== undefined) window.push(color);
  }
  return window.length > 0 ? window : [ramp.hue];
}

/**
 * `count` colors for `count` ordered marks, **deepening away from the surface**.
 *
 * The first mark is the one nearest the page and the last is the deepest, which
 * is the direction the reader already reads as "further along": a funnel's last
 * stage is its smallest, and a small mark needs the extra contrast anyway.
 *
 * Sampling rather than indexing means more marks than steps interpolates
 * between them instead of repeating a color, and a lone mark takes the deep end
 * — the same convention `internal/ramp`'s classed scales use for one class.
 */
export function ordinalRamp(theme: Theme, count: number): ColorString[] {
  const window = ordinalWindow(theme);
  const n = Math.max(0, Math.trunc(count));
  const out: ColorString[] = [];
  for (let i = 0; i < n; ++i) out.push(sampleRamp(window, n === 1 ? 1 : i / (n - 1)));
  return out;
}
