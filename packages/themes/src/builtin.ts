/**
 * The four built-in themes (SPEC 11.1, 11.6): `default`, `dark`, `print` and
 * `high-contrast`.
 *
 * `default` and `dark` are **selected** sets of steps, each validated against its
 * own surface — dark is not an algorithmic inversion of light, and the two
 * palettes are quoted verbatim from SPEC 11.2 rather than derived.
 *
 * `print` and `high-contrast` *are* derived, and deliberately so: both differ
 * from `default` in exactly one respect (the surface is paper white; every slot
 * must clear 3:1), and deriving them makes that respect the only degree of
 * freedom. The derivation is a hue-preserving lightness sweep in OKLab, run
 * through the same validator as everything else — see `raiseContrast`.
 */

import { CATEGORICAL_HUE_NAMES, STATUS_PALETTE } from '@mdv/core';
import type {
  CategoricalPalette,
  ColorScheme,
  ColorString,
  MarkSpec,
  SequentialPalette,
  Theme,
  ThemeColorTokens,
  ThemeMetricTokens,
  ThemeTypeTokens,
} from '@mdv/core';
import { GRAPHIC_CONTRAST_MIN } from './color/contrast.js';
import {
  CATEGORICAL_DARK,
  CATEGORICAL_LIGHT,
  DIVERGING_ENDS,
  DIVERGING_MID,
  DIVERGING_STEPS_PER_ARM,
  SCHEME_SURFACE,
  SEQUENTIAL_BLUE,
} from './palettes.js';
import {
  generateDiverging,
  generateSequential,
  raiseContrast,
  sequentialFromSteps,
} from './ramp.js';
import { validatePalette } from './validate.js';

/** Names of the built-in themes (SPEC 11.6). */
export type BuiltinThemeName = 'default' | 'dark' | 'print' | 'high-contrast';

