/**
 * Theme resolution for `resolve()` — and the one theme `@mdv/core` may own.
 *
 * ## Why core has a theme at all
 *
 * `ResolvedConfig.theme` and `ResolvedBlock.theme` are non-optional `Theme`s, so
 * `resolve()` must produce one from nothing. It cannot ask `@mdv/themes`:
 * `@mdv/themes` depends on `@mdv/core`, and the dependency cannot run the other
 * way. So core resolves a theme from what the embedder injected —
 * `MdvConfig.theme` as a resolved {@link Theme}, or a name/`extends` base found
 * among `MdvConfig.plugins[].themes` — and falls back to {@link FALLBACK_THEME}.
 *
 * ## Why the fallback is grey
 *
 * {@link FALLBACK_THEME} is **not** the SPEC 11.2 default theme, is not a copy of
 * it, and must never become one. SPEC 11.2's palette is a *selected* set of steps
 * that SPEC 16.4 requires an implementation to run through the palette validator;
 * the validator lives in `@mdv/themes`, so core is structurally incapable of
 * asserting that a coloured palette passes. A second transcription of those hex
 * values in this package would be a second source of truth that drifts — the
 * exact failure mode this milestone was created to remove.
 *
 * So the fallback asserts nothing it cannot check. It is a neutral luminance
 * ramp: eight greys separated by lightness alone, which is the one palette that
 * is trivially safe under every form of colour-vision deficiency and needs no
 * validator to say so. It renders, it is deterministic, and it looks
 * unmistakably like "no theme was configured" rather than like a design.
 *
 * Pass `config.theme = getBuiltinTheme('default')` from `@mdv/themes` for the
 * real thing.
 */

import type {
  CategoricalPalette,
  ColorScheme,
  ColorSchemePreference,
  ColorString,
  DivergingPalette,
  MarkSpec,
  SequentialPalette,
  Theme,
  ThemeColorTokens,
  ThemeMetricTokens,
  ThemeOverride,
  ThemeTypeTokens,
} from '../types/theme.js';
import { STATUS_PALETTE } from '../types/theme.js';

/**
 * Type and metric tokens are the parts of SPEC 11.1 that are plain numbers with
 * no palette to validate, so core states them directly.
 */
const TYPE_TOKENS: ThemeTypeTokens = Object.freeze({
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  fontSize: 13,
  titleScale: 1.23,
  tickScale: 0.85,
  lineHeight: 1.4,
});

/** SPEC 11.1: `radius` 4, `hairline` 1, `gap` 2, `ring` 2. */
const METRIC_TOKENS: ThemeMetricTokens = Object.freeze({
  radius: 4,
  hairline: 1,
  gap: 2,
  ring: 2,
});

/** SPEC 11.4, fixed across every chart type. White does the separating. */
const MARK_SPEC: MarkSpec = Object.freeze({
  bar: Object.freeze({ maxThickness: 24, cornerRadius: 4, squareAtBaseline: true }),
  line: Object.freeze({ width: 2, join: 'round', cap: 'round' }),
  marker: Object.freeze({ minDiameter: 8, ringWidth: 2 }),
  area: Object.freeze({ fillOpacity: 0.1 }),
  grid: Object.freeze({ width: 1, dashed: false }),
  spacer: Object.freeze({ surfaceGap: 2, surfaceRing: 2 }),
});

/**
 * Eight greys, dark → light, each step a clear luminance interval from the last.
 *
 * Ordered dark-first because slot 1 is the most common single series and must be
 * the most legible thing on the surface (SPEC 11.2: the palette is assigned in
 * fixed order and never cycled).
 */
const GREYS_ON_LIGHT: CategoricalPalette = Object.freeze([
  '#1c1c1c',
  '#4a4a4a',
  '#6e6e6e',
  '#8d8d8d',
  '#a8a8a8',
  '#bfbfbf',
  '#d4d4d4',
  '#e6e6e6',
]);

/** The same ramp read from the other end, for a dark surface. */
const GREYS_ON_DARK: CategoricalPalette = Object.freeze([
  '#f0f0f0',
  '#cfcfcf',
  '#ababab',
  '#8d8d8d',
  '#727272',
  '#5a5a5a',
  '#454545',
  '#333333',
]);

const LIGHT_TOKENS: ThemeColorTokens = Object.freeze({
  surface: '#ffffff',
  page: '#f7f7f7',
  'text-primary': '#111111',
  'text-secondary': '#555555',
  'text-muted': '#888888',
  grid: '#e4e4e4',
  axis: '#c2c2c2',
  border: 'rgba(17,17,17,0.10)',
  'success-text': '#006300',
});

const DARK_TOKENS: ThemeColorTokens = Object.freeze({
  surface: '#161616',
  page: '#0e0e0e',
  'text-primary': '#f2f2f2',
  'text-secondary': '#b4b4b4',
  'text-muted': '#8a8a8a',
  grid: '#2c2c2c',
  axis: '#4a4a4a',
  border: 'rgba(242,242,242,0.12)',
  'success-text': '#6fdc6f',
});

