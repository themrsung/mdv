/**
 * Ramp generation for sequential and diverging scales (SPEC 11.3).
 *
 * Two rules shape every function here:
 *
 * - **Sequential is one hue, light → dark.** Never a rainbow: a rainbow has no
 *   perceptual order, so cells cannot be ranked without the legend.
 * - **Diverging is two hues plus a neutral gray midpoint**, equal step counts per
 *   arm. Never a hue at the midpoint — zero must read as "nothing".
 *
 * Generation happens in OKLCh with hue held fixed, which is the whole reason for
 * using OKLab: a lightness sweep at constant hue stays the *same colour*, so the
 * ramp is monotone in perceived lightness and a reader can rank two cells
 * without the legend. Out-of-gamut steps lose chroma, never hue
 * ({@link gamutMap}).
 */

import type { ColorScheme, ColorString, DivergingPalette, SequentialPalette } from '@mdv/core';
import { contrastRatioRgb, ORDINAL_RAMP_CONTRAST_MIN } from './color/contrast.js';
import { gamutMap, oklabToOklch, rgbToOklab } from './color/oklab.js';
import { formatHex, over, parseColor } from './color/rgb.js';

/** Lightest and darkest OKLab L a generated one-hue ramp spans. */
const RAMP_L_LIGHTEST = 0.92;
const RAMP_L_DARKEST = 0.34;

/**
 * Generate an `n`-step one-hue ramp from an anchor colour, lightest → darkest.
 *
 * Chroma follows a shallow arc that peaks near the middle of the ramp and eases
 * off at both ends, which is how the hand-selected default ramp behaves: the
 * lightest and darkest steps of a real ramp are less saturated than its waist,
 * because the sRGB gamut narrows there anyway.
 *
 * @param anchor - the hue to build from; only its OKLCh hue and chroma are used
 * @param steps - how many steps; must be ≥ 2
 */
export function generateSequentialSteps(anchor: ColorString, steps: number): ColorString[] {
  const n = Math.max(2, Math.trunc(steps));
  const base = oklabToOklch(rgbToOklab(parseColor(anchor)));
  const out: ColorString[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const L = RAMP_L_LIGHTEST + (RAMP_L_DARKEST - RAMP_L_LIGHTEST) * t;
    // Arc peaking at t = 0.5: 1 at the waist, 0.55 at both ends.
    const arc = 1 - 0.45 * Math.abs(2 * t - 1);
    out.push(formatHex(gamutMap({ L, C: base.C * arc, h: base.h })));
  }
  return out;
}

/**
 * Index of the lightest step usable on `surface` at ≥ 2:1, and the darkest.
 *
 * SPEC 11.3's ordinal-ramp rule ("on light, start no lighter than step 250; on
 * dark, go no darker than step 600") is *derived* here rather than hard-coded —
 * run over the default blue ramp against the two built-in surfaces this returns
 * exactly index 3 and index 10, which are those two steps.
 */
export function ordinalBounds(
  steps: readonly ColorString[],
  surface: ColorString,
): { ordinalFloor: number; ordinalCeiling: number } {
  const surfaceRgb = parseColor(surface);
  let floor = 0;
  let ceiling = steps.length - 1;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (s === undefined) continue;
    if (contrastRatioRgb(over(parseColor(s), surfaceRgb), surfaceRgb) >= ORDINAL_RAMP_CONTRAST_MIN) {
      floor = i;
      break;
    }
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const s = steps[i];
    if (s === undefined) continue;
    if (contrastRatioRgb(over(parseColor(s), surfaceRgb), surfaceRgb) >= ORDINAL_RAMP_CONTRAST_MIN) {
      ceiling = i;
      break;
    }
  }
  // A degenerate ramp (nothing clears 2:1) still yields a well-ordered pair.
  if (floor > ceiling) return { ordinalFloor: 0, ordinalCeiling: steps.length - 1 };
  return { ordinalFloor: floor, ordinalCeiling: ceiling };
}

/** Assemble a {@link SequentialPalette} from explicit steps. */
export function sequentialFromSteps(
  hue: ColorString,
  steps: readonly ColorString[],
  surface: ColorString,
): SequentialPalette {
  const { ordinalFloor, ordinalCeiling } = ordinalBounds(steps, surface);
  return Object.freeze({ hue, steps: Object.freeze([...steps]), ordinalFloor, ordinalCeiling });
}

/** Generate a complete {@link SequentialPalette} from an anchor hue. */
export function generateSequential(
  hue: ColorString,
  steps: number,
  surface: ColorString,
): SequentialPalette {
  return sequentialFromSteps(hue, generateSequentialSteps(hue, steps), surface);
}

