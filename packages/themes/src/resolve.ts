/**
 * Custom themes (SPEC 11.6).
 *
 * An author supplies a `theme:` mapping in front matter, or a theme file; either
 * way it is a {@link ThemeOverride} resolved against its `extends` base into a
 * complete {@link Theme}.
 *
 * > **A reader MUST run palette validation on a custom categorical palette and
 * > MUST report failures as `MDV3080` warnings** — silently accepting an
 * > unreadable palette defeats the purpose of specifying one.
 *
 * This module always runs the validator and always attaches the result to
 * `Theme.validation`; turning findings into diagnostics is the caller's job,
 * because only the caller has the source range to attach them to. See
 * {@link paletteDiagnosticMessages} for the message text.
 */

import { MdvConfigError } from '@mdv/core';
import type {
  ColorScheme,
  ColorString,
  PaletteFinding,
  PaletteValidation,
  Theme,
  ThemeColorRole,
  ThemeColorTokens,
  ThemeOverride,
} from '@mdv/core';
import type { BuiltinThemeName } from './builtin.js';
import {
  BUILTIN_THEME_NAMES,
  composeTheme,
  getBuiltinTheme,
  isBuiltinThemeName,
} from './builtin.js';
import { parseColor } from './color/rgb.js';
import { DIVERGING_MID } from './palettes.js';
import { generateSequentialSteps } from './ramp.js';
import { themeNameForScheme } from './scheme.js';
import { validatePalette } from './validate.js';

/** Every role a theme carries, in a fixed order (SPEC 11.1). */
const COLOR_ROLES: readonly ThemeColorRole[] = Object.freeze([
  'surface',
  'page',
  'text-primary',
  'text-secondary',
  'text-muted',
  'grid',
  'axis',
  'border',
  'success-text',
]);

/** Default step count for a generated sequential ramp (SPEC 11.3: 100 → 700). */
const DEFAULT_SEQUENTIAL_STEPS = 13;

