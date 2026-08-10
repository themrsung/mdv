/**
 * The texture channel (SPEC 12.6).
 *
 * > Where hue fails (full-severity CVD, grayscale print, `forced-colors`),
 * > texture carries identity: **one directional fill at 45° and its 135° mirror
 * > only** — never horizontal or vertical, which read as gridlines or bars —
 * > inked tone-on-tone from the fill's own ramp, equal loudness across slots.
 *
 * Two angles, not eight: a texture set that reaches for dots, crosses and
 * chevrons to cover eight slots has abandoned equal loudness, and the loud tiles
 * then read as "more". With two angles and eight hues the pair is unambiguous
 * under every CVD type, which is the job.
 *
 * Triggered by `accessibility.texture: true`, by print, or by `forced-colors` —
 * **never on by default**.
 */

import type { IdFactory } from '../types/layout.js';
import type { PatternDef } from '../types/scene.js';
import type { ColorString } from '../types/theme.js';
import { mixColors, parseColor, toHex } from '../scale/color.js';

/** Tile edge in px. One stripe per tile keeps density identical across slots. */
export const TEXTURE_TILE = 6;
/** Stripe width in px. */
export const TEXTURE_STRIPE = 2;
/** How far the stripe is inked away from its background, 0…1. */
const TONE_SHIFT = 0.38;

/** The two permitted angles, in slot order. */
export const TEXTURE_ANGLES: readonly number[] = Object.freeze([45, 135]);

/**
 * Build one texture def per palette slot.
 *
 * The stripe colour is derived from the slot's own colour — *tone-on-tone* —
 * rather than being a fixed black, so the tile keeps the slot's identity and no
 * slot shouts louder than another.
 *
 * @param colors - the categorical palette, in slot order
 * @param ink - the theme's `text-primary`, the direction tones shift toward on a
 * light surface
 */
export function buildTextureDefs(
  colors: readonly ColorString[],
  ink: ColorString,
  ids: IdFactory,
): { defs: PatternDef[]; idsBySlot: string[] } {
  const defs: PatternDef[] = [];
  const idsBySlot: string[] = [];

  for (let slot = 0; slot < colors.length; ++slot) {
    const base = colors[slot] as ColorString;
    const angle = TEXTURE_ANGLES[slot % TEXTURE_ANGLES.length] as number;
    const id = ids.next('texture');
    idsBySlot.push(id);
    defs.push({
      kind: 'pattern',
      id,
      width: TEXTURE_TILE,
      height: TEXTURE_TILE,
      angle,
      content: [
        {
          kind: 'rect',
          x: 0,
          y: 0,
          w: TEXTURE_TILE,
          h: TEXTURE_TILE,
          fill: { kind: 'solid', color: base },
        },
        // A single stripe, drawn in tile space. The tile's own `angle` carries
        // the 45°/135° rotation, so the geometry here is the same for both and
        // the two tiles are exact mirrors.
        {
          kind: 'rect',
          x: 0,
          y: (TEXTURE_TILE - TEXTURE_STRIPE) / 2,
          w: TEXTURE_TILE,
          h: TEXTURE_STRIPE,
          fill: { kind: 'solid', color: toneShift(base, ink) },
        },
      ],
    });
  }

  return { defs, idsBySlot };
}

/** Shift a colour toward the ink by {@link TONE_SHIFT}, staying in its own ramp. */
export function toneShift(base: ColorString, ink: ColorString): ColorString {
  const from = parseColor(base);
  const to = parseColor(ink);
  if (from === undefined || to === undefined) return base;
  return toHex(mixColors(from, to, TONE_SHIFT));
}
