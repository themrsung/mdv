/**
 * Texture — the backup channel (SPEC 12.6).
 *
 * Where hue fails — full-severity CVD, grayscale print, `forced-colors` — texture
 * carries identity. The rules are narrow on purpose:
 *
 * - **One directional fill at 45° and its 135° mirror only.** Horizontal and
 *   vertical read as gridlines and as bars respectively, so they are excluded:
 *   a texture that looks like a gridline has stopped being a texture.
 * - **Inked tone-on-tone from the fill's own ramp.** The stripe is a lightness
 *   step of the series colour, not black — a black hatch over a light fill is
 *   louder than the data.
 * - **Equal loudness across slots.** Ink coverage is constant in the categorical
 *   channel, so no series shouts because of its texture.
 * - **On value scales the texture is ordered**, so it never misstates the value:
 *   rotation steps with magnitude, and on a diverging scale the arm angle carries
 *   the sign.
 * - **Never on by default.** Triggered by `accessibility.texture: true`, by
 *   print, or by `forced-colors`.
 *
 * Output is a scene-graph {@link PatternDef}: geometry in tile coordinates plus a
 * rotation the backend applies to the whole lattice. Nothing here touches a DOM.
 */

import type { ColorScheme, ColorString, PatternDef, PatternPaint, SceneNode } from '@mdv/core';
import { shiftLightness } from './ramp.js';

/** The two categorical texture directions (SPEC 12.6). Nothing else is legal. */
export const CATEGORICAL_ANGLES: readonly [number, number] = Object.freeze([45, 135]);

/**
 * Rotation sweep for an *ordered* texture, in degrees either side of a
 * diagonal's base angle. ±30° keeps every step clear of horizontal and vertical
 * while still reading as an ordered progression.
 */
const ORDERED_SWEEP = 30;

/** Options common to every texture builder. */
export interface TextureOptions {
  /** Tile pitch in px — the distance between stripe centres. @defaultValue 6 */
  spacing?: number;
  /** Fraction of the tile covered by ink, `0…1`. @defaultValue 0.34 */
  coverage?: number;
  /**
   * Prefix for the generated def id. Ids must be namespaced and unique per
   * document (SPEC 13.3). @defaultValue 'mdv-tex'
   */
  idPrefix?: string;
  /**
   * OKLab lightness step between the fill and its stripe. Larger reads harder in
   * grayscale; smaller stays quieter next to the data. @defaultValue 0.2
   */
  toneStep?: number;
}

const DEFAULT_SPACING = 6;
const DEFAULT_COVERAGE = 0.34;
const DEFAULT_TONE_STEP = 0.2;

/**
 * The stripe ink for a fill: a lightness step of the fill's *own* hue, away from
 * the surface so the texture survives a grayscale conversion.
 */
export function toneOnTone(
  fill: ColorString,
  scheme: ColorScheme,
  toneStep = DEFAULT_TONE_STEP,
): ColorString {
  return shiftLightness(fill, scheme === 'light' ? -toneStep : toneStep);
}

/** Build the stripe geometry for one tile, in tile coordinates. */
function stripes(spacing: number, coverage: number, ink: ColorString): SceneNode[] {
  const w = Math.max(0.5, spacing * coverage);
  return [
    {
      kind: 'rect',
      x: 0,
      y: 0,
      w,
      h: spacing,
      fill: { kind: 'solid', color: ink },
    },
  ];
}

function build(
  id: string,
  angle: number,
  fill: ColorString,
  scheme: ColorScheme,
  options: TextureOptions,
): PatternDef {
  const spacing = options.spacing ?? DEFAULT_SPACING;
  const coverage = Math.min(0.9, Math.max(0.05, options.coverage ?? DEFAULT_COVERAGE));
  const ink = toneOnTone(fill, scheme, options.toneStep ?? DEFAULT_TONE_STEP);
  return {
    kind: 'pattern',
    id,
    width: spacing,
    height: spacing,
    angle,
    content: stripes(spacing, coverage, ink),
  };
}