function requireColor(value: ColorString, path: string): ColorString {
  try {
    parseColor(value);
  } catch (cause) {
    throw new MdvConfigError(
      `theme.${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      `theme.${path}`,
    );
  }
  return value;
}

/**
 * Resolve the base a `ThemeOverride` extends.
 *
 * @throws MdvConfigError naming the four legal built-ins, because "unknown theme"
 * without the list is a diagnostic the author cannot act on.
 */
export function resolveBase(
  extendsName: string | undefined,
  scheme: ColorScheme,
  fallback?: Theme,
): Theme {
  if (extendsName === undefined) return fallback ?? getBuiltinTheme(themeNameForScheme(scheme));
  if (isBuiltinThemeName(extendsName)) return getBuiltinTheme(extendsName);
  if (fallback !== undefined && fallback.name === extendsName) return fallback;
  throw new MdvConfigError(
    `Unknown theme ${JSON.stringify(extendsName)}; expected one of ${BUILTIN_THEME_NAMES.join(', ')}, or a theme file path`,
    'theme.extends',
  );
}

/**
 * Resolve an author's theme against its base into a complete {@link Theme}.
 *
 * The resulting palette is **always** re-validated against the resulting
 * surface, not against the base's surface: overriding `tokens.surface` without
 * overriding `categorical` can move a slot below 3:1, and the point of SPEC 11.2
 * rule 5 is that a substituted palette is re-checked rather than reasoned about.
 *
 * @param override - the author's `theme:` mapping
 * @param scheme - the scheme in force, from {@link resolveColorScheme}
 * @param base - an explicit base, overriding `override.extends`'s default
 */
export function resolveTheme(override: ThemeOverride, scheme: ColorScheme, base?: Theme): Theme {
  const parent = resolveBase(override.extends, scheme, base);
  const outScheme = override.scheme ?? (override.extends !== undefined ? parent.scheme : scheme);

  // ── tokens ────────────────────────────────────────────────────────────────
  const tokenPatch = override.tokens;
  let tokens: ThemeColorTokens = parent.tokens;
  if (tokenPatch !== undefined) {
    const next: Record<ThemeColorRole, ColorString> = { ...parent.tokens };
    for (const role of COLOR_ROLES) {
      const v = tokenPatch[role];
      if (v !== undefined) next[role] = requireColor(v, `tokens.${role}`);
    }
    tokens = Object.freeze(next);
  }

  // ── categorical ───────────────────────────────────────────────────────────
  const categorical =
    override.categorical === undefined
      ? parent.categorical
      : Object.freeze(override.categorical.map((c, i) => requireColor(c, `categorical[${i}]`)));
  if (categorical.length === 0) {
    throw new MdvConfigError('theme.categorical must list at least one slot', 'theme.categorical');
  }

  // ── sequential ────────────────────────────────────────────────────────────
  let sequentialHue = parent.sequential.hue;
  let sequentialSteps: readonly ColorString[] = parent.sequential.steps;
  /**
   * Which slot the inherited ramp names, if any (SPEC 11.3) — found by hue,
   * because {@link Theme} records the ramps and the anchor but not the tie
   * between them. An author who supplies their own `sequential` breaks the tie:
   * their ramp is theirs, and `scheme: blue` goes back to meaning the blue slot.
   */
  let sequentialName = Object.entries(parent.ramps ?? {}).find(
    ([, ramp]) => ramp.hue === parent.sequential.hue,
  )?.[0];
  if (override.sequential !== undefined) {
    sequentialName = undefined;
    sequentialHue = requireColor(override.sequential.hue, 'sequential.hue');
    const count = override.sequential.steps ?? DEFAULT_SEQUENTIAL_STEPS;
    if (!Number.isFinite(count) || count < 2) {
      throw new MdvConfigError(
        'theme.sequential.steps must be at least 2',
        'theme.sequential.steps',
      );
    }
    sequentialSteps = generateSequentialSteps(sequentialHue, count);
  }

  // ── diverging ─────────────────────────────────────────────────────────────
  let diverging = {
    low: parent.diverging.low,
    high: parent.diverging.high,
    mid: parent.diverging.mid,
  };
  if (override.diverging !== undefined) {
    diverging = {
      low: requireColor(override.diverging.low, 'diverging.low'),
      high: requireColor(override.diverging.high, 'diverging.high'),
      mid: requireColor(override.diverging.mid ?? DIVERGING_MID[outScheme], 'diverging.mid'),
    };
  }

  // ── type and metrics ──────────────────────────────────────────────────────
  const type =
    override.font === undefined
      ? parent.type
      : Object.freeze({
          ...parent.type,
          ...(override.font.family !== undefined ? { fontFamily: override.font.family } : {}),
          ...(override.font.size !== undefined ? { fontSize: override.font.size } : {}),
        });
  const metrics =
    override.metrics === undefined
      ? parent.metrics
      : Object.freeze({
          ...parent.metrics,
          ...(override.metrics.radius !== undefined ? { radius: override.metrics.radius } : {}),
          ...(override.metrics.hairline !== undefined
            ? { hairline: override.metrics.hairline }
            : {}),
          ...(override.metrics.gap !== undefined ? { gap: override.metrics.gap } : {}),
          ...(override.metrics.ring !== undefined ? { ring: override.metrics.ring } : {}),
        });

  return composeTheme({
    name: override.name ?? (override.extends !== undefined ? `${parent.name}+custom` : 'custom'),
    scheme: outScheme,
    tokens,
    categorical,
    sequentialHue,
    sequentialSteps,
    ...(sequentialName !== undefined ? { sequentialName } : {}),
    diverging,
    type,
    metrics,
  });
}

/**
 * Resolve a `theme:` value that may be a built-in name rather than a mapping.
 *
 * @param _scheme - **not consulted.** A built-in carries its own scheme —
 * `dark` is the dark one, `print` and `high-contrast` are neither — so naming a
 * theme settles the question that `colorScheme` would otherwise answer. The
 * parameter stays in the signature because callers pass the ambient scheme
 * positionally and dropping it would silently reinterpret their second
 * argument; it is named with a leading underscore to say so rather than to hide
 * a lint warning.
 * @throws MdvConfigError for an unknown name
 */
export function themeByName(name: string, _scheme: ColorScheme): Theme {
  if (isBuiltinThemeName(name)) return getBuiltinTheme(name as BuiltinThemeName);
  throw new MdvConfigError(
    `Unknown theme ${JSON.stringify(name)}; expected one of ${BUILTIN_THEME_NAMES.join(', ')}`,
    'theme',
  );
}

/**
 * The `MDV3080` messages a validation result implies, in finding order.
 *
 * Returned as strings rather than `Diagnostic`s because a diagnostic needs a
 * source range, and only the caller — the resolve stage, holding the front
 * matter's `AttrRanges` — knows where the palette was written.
 */
export function paletteDiagnosticMessages(validation: PaletteValidation): readonly string[] {
  return validation.findings.map((f) => f.message);
}

/**
 * True when the palette obliges the relief rule: visible direct labels or the
 * table view (SPEC 11.2 rule 4, `MDV3081`). Not dismissable.
 */
export function reliefRequired(validation: PaletteValidation): boolean {
  return validation.reliefRequiredSlots.length > 0;
}

/**
 * Re-validate a theme against its own surface.
 *
 * Cheap enough to call on every resolve, and the only honest way to answer "is
 * this theme safe?" for a theme that arrived from outside this package.
 */
export function revalidate(theme: Theme, allPairs = false): PaletteValidation {
  return validatePalette(theme.categorical, theme.tokens.surface, theme.scheme, { allPairs });
}

/**
 * How many slots the all-pairs gate is applied to (SPEC 11.2 rule 3).
 *
 * Not a tuning knob: eight distinguishable hues that also separate pairwise
 * under red–green CVD do not exist at any ordering, which is why SPEC 8.6 caps
 * scatter, bubble and choropleth at three series rather than asking for a
 * better palette.
 */
export const ALL_PAIRS_SLOT_CAP = 3;

/** What {@link auditTheme} found. */
export interface ThemeAudit {
  /** The SPEC 16.4 gate: every slot, and every *adjacent* pair. */
  readonly gate: PaletteValidation;
  /**
   * The extra pairs SPEC 11.2 rule 3 asks about — non-adjacent pairs among the
   * first {@link ALL_PAIRS_SLOT_CAP} slots. Empty for a palette that clears it,
   * which the built-ins do.
   */
  readonly scatter: readonly PaletteFinding[];
  /** `false` when either part has a `fail` — the answer `MDV3080` reports. */
  readonly passed: boolean;
}

/**
 * Audit a whole theme the way SPEC 16.4 asks an implementation to audit its own.
 *
 * Two questions, because the spec asks two. The gate is per-slot and
 * adjacent-pair over the entire palette; the second is all-pairs over the first
 * three slots only, which is the guarantee SPEC 8.6's cap rests on. Running
 * all-pairs over all eight instead — the obvious "stricter is safer" reading —
 * fails the spec's own palette and every built-in with it, so it is not a
 * stricter version of this check but a different and wrong one.
 */
export function auditTheme(theme: Theme): ThemeAudit {
  const gate = revalidate(theme);
  const capped = validatePalette(
    theme.categorical.slice(0, ALL_PAIRS_SLOT_CAP),
    theme.tokens.surface,
    theme.scheme,
    { allPairs: true },
  );
  // Only the pairs the gate did not already ask about: everything else in
  // `capped` is a duplicate of a finding the caller is about to print.
  const scatter = capped.findings.filter(
    (finding) =>
      finding.slots.length === 2 && (finding.slots[1] ?? 0) - (finding.slots[0] ?? 0) > 1,
  );
  return {
    gate,
    scatter,
    passed: gate.passed && scatter.every((finding) => finding.level !== 'fail'),
  };
}
