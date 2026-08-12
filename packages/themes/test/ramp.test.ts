/**
 * The named ramps a theme carries (SPEC 11.3, SPEC 8.9).
 *
 * `scheme: green` on a heatmap has to land on *listed* steps, not on a ramp
 * derived at render time: two machines that disagree by a rounding mode stop
 * producing the same document (SPEC 24.3). The ramps are therefore built once,
 * at theme construction, and pinned here — one per categorical slot, keyed by
 * the hue names SPEC 11.2 gives those slots.
 *
 * The properties that matter to a reader are the ones asserted: the ramp runs
 * light → dark without reversing anywhere (a ramp that doubles back cannot be
 * ranked by eye), it stays one hue, and the slot the theme's own sequential ramp
 * occupies keeps that hand-selected ramp rather than a generated approximation
 * of it — so `scheme: blue` and no `scheme` at all are the same picture on every
 * built-in.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME_NAMES, getBuiltinTheme } from '../src/builtin.js';
import { CATEGORICAL_HUE_NAMES, relativeLuminance } from '@mdv/core';
import { oklabToOklch, rgbToOklab } from '../src/color/oklab.js';
import { parseColor } from '../src/color/rgb.js';

/** Hue angle in OKLCh degrees, for the "still one hue" check. */
function hueOf(color: string): number {
  const rgb = parseColor(color);
  if (rgb === undefined) throw new Error(`unparseable ${color}`);
  return oklabToOklch(rgbToOklab(rgb)).h;
}

/** Smallest angle between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe('theme ramps (SPEC 11.3)', () => {
  for (const name of BUILTIN_THEME_NAMES) {
    describe(name, () => {
      const theme = getBuiltinTheme(name);
      const ramps = theme.ramps ?? {};

      it('carries one ramp per categorical slot, keyed by hue name', () => {
        expect(Object.keys(ramps)).toEqual([...CATEGORICAL_HUE_NAMES]);
      });

      it('names the same ramp for `blue` that the theme uses by default', () => {
        // The built-ins' sequential anchor *is* the blue slot, so asking for it
        // by name must not quietly hand back a second, generated blue.
        expect(ramps['blue']?.steps).toEqual(theme.sequential.steps);
        expect(ramps['blue']?.hue).toBe(theme.sequential.hue);
      });

      for (const hue of CATEGORICAL_HUE_NAMES) {
        describe(hue, () => {
          const ramp = ramps[hue];

          it('runs light to dark, monotonically', () => {
            expect(ramp).toBeDefined();
            const luminance = ramp!.steps.map((step) => relativeLuminance(step));
            expect(luminance.length).toBeGreaterThanOrEqual(2);
            for (let i = 1; i < luminance.length; i += 1) {
              // Strictly darker: equal neighbours are two steps a reader cannot
              // separate, which is a step that should not have been emitted.
              expect(luminance[i]!).toBeLessThan(luminance[i - 1]!);
            }
          });

          it('stays one hue', () => {
            // Never a rainbow (SPEC 11.3). Gamut mapping bends hue a little at
            // the dark end — hence a tolerance rather than equality — but a ramp
            // that wanders more than this has changed colour on the reader.
            const hues = ramp!.steps.map((step) => hueOf(step));
            for (const h of hues) {
              expect(hueGap(h, hues[0]!)).toBeLessThan(35);
            }
          });

          it('bounds the ordinal-safe window inside the ramp', () => {
            // SPEC 11.3's ordinal rule: the window of steps that clear 3:1
            // against the surface. Empty is legal (and reported as floor >
            // ceiling); nonsense is not.
            const { ordinalFloor, ordinalCeiling, steps } = ramp!;
            expect(ordinalFloor).toBeGreaterThanOrEqual(0);
            expect(ordinalCeiling).toBeLessThan(steps.length);
          });
        });
      }
    });
  }

  it('generates the seven slots that are not the sequential anchor', () => {
    // A generated ramp passes through its slot colour, so the slot is what the
    // reader recognises the series by even after it is ramped.
    const theme = getBuiltinTheme('default');
    for (const [index, hue] of CATEGORICAL_HUE_NAMES.entries()) {
      if (hue === 'blue') continue;
      const slot = theme.categorical[index]!;
      const ramp = theme.ramps?.[hue];
      expect(
        hueGap(hueOf(ramp!.steps[Math.floor(ramp!.steps.length / 2)]!), hueOf(slot)),
      ).toBeLessThan(35);
    }
  });

  it('gives every built-in the same number of steps', () => {
    // Ramps are compared across themes by goldens; a light/dark pair that
    // disagreed on step count would not be the same chart in two schemes.
    const counts = new Set(
      BUILTIN_THEME_NAMES.flatMap((name) =>
        Object.values(getBuiltinTheme(name).ramps ?? {}).map((ramp) => ramp.steps.length),
      ),
    );
    expect([...counts]).toHaveLength(1);
  });
});
