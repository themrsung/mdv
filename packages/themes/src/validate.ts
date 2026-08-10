/**
 * The executable palette validator (SPEC 16.4).
 *
 * > Palette safety is computed, never eyeballed.
 *
 * A conforming implementation MUST ship one of these and MUST run it in CI over
 * the built-in themes and over any theme fixture. This one is real: OKLab is
 * Ottosson's transform, contrast is WCAG 2.x with alpha composited over the
 * actual surface, and colour-vision deficiency is a Brettel–Viénot–Mollon (1997)
 * simulation. Nothing is looked up from a table of pre-blessed hexes.
 *
 * The checks, per mode and against **that mode's actual surface**:
 *
 * | Check | Threshold | Level when breached |
 * |---|---|---|
 * | `normal-vision` | ΔE ≥ 15 | `fail` — stated as a hard fail by SPEC 16.4 |
 * | `adjacent-cvd` / `all-pairs-cvd` | ΔE ≥ 8 | `warn` at 6–8, `fail` below 6 |
 * | `surface-contrast` | 3:1 (WCAG 1.4.11) | `warn`, and the slot joins `reliefRequiredSlots` |
 * | `lightness-band` | scheme-specific OKLab L window | `warn` |
 * | `chroma-floor` | OKLab C ≥ 0.10 | `warn` |
 *
 * Two of those levels deserve their justification in writing.
 *
 * **Why 6–8 is `warn` and below 6 is `fail`.** SPEC 16.4 says 6–8 is "legal only
 * with secondary encoding". The validator cannot see whether a block ships a
 * secondary encoding, so it reports the band and lets the caller decide; below 6
 * no secondary encoding rescues the pair, so that is a fail.
 *
 * **Why contrast is `warn` but not dismissable.** A slot under 3:1 is legal *if*
 * the block ships visible direct labels or the table view — SPEC 11.2 rule 4's
 * relief rule. That is an obligation, not a suggestion, which is why the slot is
 * also listed in {@link PaletteValidation.reliefRequiredSlots} rather than only
 * mentioned in a message. Three light-mode slots (aqua, yellow, magenta) are
 * under 3:1 **by design**; the built-in light theme therefore always reports
 * three relief-required slots, and that is a pass, not a regression.
 */

import type {
  CategoricalPalette,
  ColorScheme,
  ColorString,
  PaletteFinding,
  PaletteValidation,
} from '@mdv/core';
import { contrastRatioRgb, GRAPHIC_CONTRAST_MIN } from './color/contrast.js';
import type { CvdType } from './color/cvd.js';
import { simulateCvd } from './color/cvd.js';
import { deltaEOklabRgb, oklabToOklch, rgbToOklab } from './color/oklab.js';
import type { Rgb } from './color/rgb.js';
import { over, parseColor } from './color/rgb.js';

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Target adjacent-pair separation under CVD, OKLab ΔE ×100 (SPEC 16.4). */
export const CVD_TARGET_DELTA_E = 8;

/** Below this, no secondary encoding rescues the pair (SPEC 16.4). */
export const CVD_FLOOR_DELTA_E = 6;

/** The normal-vision floor. A hard fail (SPEC 16.4). */
export const NORMAL_VISION_DELTA_E = 15;

/** OKLab chroma floor: below this a "hue" reads as a disabled gray, not an identity. */
export const CHROMA_FLOOR = 0.1;

/**
 * The OKLab lightness window each scheme's slots must sit inside.
 *
 * The band does two jobs: it keeps every slot far enough from the surface to be
 * seen, and — the reason it is a *band* and not a floor — it keeps the slots at
 * **equal loudness**, so no series shouts merely because of its colour. The
 * windows below bracket the spec's own selected palettes (light 0.433…0.764,
 * dark 0.529…0.670) with roughly one band-step of margin on each side.
 */
export const LIGHTNESS_BAND: Readonly<
  Record<ColorScheme, { readonly min: number; readonly max: number }>
> = Object.freeze({
  light: Object.freeze({ min: 0.4, max: 0.8 }),
  dark: Object.freeze({ min: 0.5, max: 0.85 }),
});

/**
 * The dichromacies the separation gate is computed over.
 *
 * Protanopia and deuteranopia only — and that is deliberate, not an omission.
 * They are the red–green axis that hue ordering *can* fix, and they account for
 * roughly 8 % of men. Tritanopia is a blue–yellow axis affecting about 0.008 %
 * of people, and no ordering of eight distinguishable hues clears it; SPEC 12.6's
 * texture channel is the answer there, not a different palette. Computing the
 * gate over these two reproduces the separation figures SPEC 11.2 rule 3
 * publishes for its own palette (worst adjacent ΔE 9.1 light / 8.4 dark; worst
 * first-three pair 9.2 light / 9.4 dark) to within their quoted precision.
 *
 * Pass `includeTritanopia` to {@link validatePalette} to fold it in anyway; be
 * aware that the spec's own palette does not clear the gate under it.
 */