/**
 * Generate one arm of a diverging ramp, **from the midpoint outward**.
 *
 * The midpoint itself is not included: the returned array's first entry is the
 * step adjacent to it and the last is the extreme, so an arm of length `k` plus
 * the mid plus the mirrored arm forms a `2k + 1` ramp.
 *
 * **Each arm holds the arm's own hue for its whole length**, sweeping only
 * lightness and chroma. Interpolating hue *from* the midpoint would be a
 * mistake: a diverging midpoint is neutral by definition, so whatever residual
 * chroma its gray happens to carry (`#383835` is faintly yellow) is not a hue
 * the ramp should travel through. Doing that turns a blue↔red ramp into
 * blue→cyan→green→gray→olive→red, which reads as a rainbow — exactly the thing
 * SPEC 11.3 forbids, arrived at from the other direction.
 */
function divergingArm(mid: ColorString, end: ColorString, steps: number): ColorString[] {
  const n = Math.max(1, Math.trunc(steps));
  const m = oklabToOklch(rgbToOklab(parseColor(mid)));
  const e = oklabToOklch(rgbToOklab(parseColor(end)));

  const out: ColorString[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    out.push(
      formatHex(
        gamutMap({
          L: m.L + (e.L - m.L) * t,
          // Chroma grows from the neutral midpoint, never from the gray's own.
          C: e.C * t,
          h: e.h,
        }),
      ),
    );
  }
  return out;
}

/**
 * Build a {@link DivergingPalette}: two hues plus a neutral gray midpoint, equal
 * step counts per arm (SPEC 11.3).
 *
 * `lowSteps` reads **left to right**, from the low extreme in towards the
 * midpoint; `highSteps` continues from the midpoint out to the high extreme. So
 * `[...lowSteps, mid, ...highSteps]` is the ramp in display order, which is the
 * only ordering a consumer can use without knowing this function's conventions.
 */
export function generateDiverging(
  low: ColorString,
  high: ColorString,
  mid: ColorString,
  stepsPerArm: number,
): DivergingPalette {
  const lowOut = divergingArm(mid, low, stepsPerArm);
  const highOut = divergingArm(mid, high, stepsPerArm);
  return Object.freeze({
    low,
    high,
    mid,
    lowSteps: Object.freeze([...lowOut].reverse()),
    highSteps: Object.freeze(highOut),
  });
}

/**
 * Shift a colour's OKLab lightness towards (or away from) the surface, holding
 * hue and chroma. The primitive behind tone-on-tone textures and behind the
 * high-contrast palette's darkening pass.
 *
 * @param amount - signed OKLab L delta; positive lightens
 */
export function shiftLightness(color: ColorString, amount: number): ColorString {
  const c = oklabToOklch(rgbToOklab(parseColor(color)));
  const L = Math.min(1, Math.max(0, c.L + amount));
  return formatHex(gamutMap({ L, C: c.C, h: c.h }));
}

/**
 * Darken (on light) or lighten (on dark) a colour, hue-preserving, until it
 * clears `target` contrast against the surface.
 *
 * Deterministic: a fixed 40-step sweep in OKLab lightness, not a
 * tolerance-driven loop. Returns the input unchanged when it already clears, and
 * the best step found when the target is unreachable inside the gamut — never a
 * silent black.
 *
 * The ratio is measured on the **8-bit quantised** candidate, not on the float
 * one. Quantisation costs a few thousandths of a ratio point, which is enough to
 * turn an accepted 3.0004 into a shipped 2.99 — a palette that misses the
 * threshold it was generated to hit.
 */
export function raiseContrast(
  color: ColorString,
  surface: ColorString,
  target: number,
  scheme: ColorScheme,
): ColorString {
  const surfaceRgb = parseColor(surface);
  const start = parseColor(color);
  let best = formatHex(over(start, surfaceRgb));
  let bestRatio = contrastRatioRgb(parseColor(best), surfaceRgb);
  if (bestRatio >= target) return color;

  const c = oklabToOklch(rgbToOklab(start));
  const direction = scheme === 'light' ? -1 : 1;
  const span = direction < 0 ? c.L : 1 - c.L;

  for (let i = 1; i <= 40; i += 1) {
    const L = c.L + direction * (i / 40) * span;
    const hex = formatHex(gamutMap({ L, C: c.C, h: c.h }));
    const ratio = contrastRatioRgb(parseColor(hex), surfaceRgb);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = hex;
    }
    if (ratio >= target) return hex;
  }
  return best;
}

/** The OKLab lightness of a colour — used to decide ink-vs-surface label colour. */
export function lightnessOf(color: ColorString): number {
  return rgbToOklab(parseColor(color)).L;
}

/**
 * Pick white or ink for a label set **inside** a colored fill (SPEC 11.5's one
 * exception to "text never wears the data color"), by the fill's luminance.
 */
export function labelOnFill(fill: ColorString, ink: ColorString, paper: ColorString): ColorString {
  const f = parseColor(fill);
  return contrastRatioRgb(parseColor(ink), f) >= contrastRatioRgb(parseColor(paper), f) ? ink : paper;
}

/** Convert any accepted colour spelling to canonical lowercase hex. */
export function toHex(color: ColorString): ColorString {
  return formatHex(parseColor(color));
}
