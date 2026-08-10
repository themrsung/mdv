/**
 * Themes (SPEC 11).
 *
 * Rendering defaults are **normative**. An embedder may substitute values, but
 * the *structure* — the roles, the slot-ordering discipline, the mark
 * specifications — is fixed. A theme is a flat map of role → color plus type and
 * metric tokens; documents reference roles, never raw hex, so light/dark swap in
 * one place.
 */

/** Which surface the theme was validated against (SPEC 11.1). */
export type ColorScheme = 'light' | 'dark';

/** `colorScheme: 'auto'` follows the host; resolution happens once, at resolve. */
export type ColorSchemePreference = ColorScheme | 'auto';

/**
 * A resolved color. Backends receive absolutes only — no CSS custom properties,
 * no cascade (SPEC 20). Accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `hsl()`,
 * `oklch()`, and CSS named colors (SPEC 5.3.3).
 */
export type ColorString = string;

/**
 * Semantic color roles (SPEC 11.1). A document references these as `"@grid"`,
 * `"@text-muted"`, and so on.
 */
export type ThemeColorRole =
  | 'surface'
  | 'page'
  | 'text-primary'
  | 'text-secondary'
  | 'text-muted'
  | 'grid'
  | 'axis'
  | 'border'
  | 'success-text';

/**
 * The color tokens of SPEC 11.1.
 *
 * Dark mode is a **selected** set of steps validated against the dark surface,
 * not an algorithmic inversion of the light theme.
 */
export type ThemeColorTokens = Readonly<Record<ThemeColorRole, ColorString>>;

/**
 * Type tokens (SPEC 11.1). One family for everything, including large figures —
 * no display or serif face.
 */
export interface ThemeTypeTokens {
  /** @defaultValue `system-ui, -apple-system, "Segoe UI", sans-serif` */
  readonly fontFamily: string;
  /** Base label size in px. @defaultValue 13 */
  readonly fontSize: number;
  /** Multiplier applied to {@link fontSize} for the block title. */
  readonly titleScale: number;
  /** Multiplier applied to {@link fontSize} for axis ticks and legends. */
  readonly tickScale: number;
  /** Unitless line height for wrapped text. */
  readonly lineHeight: number;
}