export const GATED_CVD_TYPES: readonly CvdType[] = Object.freeze(['protanopia', 'deuteranopia']);

/** Options for {@link validatePalette}. */
export interface PaletteValidationOptions {
  /**
   * Check every pair rather than only adjacent pairs, for forms where any two
   * series can appear side by side — scatter, bubble, choropleth, small
   * multiples (SPEC 11.2 rule 3, SPEC 8.6). @defaultValue false
   */
  allPairs?: boolean;
  /**
   * Fold tritanopia into the CVD gate. Off by default; see {@link GATED_CVD_TYPES}.
   * @defaultValue false
   */
  includeTritanopia?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Round to 2 decimals, half-up, so findings are stable across platforms. */
function round2(n: number): number {
  return Math.round(n * 100 + Number.EPSILON) / 100;
}

/** The minimum separation of a pair across the gated dichromacies. */
function worstCvdSeparation(a: Rgb, b: Rgb, types: readonly CvdType[]): number {
  let worst = Number.POSITIVE_INFINITY;
  for (const t of types) {
    const d = deltaEOklabRgb(simulateCvd(a, t), simulateCvd(b, t));
    if (d < worst) worst = d;
  }
  return worst === Number.POSITIVE_INFINITY ? 0 : worst;
}

// ─────────────────────────────────────────────────────────────────────────────
// The validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a categorical palette against one scheme's actual surface.
 *
 * Order matters: the checks are per *adjacent* pair, so a re-ordered palette is a
 * different palette and MUST be re-validated (SPEC 11.2 rule 5).
 *
 * Findings come back in a fixed order — per-slot checks first, in slot order,
 * then per-pair checks, in pair order — so two runs over the same input produce
 * identical arrays and a diff of two validations is meaningful.
 *
 * @param palette - the ordered slots to check
 * @param surface - the surface colour the palette will sit on
 * @param scheme - which mode's lightness band applies
 */
export function validatePalette(
  palette: CategoricalPalette,
  surface: ColorString,
  scheme: ColorScheme,
  options: PaletteValidationOptions | boolean = {},
): PaletteValidation {
  // Historically this argument was a bare `allPairs` boolean; accept both so a
  // caller written against the older shape keeps working.
  const opts: PaletteValidationOptions =
    typeof options === 'boolean' ? { allPairs: options } : options;
  const allPairs = opts.allPairs ?? false;
  const types =
    opts.includeTritanopia === true
      ? ([...GATED_CVD_TYPES, 'tritanopia'] as const satisfies readonly CvdType[])
      : GATED_CVD_TYPES;

  const surfaceRgb = parseColor(surface);
  // Every slot is judged as the eye receives it: composited onto the surface.
  const slots: Rgb[] = palette.map((c) => over(parseColor(c), surfaceRgb));

  const findings: PaletteFinding[] = [];
  const relief: number[] = [];
  const band = LIGHTNESS_BAND[scheme];

  // ── Per-slot checks, in slot order ────────────────────────────────────────
  for (let i = 0; i < slots.length; i += 1) {
    const rgb = slots[i];
    if (rgb === undefined) continue;
    const lch = oklabToOklch(rgbToOklab(rgb));

    if (lch.L < band.min || lch.L > band.max) {
      const overshoot = lch.L < band.min ? band.min : band.max;
      findings.push({
        check: 'lightness-band',
        slots: [i],
        measured: round2(lch.L),
        threshold: overshoot,
        level: 'warn',
        message: `Slot ${i} has OKLab lightness ${lch.L.toFixed(3)}, outside the ${scheme} band ${band.min}–${band.max}; it will not carry the same visual weight as its neighbours`,
      });
    }

    if (lch.C < CHROMA_FLOOR) {
      findings.push({
        check: 'chroma-floor',
        slots: [i],
        measured: round2(lch.C),
        threshold: CHROMA_FLOOR,
        level: 'warn',
        message: `Slot ${i} has OKLab chroma ${lch.C.toFixed(3)}, below the ${CHROMA_FLOOR} floor; a near-neutral slot reads as "no data" rather than as an identity`,
      });
    }
  }

  // ── Surface contrast, in slot order ───────────────────────────────────────
  for (let i = 0; i < slots.length; i += 1) {
    const rgb = slots[i];
    if (rgb === undefined) continue;
    const ratio = contrastRatioRgb(rgb, surfaceRgb);
    if (ratio < GRAPHIC_CONTRAST_MIN) {
      relief.push(i);
      findings.push({
        check: 'surface-contrast',
        slots: [i],
        measured: round2(ratio),
        threshold: GRAPHIC_CONTRAST_MIN,
        level: 'warn',
        message: `Slot ${i} is ${ratio.toFixed(2)}:1 against the ${scheme} surface, below 3:1; blocks using it MUST ship visible direct labels or the table view (MDV3081)`,
      });
    }
  }

  // ── Pair checks, in pair order ────────────────────────────────────────────
  for (let i = 0; i < slots.length; i += 1) {
    const a = slots[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < slots.length; j += 1) {
      const adjacent = j === i + 1;
      if (!adjacent && !allPairs) continue;
      const b = slots[j];
      if (b === undefined) continue;
      const check = adjacent ? 'adjacent-cvd' : 'all-pairs-cvd';

      const normal = deltaEOklabRgb(a, b);
      if (normal < NORMAL_VISION_DELTA_E) {
        findings.push({
          check: 'normal-vision',
          slots: [i, j],
          measured: round2(normal),
          threshold: NORMAL_VISION_DELTA_E,
          level: 'fail',
          message: `Slots ${i} and ${j} are only ΔE ${normal.toFixed(1)} apart in OKLab for normal vision, below the hard floor of ${NORMAL_VISION_DELTA_E}`,
        });
      }

      const cvd = worstCvdSeparation(a, b, types);
      if (cvd < CVD_TARGET_DELTA_E) {
        const hard = cvd < CVD_FLOOR_DELTA_E;
        findings.push({
          check,
          slots: [i, j],
          measured: round2(cvd),
          threshold: CVD_TARGET_DELTA_E,
          level: hard ? 'fail' : 'warn',
          message: hard
            ? `Slots ${i} and ${j} collapse to ΔE ${cvd.toFixed(1)} under red–green colour-vision deficiency, below the floor of ${CVD_FLOOR_DELTA_E}; no secondary encoding rescues this pair`
            : `Slots ${i} and ${j} separate by only ΔE ${cvd.toFixed(1)} under red–green colour-vision deficiency; legal only where a secondary encoding (shape, texture, direct labels) is present`,
        });
      }
    }
  }

  return {
    scheme,
    passed: !findings.some((f) => f.level === 'fail'),
    findings,
    reliefRequiredSlots: relief,
  };
}

/**
 * WCAG 2.x contrast ratio between two colours, `1…21`, with a translucent
 * argument composited over the other first (SPEC 12.5).
 */
export function contrastRatio(a: ColorString, b: ColorString): number {
  return contrastRatioRgb(parseColor(a), parseColor(b));
}

/** Perceptual distance in OKLab, scaled ×100 to match the SPEC 16.4 thresholds. */
export function deltaEOklab(a: ColorString, b: ColorString): number {
  return deltaEOklabRgb(parseColor(a), parseColor(b));
}

/**
 * The worst separation of any gated pair, under normal vision and under CVD.
 *
 * Exposed because it is the statistic SPEC 11.2 rule 3 quotes, and a palette
 * author tuning an ordering wants the number rather than a list of findings.
 */
export function paletteSeparation(
  palette: CategoricalPalette,
  surface: ColorString,
  options: PaletteValidationOptions = {},
): { worstNormal: number; worstCvd: number } {
  const surfaceRgb = parseColor(surface);
  const slots = palette.map((c) => over(parseColor(c), surfaceRgb));
  const types =
    options.includeTritanopia === true
      ? ([...GATED_CVD_TYPES, 'tritanopia'] as const satisfies readonly CvdType[])
      : GATED_CVD_TYPES;
  let worstNormal = Number.POSITIVE_INFINITY;
  let worstCvd = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slots.length; i += 1) {
    const a = slots[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < slots.length; j += 1) {
      if (j !== i + 1 && options.allPairs !== true) continue;
      const b = slots[j];
      if (b === undefined) continue;
      worstNormal = Math.min(worstNormal, deltaEOklabRgb(a, b));
      worstCvd = Math.min(worstCvd, worstCvdSeparation(a, b, types));
    }
  }
  return {
    worstNormal: Number.isFinite(worstNormal) ? worstNormal : 0,
    worstCvd: Number.isFinite(worstCvd) ? worstCvd : 0,
  };
}