/** Every built-in name, in a fixed order. */
export const BUILTIN_THEME_NAMES: readonly BuiltinThemeName[] = Object.freeze([
  'dark',
  'default',
  'high-contrast',
  'print',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Tokens (SPEC 11.1)
// ─────────────────────────────────────────────────────────────────────────────

const LIGHT_TOKENS: ThemeColorTokens = Object.freeze({
  surface: '#fcfcfb',
  page: '#f9f9f7',
  'text-primary': '#0b0b0b',
  'text-secondary': '#52514e',
  'text-muted': '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  border: 'rgba(11,11,11,0.10)',
  'success-text': '#006300',
});

const DARK_TOKENS: ThemeColorTokens = Object.freeze({
  surface: '#1a1a19',
  page: '#0d0d0d',
  'text-primary': '#ffffff',
  'text-secondary': '#c3c2b7',
  'text-muted': '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  border: 'rgba(255,255,255,0.10)',
  'success-text': '#0ca30c',
});

/**
 * One family for everything, **including large figures** — no display or serif
 * face (SPEC 11.1).
 */
export const TYPE_TOKENS: ThemeTypeTokens = Object.freeze({
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  titleScale: 1.15,
  tickScale: 0.85,
  lineHeight: 1.4,
});

/** `radius` 4, `hairline` 1, `gap` 2, `ring` 2 (SPEC 11.1). */
export const METRIC_TOKENS: ThemeMetricTokens = Object.freeze({
  radius: 4,
  hairline: 1,
  gap: 2,
  ring: 2,
});

/**
 * The mark specification (SPEC 11.4) — fixed across every chart type, because
 * the data is the only thing allowed to be loud.
 */
export const MARK_SPEC: MarkSpec = Object.freeze({
  bar: Object.freeze({ maxThickness: 24, cornerRadius: 4, squareAtBaseline: true }),
  line: Object.freeze({ width: 2, join: 'round', cap: 'round' }),
  marker: Object.freeze({ minDiameter: 8, ringWidth: 2 }),
  area: Object.freeze({ fillOpacity: 0.1 }),
  grid: Object.freeze({ width: 1, dashed: false }),
  spacer: Object.freeze({ surfaceGap: 2, surfaceRing: 2 }),
}) as MarkSpec;

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble a complete {@link Theme} and run the SPEC 16.4 validator over its
 * categorical palette against its own surface.
 *
 * Every built-in carries its `validation` result, so a host never has to ask
 * whether the palette it was handed was checked.
 */
export function composeTheme(input: {
  name: string;
  scheme: ColorScheme;
  tokens: ThemeColorTokens;
  categorical: CategoricalPalette;
  sequentialHue: ColorString;
  sequentialSteps: readonly ColorString[];
  /**
   * Which categorical slot the sequential ramp *is* (SPEC 11.3), when it is one
   * of them. `scheme: <that name>` then resolves to the hand-selected steps
   * rather than to a generated approximation of the same hue.
   */
  sequentialName?: string;
  diverging: { low: ColorString; high: ColorString; mid: ColorString };
  type?: ThemeTypeTokens;
  metrics?: ThemeMetricTokens;
}): Theme {
  const surface = input.tokens.surface;
  return Object.freeze({
    name: input.name,
    scheme: input.scheme,
    tokens: input.tokens,
    type: input.type ?? TYPE_TOKENS,
    metrics: input.metrics ?? METRIC_TOKENS,
    categorical: Object.freeze([...input.categorical]),
    sequential: sequentialFromSteps(input.sequentialHue, input.sequentialSteps, surface),
    diverging: generateDiverging(
      input.diverging.low,
      input.diverging.high,
      input.diverging.mid,
      DIVERGING_STEPS_PER_ARM,
    ),
    ramps: namedRamps(input, surface),
    status: STATUS_PALETTE,
    marks: MARK_SPEC,
    validation: validatePalette(input.categorical, surface, input.scheme),
  });
}

/**
 * One ramp per categorical slot, keyed by hue name, so `scheme: green` on a
 * heatmap (SPEC 8.9) has listed steps to interpolate between.
 *
 * `sequentialName` names the slot the theme's own sequential ramp occupies —
 * `blue` for every built-in. That slot keeps the hand-selected steps (SPEC 11.3)
 * instead of a generated approximation of them, which is what makes
 * `scheme: blue` and no `scheme` at all the same ramp on the built-ins. The
 * remaining seven are generated from the slot colour, once, here: at render time
 * a ramp that differs by a rounding mode between two machines is not a
 * reproducible document (SPEC 24.3).
 */
function namedRamps(
  input: {
    categorical: CategoricalPalette;
    sequentialHue: ColorString;
    sequentialSteps: readonly ColorString[];
    sequentialName?: string;
  },
  surface: ColorString,
): Readonly<Record<string, SequentialPalette>> {
  const out: Record<string, SequentialPalette> = {};
  for (const [i, name] of CATEGORICAL_HUE_NAMES.entries()) {
    const slot = input.categorical[i];
    if (slot === undefined) continue;
    out[name] =
      name === input.sequentialName
        ? sequentialFromSteps(input.sequentialHue, input.sequentialSteps, surface)
        : generateSequential(slot, input.sequentialSteps.length, surface);
  }
  return Object.freeze(out);
}

function lightTheme(): Theme {
  return composeTheme({
    name: 'default',
    scheme: 'light',
    tokens: LIGHT_TOKENS,
    categorical: CATEGORICAL_LIGHT,
    sequentialHue: '#3987e5',
    sequentialSteps: SEQUENTIAL_BLUE,
    sequentialName: 'blue',
    diverging: { ...DIVERGING_ENDS.light, mid: DIVERGING_MID.light },
  });
}

function darkTheme(): Theme {
  return composeTheme({
    name: 'dark',
    scheme: 'dark',
    tokens: DARK_TOKENS,
    categorical: CATEGORICAL_DARK,
    sequentialHue: '#3987e5',
    sequentialSteps: SEQUENTIAL_BLUE,
    sequentialName: 'blue',
    diverging: { ...DIVERGING_ENDS.dark, mid: DIVERGING_MID.dark },
  });
}

/**
 * Lift every slot of `palette` to at least `target` contrast against `surface`,
 * hue-preserving, leaving slots that already clear it untouched.
 *
 * Only touching the failing slots matters: darkening the whole palette would
 * compress its lightness range and *reduce* the very separation the CVD gate
 * measures.
 */
function liftPalette(
  palette: CategoricalPalette,
  surface: ColorString,
  target: number,
  scheme: ColorScheme,
): CategoricalPalette {
  return Object.freeze(palette.map((c) => raiseContrast(c, surface, target, scheme)));
}

/**
 * Print: the light theme on paper white, with the grid and axis one step darker
 * so a hairline survives a 300 dpi laser printer, and every slot lifted to 3:1
 * because paper has no backlight to rescue a pale hue.
 */
function printTheme(): Theme {
  const tokens: ThemeColorTokens = Object.freeze({
    ...LIGHT_TOKENS,
    surface: '#ffffff',
    page: '#ffffff',
    grid: '#d8d7d0',
    axis: '#a9a8a0',
    border: 'rgba(11,11,11,0.16)',
  });
  return composeTheme({
    name: 'print',
    scheme: 'light',
    tokens,
    categorical: liftPalette(CATEGORICAL_LIGHT, tokens.surface, GRAPHIC_CONTRAST_MIN, 'light'),
    sequentialHue: '#3987e5',
    sequentialSteps: SEQUENTIAL_BLUE,
    sequentialName: 'blue',
    diverging: { ...DIVERGING_ENDS.light, mid: '#eeeeec' },
  });
}

/**
 * The contrast every `high-contrast` slot is lifted to.
 *
 * Not 4.5. Lifting the palette compresses its lightness range, and the CVD gate
 * is measured in a space where lightness is most of the signal: at 4.5:1 the
 * aqua/yellow pair collapses to ΔE 7.7 and the theme starts *confusing series* in
 * exchange for a contrast point. A sweep over the whole range (see
 * `test/palette.test.ts`, which re-runs it) puts the knee at 3.75: the highest
 * target at which every adjacent pair still clears ΔE ≥ 8 under red–green CVD.
 * A high-contrast theme whose series cannot be told apart has failed at the job
 * it exists for, so separation wins the tie.
 */
const HIGH_CONTRAST_TARGET = 3.75;

/**
 * High contrast: pure black on pure white, every slot lifted to
 * {@link HIGH_CONTRAST_TARGET} — comfortably past the 3:1 graphical-object
 * threshold, so no slot needs the relief rule, while every SPEC 16.4 gate still
 * passes clean.
 */
function highContrastTheme(): Theme {
  const tokens: ThemeColorTokens = Object.freeze({
    surface: '#ffffff',
    page: '#ffffff',
    'text-primary': '#000000',
    'text-secondary': '#1f1f1f',
    'text-muted': '#3d3d3d',
    grid: '#8f8f8f',
    axis: '#000000',
    border: 'rgba(0,0,0,0.45)',
    'success-text': '#005200',
  });
  return composeTheme({
    name: 'high-contrast',
    scheme: 'light',
    tokens,
    categorical: liftPalette(CATEGORICAL_LIGHT, tokens.surface, HIGH_CONTRAST_TARGET, 'light'),
    sequentialHue: '#2a78d6',
    sequentialSteps: SEQUENTIAL_BLUE,
    sequentialName: 'blue',
    diverging: { low: '#1c5cab', high: '#c22a29', mid: '#e8e8e6' },
  });
}

const BUILTINS: Readonly<Record<BuiltinThemeName, () => Theme>> = Object.freeze({
  default: lightTheme,
  dark: darkTheme,
  print: printTheme,
  'high-contrast': highContrastTheme,
});

/**
 * Memoised instances. Themes are deeply frozen and stateless, so one instance per
 * name is safe to share — and sharing keeps `theme === theme` a usable identity
 * check for React memoisation in `@mdv/react`.
 */
const CACHE = new Map<BuiltinThemeName, Theme>();

/** True when `name` is one of the four built-ins. */
export function isBuiltinThemeName(name: string): name is BuiltinThemeName {
  return Object.prototype.hasOwnProperty.call(BUILTINS, name);
}

/**
 * Look up a built-in theme.
 *
 * @throws MdvConfigError for an unknown name — see `resolve.ts`, which is where
 * the name arrives from user configuration and where the error is raised.
 */
export function getBuiltinTheme(name: BuiltinThemeName): Theme {
  const cached = CACHE.get(name);
  if (cached !== undefined) return cached;
  const factory = BUILTINS[name];
  const theme = factory();
  CACHE.set(name, theme);
  return theme;
}

/** Every built-in theme, in {@link BUILTIN_THEME_NAMES} order (sorted by name). */
export function listBuiltinThemes(): readonly Theme[] {
  return Object.freeze(BUILTIN_THEME_NAMES.map((n) => getBuiltinTheme(n)));
}

/** The surface a scheme's palette is validated against (SPEC 11.1). */
export function surfaceFor(scheme: ColorScheme): ColorString {
  return SCHEME_SURFACE[scheme];
}