/** Metric tokens (SPEC 11.1): `radius` 4, `hairline` 1, `gap` 2, `ring` 2. */
export interface ThemeMetricTokens {
  /** Corner radius of a mark's data end, in px. @defaultValue 4 */
  readonly radius: number;
  /** Gridline and axis stroke width, in px. @defaultValue 1 */
  readonly hairline: number;
  /** The surface gap that separates touching marks, in px. @defaultValue 2 */
  readonly gap: number;
  /** The surface ring around dots and end markers, in px. @defaultValue 2 */
  readonly ring: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mark specifications (SPEC 11.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixed across every chart type (SPEC 11.4). The data is the only thing allowed
 * to be loud.
 *
 * The two spacers are the load-bearing part: **white does the separating.**
 * Never draw a border around a mark to separate it — a stroke adds data-weight
 * ink that is not data.
 */
export interface MarkSpec {
  readonly bar: {
    /** Cap the thickness; let the band's leftover be air. @defaultValue 24 */
    readonly maxThickness: number;
    /** Rounded data end. @defaultValue 4 */
    readonly cornerRadius: number;
    /** The baseline end stays square. @defaultValue true */
    readonly squareAtBaseline: boolean;
  };
  readonly line: {
    /** @defaultValue 2 */
    readonly width: number;
    /** @defaultValue 'round' */
    readonly join: 'round' | 'miter' | 'bevel';
    /** @defaultValue 'round' */
    readonly cap: 'round' | 'butt' | 'square';
  };
  readonly marker: {
    /** Minimum diameter in px (r ≥ 4). @defaultValue 8 */
    readonly minDiameter: number;
    /** The surface ring, part of the hit target. @defaultValue 2 */
    readonly ringWidth: number;
  };
  readonly area: {
    /** A wash, never a saturated block. @defaultValue 0.1 */
    readonly fillOpacity: number;
  };
  readonly grid: {
    /** @defaultValue 1 */
    readonly width: number;
    /** Always solid. Gridlines are **never** dashed. @defaultValue false */
    readonly dashed: false;
  };
  readonly spacer: {
    /** Gap in the surface color between touching marks. @defaultValue 2 */
    readonly surfaceGap: number;
    /** Ring in the surface color around dots and end markers. @defaultValue 2 */
    readonly surfaceRing: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Palettes (SPEC 11.2, 11.3, 11.3.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The categorical palette (SPEC 11.2): eight slots, assigned **in fixed order and
 * never cycled**.
 *
 * Three normative rules bind every consumer:
 *
 * 1. **Color follows the entity, not its rank.** Slot assignment is keyed on the
 *    series' identity, resolved in first-appearance order over the *unfiltered*
 *    domain, so a series keeps its slot when a filter or a sort removes another.
 * 2. **A ninth series is never a generated hue.** Beyond the cap, series fold
 *    into "Other" (`MDV3062`), facet into small multiples, or gain a second
 *    channel. Interpolating new hues destroys the CVD guarantees.
 * 3. **All-pairs forms cap at three.** Scatter, bubble, choropleth and small
 *    multiples put any two series side by side; only the first three slots clear
 *    the all-pairs gate (`MDV3061`).
 */
export type CategoricalPalette = readonly ColorString[];

/** A one-hue sequential ramp, light → dark (SPEC 11.3). Never a rainbow. */
export interface SequentialPalette {
  /** The anchor hue; the ramp is generated from it, or listed explicitly. */
  readonly hue: ColorString;
  /** Steps from lightest to darkest, 100 → 700. */
  readonly steps: readonly ColorString[];
  /**
   * Index of the lightest step usable on this scheme's surface at ≥ 2:1
   * (SPEC 11.3, ordinal ramps): step 250 on light, step 600 on dark.
   */
  readonly ordinalFloor: number;
  readonly ordinalCeiling: number;
}

/**
 * Two hues plus a **neutral gray midpoint** (SPEC 11.3), equal step counts per
 * arm. Never a hue at the midpoint — zero must read as "nothing".
 */
export interface DivergingPalette {
  readonly low: ColorString;
  readonly high: ColorString;
  readonly mid: ColorString;
  readonly lowSteps: readonly ColorString[];
  readonly highSteps: readonly ColorString[];
}

/** The four reserved status roles (SPEC 11.3.1). */
export type StatusRole = 'good' | 'warning' | 'serious' | 'critical';

/** Fixed status colors (SPEC 11.3.1). */
export type StatusPalette = Readonly<Record<StatusRole, ColorString>>;

/**
 * The status palette (SPEC 11.3.1) — **fixed, never themed**.
 *
 * These colors are *reserved*: they never serve as "series 4", and they always
 * ship with an icon and a label so meaning never rests on hue. On the light
 * surface `warning` (1.79:1) and `serious` (2.57:1) are sub-3:1 **by design** —
 * the icon+label pairing is the mitigation, not an oversight.
 *
 * Defaults for OHLC direction, waterfall increase/decrease, deltas, and callouts.
 */
export const STATUS_PALETTE: StatusPalette = Object.freeze({
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
});

/**
 * The maximum number of categorical slots (SPEC 11.2). A ninth series folds into
 * "Other" rather than getting a generated hue.
 */
export const CATEGORICAL_SLOT_COUNT = 8;

/**
 * The all-pairs cap (SPEC 11.2 rule 3, SPEC 8.6). Forms where any two series can
 * appear side by side are limited to the first three slots.
 */
export const ALL_PAIRS_SERIES_CAP = 3;

// ─────────────────────────────────────────────────────────────────────────────
// The theme itself
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fully resolved theme. Every value is an absolute: layout hands backends
 * resolved colors and numbers, never tokens (SPEC 20, "No CSS").
 */
export interface Theme {
  /** `default`, `dark`, `print`, `high-contrast`, or a custom name. */
  readonly name: string;
  /** The surface this palette was validated against. */
  readonly scheme: ColorScheme;
  readonly tokens: ThemeColorTokens;
  readonly type: ThemeTypeTokens;
  readonly metrics: ThemeMetricTokens;
  readonly categorical: CategoricalPalette;
  readonly sequential: SequentialPalette;
  readonly diverging: DivergingPalette;
  /** Always {@link STATUS_PALETTE}; present on the theme so backends need one input. */
  readonly status: StatusPalette;
  readonly marks: MarkSpec;
  /**
   * Result of the palette validator (SPEC 16.4) for {@link categorical}.
   * A conforming implementation MUST run the validator over built-in themes and
   * over any theme fixture, and MUST report failures as `MDV3080`.
   */
  readonly validation?: PaletteValidation;
}

/**
 * An author-supplied theme (SPEC 11.6): the front-matter `theme:` mapping, or a
 * theme file. Resolved against its `extends` base into a {@link Theme}.
 */
export interface ThemeOverride {
  /** A named built-in to extend. @defaultValue 'default' */
  extends?: string;
  name?: string;
  scheme?: ColorScheme;
  tokens?: Partial<Record<ThemeColorRole, ColorString>>;
  /** MUST be re-validated per SPEC 16.4; failures are `MDV3080`. */
  categorical?: readonly ColorString[];
  sequential?: { hue: ColorString; steps?: number };
  diverging?: { low: ColorString; high: ColorString; mid?: ColorString };
  font?: { family?: string; size?: number };
  metrics?: Partial<ThemeMetricTokens>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Palette validation (SPEC 16.4)
// ─────────────────────────────────────────────────────────────────────────────

/** One check performed by the palette validator (SPEC 16.4). */
export type PaletteCheck =
  | 'lightness-band'
  | 'chroma-floor'
  | 'adjacent-cvd'
  | 'all-pairs-cvd'
  | 'normal-vision'
  | 'surface-contrast';

/** A single validator finding. */
export interface PaletteFinding {
  check: PaletteCheck;
  /** Slot indices involved; one for a per-slot check, two for a pair check. */
  slots: readonly number[];
  /** The measured statistic (ΔE in OKLab ×100, or a contrast ratio). */
  measured: number;
  /** The threshold that was applied. */
  threshold: number;
  /**
   * `fail` is a hard `MDV3080`. `warn` is legal only with a secondary encoding,
   * and a contrast warning **obligates** visible labels or the table view — it is
   * not dismissable (SPEC 16.4, the relief rule).
   */
  level: 'fail' | 'warn';
  message: string;
}

/** Outcome of running the validator over a palette in one scheme. */
export interface PaletteValidation {
  scheme: ColorScheme;
  /** `false` when any finding has `level: 'fail'`. */
  passed: boolean;
  findings: readonly PaletteFinding[];
  /**
   * Slots that fell below 3:1 against the surface. Blocks using these MUST ship
   * visible direct labels or the table view (SPEC 11.2 rule 4, `MDV3081`).
   */
  reliefRequiredSlots: readonly number[];
}