/**
 * The categorical texture for a slot: 45° for even slots, its 135° mirror for
 * odd ones, at constant coverage.
 *
 * Two directions cannot separate eight series on their own, and they are not
 * asked to: texture is the *backup* channel, layered under hue, and a chart that
 * needs more than two textures needs small multiples (SPEC 11.2 rule 2).
 */
export function categoricalTexture(
  slot: number,
  fill: ColorString,
  scheme: ColorScheme,
  options: TextureOptions = {},
): PatternDef {
  const index = Math.max(0, Math.trunc(slot));
  const angle = CATEGORICAL_ANGLES[index % 2] ?? 45;
  const prefix = options.idPrefix ?? 'mdv-tex';
  return build(`${prefix}-cat-${index}`, angle, fill, scheme, options);
}

/**
 * The ordered texture for step `step` of a `steps`-step sequential scale.
 *
 * Rotation sweeps 15° → 75° with magnitude and coverage rises with it, so the
 * texture is monotone in two reinforcing ways and can never misstate the value.
 * Both endpoints stay clear of horizontal and vertical.
 */
export function sequentialTexture(
  step: number,
  steps: number,
  fill: ColorString,
  scheme: ColorScheme,
  options: TextureOptions = {},
): PatternDef {
  const n = Math.max(1, Math.trunc(steps));
  const i = Math.min(n - 1, Math.max(0, Math.trunc(step)));
  const t = n === 1 ? 0.5 : i / (n - 1);
  const angle = 45 - ORDERED_SWEEP + 2 * ORDERED_SWEEP * t;
  const baseCoverage = options.coverage ?? DEFAULT_COVERAGE;
  const prefix = options.idPrefix ?? 'mdv-tex';
  return build(`${prefix}-seq-${i}`, angle, fill, scheme, {
    ...options,
    coverage: baseCoverage * (0.5 + t),
  });
}

/**
 * The ordered texture for one step of a diverging scale.
 *
 * **The arm angle carries the sign**: the high arm sweeps around 45°, the low arm
 * around its 135° mirror. Rotation within the arm carries the magnitude, so sign
 * and magnitude are readable independently, with no colour at all.
 *
 * @param sign - `1` for the high arm, `-1` for the low arm. `0` is the neutral
 * midpoint and yields an untextured tile: zero must read as "nothing".
 */
export function divergingTexture(
  sign: -1 | 0 | 1,
  step: number,
  steps: number,
  fill: ColorString,
  scheme: ColorScheme,
  options: TextureOptions = {},
): PatternDef {
  const prefix = options.idPrefix ?? 'mdv-tex';
  if (sign === 0) {
    const spacing = options.spacing ?? DEFAULT_SPACING;
    return {
      kind: 'pattern',
      id: `${prefix}-div-mid`,
      width: spacing,
      height: spacing,
      angle: 45,
      content: [],
    };
  }
  const n = Math.max(1, Math.trunc(steps));
  const i = Math.min(n - 1, Math.max(0, Math.trunc(step)));
  const t = n === 1 ? 0.5 : i / (n - 1);
  const base = sign > 0 ? 45 : 135;
  const angle = base - ORDERED_SWEEP + 2 * ORDERED_SWEEP * t;
  const baseCoverage = options.coverage ?? DEFAULT_COVERAGE;
  return build(`${prefix}-div-${sign > 0 ? 'hi' : 'lo'}-${i}`, angle, fill, scheme, {
    ...options,
    coverage: baseCoverage * (0.5 + t),
  });
}

/** Wrap a texture def as a {@link PatternPaint} over the series colour. */
export function texturePaint(def: PatternDef, background: ColorString): PatternPaint {
  return { kind: 'pattern', def: def.id, background };
}

/**
 * The full set of categorical textures for a palette — one per slot, in slot
 * order, ready to drop into `Scene.defs`.
 */
export function categoricalTextures(
  palette: readonly ColorString[],
  scheme: ColorScheme,
  options: TextureOptions = {},
): PatternDef[] {
  return palette.map((c, i) => categoricalTexture(i, c, scheme, options));
}
