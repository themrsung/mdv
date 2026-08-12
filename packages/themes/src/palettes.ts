/**
 * The normative palettes of SPEC 11.2, 11.3 and 11.3.1.
 *
 * Data only. Everything here is quoted verbatim from the spec's tables; the
 * *reasons* these particular values were selected are computed, not asserted —
 * see `validate.ts` and `test/palette.test.ts`, which re-derive the spec's own
 * published separation figures from these hexes.
 */

import type { CategoricalPalette, ColorScheme, ColorString } from '@mdv/core';

/**
 * The eight categorical slots for the light surface (SPEC 11.2), in their fixed
 * order. **Never cycled**: a ninth series folds into "Other" (`MDV3062`).
 *
 * blue · orange · aqua · yellow · magenta · green · violet · red
 */
export const CATEGORICAL_LIGHT: CategoricalPalette = Object.freeze([
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
]);

/** The eight categorical slots for the dark surface (SPEC 11.2). */
export const CATEGORICAL_DARK: CategoricalPalette = Object.freeze([
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
]);

/**
 * Human-readable hue names for the eight slots, for diagnostics and legends.
 *
 * Defined in `@mdv/core` and re-exported here: the names index into
 * {@link CategoricalPalette}, so they belong with the palette contract rather
 * than with the built-in themes, and `@mdv/charts` resolves `scheme: blue`
 * against them without taking a dependency on this package.
 */
export { CATEGORICAL_HUE_NAMES } from '@mdv/core';

/**
 * The default sequential ramp: **one hue, light → dark**, steps 100 → 700 in
 * increments of 50 (SPEC 11.3). Never a rainbow — a rainbow has no perceptual
 * order, so cells cannot be ranked without the legend.
 */
export const SEQUENTIAL_BLUE: readonly ColorString[] = Object.freeze([
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
]);

/** The numeric step labels of {@link SEQUENTIAL_BLUE}, 100 → 700. */
export const SEQUENTIAL_STEP_LABELS: readonly number[] = Object.freeze([
  100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700,
]);

/**
 * The anchor hue a **second** concurrent sequential context takes (SPEC 11.3):
 * the next categorical hue, orange, as its own one-hue ramp.
 */
export const SEQUENTIAL_SECOND_HUE: Readonly<Record<ColorScheme, ColorString>> = Object.freeze({
  light: '#eb6834',
  dark: '#d95926',
});

/**
 * Diverging midpoints (SPEC 11.3). A **neutral gray** — never a hue at the
 * midpoint, because zero must read as "nothing".
 */
export const DIVERGING_MID: Readonly<Record<ColorScheme, ColorString>> = Object.freeze({
  light: '#f0efec',
  dark: '#383835',
});

/** The default diverging arms (SPEC 11.3): blue ↔ red, taken from the categorical slots. */
export const DIVERGING_ENDS: Readonly<
  Record<ColorScheme, { low: ColorString; high: ColorString }>
> = Object.freeze({
  light: Object.freeze({ low: '#2a78d6', high: '#e34948' }),
  dark: Object.freeze({ low: '#3987e5', high: '#e66767' }),
});

/** Steps per arm in a generated diverging ramp. Equal counts per arm (SPEC 11.3). */
export const DIVERGING_STEPS_PER_ARM = 6;

/** The surface each built-in scheme validates its palette against (SPEC 11.1). */
export const SCHEME_SURFACE: Readonly<Record<ColorScheme, ColorString>> = Object.freeze({
  light: '#fcfcfb',
  dark: '#1a1a19',
});