function sequentialOf(steps: readonly ColorString[], hue: ColorString): SequentialPalette {
  return Object.freeze({
    hue,
    steps: Object.freeze([...steps]),
    // The lightest step legible on this surface at >= 2:1 (SPEC 11.3, ordinal
    // ramps). With a pure luminance ramp this is a property of the ramp itself.
    ordinalFloor: 1,
    ordinalCeiling: steps.length - 1,
  });
}

/**
 * A diverging ramp still needs its two arms told apart, and hue is the one thing
 * this theme will not use. The arms differ by *direction of luminance* from a
 * light-neutral midpoint, which is exactly what SPEC 11.3 requires of the
 * midpoint ("zero must read as nothing") and is readable without colour.
 */
function divergingOf(
  low: ColorString,
  high: ColorString,
  mid: ColorString,
  lowSteps: readonly ColorString[],
  highSteps: readonly ColorString[],
): DivergingPalette {
  return Object.freeze({
    low,
    high,
    mid,
    lowSteps: Object.freeze([...lowSteps]),
    highSteps: Object.freeze([...highSteps]),
  });
}

/**
 * The theme `resolve()` uses when the embedder configured none.
 *
 * `name` is `'fallback'`, not `'default'`, so nothing downstream can mistake it
 * for the SPEC 11 default. `validation` is deliberately absent: core has no
 * palette validator, and claiming a `PaletteValidation` it did not run would be
 * worse than admitting there is none.
 */
export const FALLBACK_THEME: Theme = Object.freeze({
  name: 'fallback',
  scheme: 'light',
  tokens: LIGHT_TOKENS,
  type: TYPE_TOKENS,
  metrics: METRIC_TOKENS,
  categorical: GREYS_ON_LIGHT,
  sequential: sequentialOf(
    ['#ededed', '#d6d6d6', '#b8b8b8', '#969696', '#717171', '#4d4d4d', '#282828'],
    '#4d4d4d',
  ),
  diverging: divergingOf(
    '#3f3f3f',
    '#3f3f3f',
    '#f4f4f4',
    ['#d9d9d9', '#8f8f8f', '#3f3f3f'],
    ['#d9d9d9', '#8f8f8f', '#3f3f3f'],
  ),
  status: STATUS_PALETTE,
  marks: MARK_SPEC,
});

/** {@link FALLBACK_THEME} on a dark surface. */
export const FALLBACK_THEME_DARK: Theme = Object.freeze({
  ...FALLBACK_THEME,
  scheme: 'dark',
  tokens: DARK_TOKENS,
  categorical: GREYS_ON_DARK,
  sequential: sequentialOf(
    ['#2a2a2a', '#414141', '#5c5c5c', '#7c7c7c', '#a0a0a0', '#c6c6c6', '#ececec'],
    '#a0a0a0',
  ),
  diverging: divergingOf(
    '#cfcfcf',
    '#cfcfcf',
    '#242424',
    ['#3a3a3a', '#828282', '#cfcfcf'],
    ['#3a3a3a', '#828282', '#cfcfcf'],
  ),
});

/** The fallback theme for a surface. */
export function fallbackTheme(scheme: ColorScheme): Theme {
  return scheme === 'dark' ? FALLBACK_THEME_DARK : FALLBACK_THEME;
}

/**
 * Resolve `colorScheme: 'auto'`.
 *
 * SPEC 25: resolution happens once, at resolve. Core has no host to ask —
 * querying `matchMedia` would be a DOM access (SPEC 17.3 invariant 1) — so
 * `'auto'` is `'light'` here and an embedder that knows better passes the answer.
 */
export function resolveColorScheme(preference: ColorSchemePreference | undefined): ColorScheme {
  return preference === 'dark' ? 'dark' : 'light';
}

/** A theme a plugin registered, matched by name and then by surface. */
function fromPlugins(
  themes: readonly Theme[],
  name: string,
  scheme: ColorScheme,
): Theme | undefined {
  const named = themes.filter((theme) => theme.name === name);
  return named.find((theme) => theme.scheme === scheme) ?? named[0];
}

/**
 * The theme a surface starts from, before any `theme:` setting (SPEC 11.7).
 *
 * The embedder's colour scheme is a *precedence step*, not a decoration: a dark
 * request answered with light tokens has not honoured it. Asking
 * {@link fromPlugins} for `default` cannot honour it either, because a plugin
 * registers its two surfaces as two themes under two names — the pairing
 * `@mdv/themes`' `themeNameForScheme` states, and the reason `fromPlugins`'
 * name-first fallback returns the light `default` for a dark request rather
 * than nothing at all.
 *
 * So the surface is asked for by the name that belongs to it, and the answer is
 * confirmed against `scheme` rather than assumed from the name. A plugin that
 * registered nothing for this surface falls through to the built-in fallback,
 * which is the one theme guaranteed to be the surface it claims.
 */
function baseTheme(themes: readonly Theme[], scheme: ColorScheme): Theme {
  const named = scheme === 'dark' ? 'dark' : 'default';
  return (
    themes.find((theme) => theme.name === named && theme.scheme === scheme) ??
    themes.find((theme) => theme.name === 'default' && theme.scheme === scheme) ??
    fallbackTheme(scheme)
  );
}

