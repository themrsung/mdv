/**
 * `@mdv/themes` — the built-in themes and the palette validator (SPEC 11, 16.4).
 *
 * Depends on nothing but `@mdv/core`'s types, so a host can validate a palette
 * without pulling in the layout engine.
 *
 * The four built-ins are `default`, `dark`, `print` and `high-contrast`
 * (SPEC 11.6). `default` and `dark` are **selected** sets of steps validated
 * against their own surfaces — dark is not an algorithmic inversion of light.
 *
 * Everything colorimetric here is computed: OKLab is Ottosson's transform,
 * contrast is WCAG 2.x with alpha composited over the real surface, and CVD is a
 * Brettel–Viénot–Mollon (1997) simulation. Run against the spec's own palettes
 * these reproduce SPEC 11.2's and 11.3.1's published figures exactly, which is
 * what `test/palette.test.ts` asserts.
 */

// ── Themes ───────────────────────────────────────────────────────────────────
export {
  BUILTIN_THEME_NAMES,
  MARK_SPEC,
  METRIC_TOKENS,
  TYPE_TOKENS,
  composeTheme,
  getBuiltinTheme,
  isBuiltinThemeName,
  listBuiltinThemes,
  surfaceFor,
} from './builtin.js';
export type { BuiltinThemeName } from './builtin.js';

export {
  paletteDiagnosticMessages,
  reliefRequired,
  resolveBase,
  resolveTheme,
  revalidate,
  themeByName,
} from './resolve.js';

export { resolveColorScheme, themeNameForScheme } from './scheme.js';
export type { ColorSchemeInputs } from './scheme.js';

// ── Palettes ─────────────────────────────────────────────────────────────────
export {
  CATEGORICAL_DARK,
  CATEGORICAL_HUE_NAMES,
  CATEGORICAL_LIGHT,
  DIVERGING_ENDS,
  DIVERGING_MID,
  DIVERGING_STEPS_PER_ARM,
  SCHEME_SURFACE,
  SEQUENTIAL_BLUE,
  SEQUENTIAL_SECOND_HUE,
  SEQUENTIAL_STEP_LABELS,
} from './palettes.js';

export {
  generateDiverging,
  generateSequential,
  generateSequentialSteps,
  labelOnFill,
  lightnessOf,
  ordinalBounds,
  raiseContrast,
  sequentialFromSteps,
  shiftLightness,
  toHex,
} from './ramp.js';

// ── The validator (SPEC 16.4) ────────────────────────────────────────────────
export {
  CHROMA_FLOOR,
  CVD_FLOOR_DELTA_E,
  CVD_TARGET_DELTA_E,
  GATED_CVD_TYPES,
  LIGHTNESS_BAND,
  NORMAL_VISION_DELTA_E,
  contrastRatio,
  deltaEOklab,
  paletteSeparation,
  validatePalette,
} from './validate.js';
export type { PaletteValidationOptions } from './validate.js';

// ── Colour science ───────────────────────────────────────────────────────────
export {
  GRAPHIC_CONTRAST_MIN,
  LARGE_TEXT_CONTRAST_MIN,
  ORDINAL_RAMP_CONTRAST_MIN,
  TEXT_CONTRAST_MIN,
  contrastRatioRgb,
  relativeLuminance,
} from './color/contrast.js';

export { CVD_TYPES, projectionRowSums, simulateCvd } from './color/cvd.js';
export type { CvdType } from './color/cvd.js';

export {
  deltaEOklabRgb,
  gamutMap,
  oklabToOklch,
  oklabToRgb,
  oklabToRgbUnclamped,
  oklchToOklab,
  rgbToOklab,
  toOklab,
  toOklch,
} from './color/oklab.js';
export type { Oklab, Oklch } from './color/oklab.js';

export { clamp01, decodeGamma, encodeGamma, formatHex, inGamut, over, parseColor } from './color/rgb.js';
export type { Rgb } from './color/rgb.js';

export { NAMED_COLORS } from './color/named.js';

// ── Texture, the backup channel (SPEC 12.6) ──────────────────────────────────
export {
  CATEGORICAL_ANGLES,
  categoricalTexture,
  categoricalTextures,
  divergingTexture,
  sequentialTexture,
  texturePaint,
  toneOnTone,
} from './texture.js';
export type { TextureOptions } from './texture.js';

// ── Re-exported contract types, so a consumer needs one import ───────────────
export { STATUS_PALETTE } from '@mdv/core';
export type {
  CategoricalPalette,
  ColorScheme,
  ColorSchemePreference,
  ColorString,
  DivergingPalette,
  PaletteCheck,
  PaletteFinding,
  PaletteValidation,
  SequentialPalette,
  StatusPalette,
  StatusRole,
  Theme,
  ThemeOverride,
} from '@mdv/core';