/**
 * Apply a {@link ThemeOverride} (SPEC 11.6) over a resolved base.
 *
 * Only the fields core can apply without a colour engine are applied: token
 * substitutions, the categorical list, the font, and the metric tokens. A
 * `sequential`/`diverging` override asks for a *generated ramp*, which is
 * `@mdv/themes`' `generateDiverging`/`sequentialFromSteps`, so those two are
 * reported as unapplied rather than half-applied — a ramp built the wrong way is
 * worse than the base ramp.
 *
 * @returns the composed theme and the override keys that needed a colour engine
 */
export function applyThemeOverride(
  base: Theme,
  override: ThemeOverride,
): { theme: Theme; unapplied: readonly string[] } {
  const unapplied: string[] = [];
  if (override.sequential !== undefined) unapplied.push('sequential');
  if (override.diverging !== undefined) unapplied.push('diverging');

  const tokens: ThemeColorTokens =
    override.tokens === undefined
      ? base.tokens
      : Object.freeze({ ...base.tokens, ...override.tokens });

  const type: ThemeTypeTokens =
    override.font === undefined
      ? base.type
      : Object.freeze({
          ...base.type,
          ...(override.font.family !== undefined ? { fontFamily: override.font.family } : {}),
          ...(override.font.size !== undefined ? { fontSize: override.font.size } : {}),
        });

  // The base's `validation` described the base's palette. Once the palette is
  // replaced the verdict no longer applies, and core cannot re-run it (SPEC 16.4
  // puts the validator in `@mdv/themes`). Destructure it out rather than
  // spreading `validation: undefined` over it: under `exactOptionalPropertyTypes`
  // an absent key and a key holding `undefined` are different types, and only
  // the absent one means "no verdict".
  const { validation, ...carried } = base;
  const keepValidation = override.categorical === undefined && validation !== undefined;

  const theme: Theme = Object.freeze({
    ...carried,
    ...(keepValidation ? { validation } : {}),
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.scheme !== undefined ? { scheme: override.scheme } : {}),
    tokens,
    type,
    ...(override.metrics !== undefined
      ? { metrics: Object.freeze({ ...base.metrics, ...override.metrics }) }
      : {}),
    ...(override.categorical !== undefined && override.categorical.length > 0
      ? { categorical: Object.freeze([...override.categorical]) }
      : {}),
  });
  return { theme, unapplied };
}

/** What {@link resolveThemeSetting} could not do, for the caller to report. */
export interface ThemeResolution {
  readonly theme: Theme;
  /** A theme name that matched nothing registered (`MDV1502`). */
  readonly unknownName?: string;
  /** Override keys that needed a colour engine core does not have. */
  readonly unapplied?: readonly string[];
}

/**
 * Resolve `MdvConfig.theme` (SPEC 11.6, 25) against the themes plugins supplied.
 *
 * Never throws and never rejects a document: an unresolvable name degrades to
 * the fallback and is reported, per SPEC 15.2.
 */
export function resolveThemeSetting(
  setting: string | Theme | ThemeOverride | undefined,
  scheme: ColorScheme,
  pluginThemes: readonly Theme[] = [],
): ThemeResolution {
  const base = baseTheme(pluginThemes, scheme);

  if (setting === undefined) return { theme: base };

  if (typeof setting === 'string') {
    const found = fromPlugins(pluginThemes, setting, scheme);
    return found === undefined ? { theme: base, unknownName: setting } : { theme: found };
  }

  // A resolved `Theme` has `tokens`; a `ThemeOverride` never does, because its
  // token map is `Partial<Record<ThemeColorRole, ColorString>>` under the same
  // key — so the discriminant is the presence of the *required* members a
  // resolved theme has and an override does not.
  if (isResolvedTheme(setting)) return { theme: setting };

  const extendsName = setting.extends;
  const overrideBase =
    extendsName === undefined ? base : (fromPlugins(pluginThemes, extendsName, scheme) ?? base);
  const unknownName =
    extendsName !== undefined && fromPlugins(pluginThemes, extendsName, scheme) === undefined
      ? extendsName
      : undefined;

  const applied = applyThemeOverride(overrideBase, setting);
  return {
    theme: applied.theme,
    ...(unknownName !== undefined ? { unknownName } : {}),
    ...(applied.unapplied.length > 0 ? { unapplied: applied.unapplied } : {}),
  };
}

/**
 * Tell a resolved {@link Theme} from a {@link ThemeOverride}.
 *
 * `ThemeOverride` makes every field optional, so structural typing alone cannot
 * separate them; the discriminant is that a resolved theme carries the four
 * members an override has no spelling for at all.
 */
export function isResolvedTheme(value: string | Theme | ThemeOverride): value is Theme {
  if (typeof value !== 'object') return false;
  const candidate = value as Partial<Theme>;
  return (
    typeof candidate.name === 'string' &&
    candidate.type !== undefined &&
    candidate.marks !== undefined &&
    candidate.status !== undefined &&
    Array.isArray(candidate.categorical)
  );
}
