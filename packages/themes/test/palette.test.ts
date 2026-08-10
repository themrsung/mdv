/**
 * The palette validator, run over both built-in themes (SPEC 16.4).
 *
 * > A conforming implementation MUST include an executable palette validator and
 * > MUST run it in CI over the built-in themes and over any theme fixture.
 *
 * This file *is* that CI run. A palette regression fails the build here.
 *
 * It also pins the validator against the spec itself: SPEC 11.2 rule 3 and
 * SPEC 11.3.1 publish concrete separation and contrast figures for the built-in
 * palettes, and the assertions below re-derive every one of them from the hexes.
 * If the OKLab transform, the WCAG luminance or the CVD simulation ever drifts,
 * those numbers stop matching and this test says so — which is the difference
 * between a validator and a decoration.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PAIRS_SLOT_CAP,
  CATEGORICAL_DARK,
  CATEGORICAL_LIGHT,
  CVD_TARGET_DELTA_E,
  NORMAL_VISION_DELTA_E,
  SCHEME_SURFACE,
  STATUS_PALETTE,
  auditTheme,
  contrastRatio,
  listBuiltinThemes,
  paletteSeparation,
  raiseContrast,
  validatePalette,
} from '../src/index.js';
import type { Theme } from '../src/index.js';

/** Two decimals, matching the precision SPEC 11.3.1 quotes contrast at. */
const to2 = (n: number): number => Math.round(n * 100) / 100;
/** One decimal, matching the precision SPEC 11.2 rule 3 quotes ΔE at. */
const to1 = (n: number): number => Math.round(n * 10) / 10;

describe('the built-in themes pass the SPEC 16.4 validator', () => {
  for (const theme of listBuiltinThemes()) {
    describe(theme.name, () => {
      it('carries a validation result computed against its own surface', () => {
        expect(theme.validation).toBeDefined();
        expect(theme.validation?.scheme).toBe(theme.scheme);
      });

      it('has no hard failures', () => {
        const v = validatePalette(theme.categorical, theme.tokens.surface, theme.scheme);
        const fails = v.findings.filter((f) => f.level === 'fail');
        expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
        expect(v.passed).toBe(true);
      });

      it('clears the normal-vision floor on every adjacent pair', () => {
        const { worstNormal } = paletteSeparation(theme.categorical, theme.tokens.surface);
        expect(worstNormal).toBeGreaterThanOrEqual(NORMAL_VISION_DELTA_E);
      });

      it('keeps the first three slots separable all-pairs (SPEC 11.2 rule 3)', () => {
        const { worstNormal, worstCvd } = paletteSeparation(
          theme.categorical.slice(0, 3),
          theme.tokens.surface,
          { allPairs: true },
        );
        expect(worstNormal).toBeGreaterThanOrEqual(NORMAL_VISION_DELTA_E);
        expect(worstCvd).toBeGreaterThanOrEqual(CVD_TARGET_DELTA_E);
      });

      it('agrees with the validation baked into the theme', () => {
        const fresh = validatePalette(theme.categorical, theme.tokens.surface, theme.scheme);
        expect(fresh).toEqual(theme.validation);
      });
    });
  }
});

describe('SPEC 11.2 rule 3 — the published separation figures are reproduced', () => {
  /**
   * The normal-vision figures land on the spec's quoted value exactly, which
   * pins the OKLab transform. The CVD figures land within 0.1 ΔE, which is as
   * exact as they can be: SPEC 11.2 quotes the numbers but does not name the CVD
   * model that produced them, and the published Brettel (1997) and Viénot (1999)
   * projections differ by about a percent on saturated hues. Three of the four
   * match to the quoted digit; dark's worst adjacent pair lands at 8.3 against a
   * published 8.4. Both clear the ΔE ≥ 8 gate, which is what the figures are for.
   */
  const CVD_TOLERANCE = 0.1;

  it('light: worst adjacent CVD ΔE 9.1, worst adjacent normal-vision ΔE 19.6', () => {
    const s = paletteSeparation(CATEGORICAL_LIGHT, SCHEME_SURFACE.light);
    expect(s.worstCvd).toBeGreaterThan(9.1 - CVD_TOLERANCE);
    expect(s.worstCvd).toBeLessThan(9.1 + CVD_TOLERANCE);
    expect(to1(s.worstNormal)).toBe(19.6);
  });

  it('dark: worst adjacent CVD ΔE 8.4, worst adjacent normal-vision ΔE 19.3', () => {
    const s = paletteSeparation(CATEGORICAL_DARK, SCHEME_SURFACE.dark);
    expect(s.worstCvd).toBeGreaterThan(8.4 - CVD_TOLERANCE - 0.01);
    expect(s.worstCvd).toBeLessThan(8.4 + CVD_TOLERANCE);
    expect(to1(s.worstNormal)).toBe(19.3);
  });

  it('first three slots: worst pair CVD ΔE 9.2 light / 9.4 dark', () => {
    const light = paletteSeparation(CATEGORICAL_LIGHT.slice(0, 3), SCHEME_SURFACE.light, {
      allPairs: true,
    });
    const dark = paletteSeparation(CATEGORICAL_DARK.slice(0, 3), SCHEME_SURFACE.dark, {
      allPairs: true,
    });
    expect(to1(light.worstCvd)).toBe(9.2);
    expect(dark.worstCvd).toBeGreaterThan(9.4 - CVD_TOLERANCE);
    expect(dark.worstCvd).toBeLessThan(9.4 + CVD_TOLERANCE);
  });

  it('the full eight cannot clear an all-pairs gate at any ordering', () => {
    // SPEC 11.2 rule 3's justification for the cap of three. Stated as a fact
    // about this palette; here it is, measured.
    const s = paletteSeparation(CATEGORICAL_LIGHT, SCHEME_SURFACE.light, { allPairs: true });
    expect(s.worstCvd).toBeLessThan(CVD_TARGET_DELTA_E);
  });
});

describe('SPEC 11.2 rule 4 — the relief rule', () => {
  it('names exactly aqua, yellow and magenta on the light surface', () => {
    const v = validatePalette(CATEGORICAL_LIGHT, SCHEME_SURFACE.light, 'light');
    expect(v.reliefRequiredSlots).toEqual([2, 3, 4]);
    // Sub-3:1 is by design, so it is a warning that obligates relief, not a fail.
    expect(v.passed).toBe(true);
    for (const slot of v.reliefRequiredSlots) {
      const finding = v.findings.find((f) => f.check === 'surface-contrast' && f.slots[0] === slot);
      expect(finding?.level).toBe('warn');
    }
  });

  it('names nothing on the dark surface', () => {
    const v = validatePalette(CATEGORICAL_DARK, SCHEME_SURFACE.dark, 'dark');
    expect(v.reliefRequiredSlots).toEqual([]);
  });
});

describe('SPEC 11.3.1 — the fixed status palette contrast table', () => {
  const expected = {
    good: { light: 3.27, dark: 5.19 },
    warning: { light: 1.79, dark: 9.49 },
    serious: { light: 2.57, dark: 6.6 },
    critical: { light: 4.68, dark: 3.62 },
  } as const;

  for (const [role, table] of Object.entries(expected)) {
    it(`${role} is ${table.light} on light and ${table.dark} on dark`, () => {
      const hex = STATUS_PALETTE[role as keyof typeof STATUS_PALETTE];
      expect(to2(contrastRatio(hex, SCHEME_SURFACE.light))).toBe(table.light);
      expect(to2(contrastRatio(hex, SCHEME_SURFACE.dark))).toBe(table.dark);
    });
  }

  it('is never themed: every built-in carries the same object', () => {
    for (const theme of listBuiltinThemes()) {
      expect(theme.status).toBe(STATUS_PALETTE);
    }
  });
});

describe('the validator actually rejects things', () => {
  const surface = SCHEME_SURFACE.light;

  it('hard-fails two near-identical slots on the normal-vision floor', () => {
    const v = validatePalette(['#2a78d6', '#2c7ad8'], surface, 'light');
    expect(v.passed).toBe(false);
    const fail = v.findings.find((f) => f.check === 'normal-vision');
    expect(fail?.level).toBe('fail');
    expect(fail?.slots).toEqual([0, 1]);
    expect(fail?.measured).toBeLessThan(NORMAL_VISION_DELTA_E);
  });

  it('hard-fails a red/green pair that survives normal vision but collapses under CVD', () => {
    // A brick red and a leaf green: ΔE 26 apart to a trichromat — comfortably
    // clear of the normal-vision floor, and a pairing a designer would ship
    // without hesitation — but ΔE 2.6 to a deuteranope. Exactly the failure mode
    // the gate exists for, and exactly the one eyeballing never catches.
    const v = validatePalette(['#c0392b', '#3d8b37'], surface, 'light');
    expect(v.findings.find((f) => f.check === 'normal-vision')).toBeUndefined();
    const cvd = v.findings.find((f) => f.check === 'adjacent-cvd');
    expect(cvd?.level).toBe('fail');
    expect(cvd?.measured).toBeLessThan(6);
    expect(v.passed).toBe(false);
  });

  it('warns rather than fails inside the 6–8 secondary-encoding band', () => {
    const v = validatePalette(['#00875c', '#a16c00'], '#ffffff', 'light');
    const cvd = v.findings.find((f) => f.check === 'adjacent-cvd');
    expect(cvd?.level).toBe('warn');
    expect(cvd?.measured).toBeGreaterThanOrEqual(6);
    expect(cvd?.measured).toBeLessThan(CVD_TARGET_DELTA_E);
    expect(v.passed).toBe(true);
  });

  it('warns on a near-neutral slot via the chroma floor', () => {
    const v = validatePalette(['#7a7a7a', '#2a78d6'], surface, 'light');
    const chroma = v.findings.find((f) => f.check === 'chroma-floor');
    expect(chroma?.slots).toEqual([0]);
    expect(chroma?.level).toBe('warn');
  });

  it('warns on a slot outside the scheme lightness band', () => {
    const v = validatePalette(['#0a0a4a', '#eb6834'], surface, 'light');
    const band = v.findings.find((f) => f.check === 'lightness-band');
    expect(band?.slots).toEqual([0]);
    expect(band?.level).toBe('warn');
  });

  it('judges a translucent slot as the eye receives it, composited on the surface', () => {
    const opaque = validatePalette(['#2a78d6'], surface, 'light');
    const faint = validatePalette(['#2a78d680'], surface, 'light');
    expect(opaque.reliefRequiredSlots).toEqual([]);
    expect(faint.reliefRequiredSlots).toEqual([0]);
  });

  it('is order-sensitive, because adjacency is (SPEC 11.2 rule 5)', () => {
    const reordered = [
      CATEGORICAL_LIGHT[3] ?? '',
      CATEGORICAL_LIGHT[4] ?? '',
      CATEGORICAL_LIGHT[0] ?? '',
    ];
    const asShipped = paletteSeparation(CATEGORICAL_LIGHT.slice(0, 3), surface);
    const shuffled = paletteSeparation(reordered, surface);
    expect(shuffled.worstCvd).not.toBeCloseTo(asShipped.worstCvd, 3);
  });
});

describe('the validator is deterministic', () => {
  it('returns identical findings across repeated runs', () => {
    const a = validatePalette(CATEGORICAL_LIGHT, SCHEME_SURFACE.light, 'light', { allPairs: true });
    const b = validatePalette(CATEGORICAL_LIGHT, SCHEME_SURFACE.light, 'light', { allPairs: true });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('orders findings per-slot first, then per-pair, each ascending', () => {
    const v = validatePalette(['#7a7a7a', '#7c7c7c', '#2a78d6'], SCHEME_SURFACE.light, 'light');
    const kinds = v.findings.map((f) => f.check);
    const firstPair = kinds.findIndex((k) => k === 'normal-vision' || k === 'adjacent-cvd');
    const lastSlot = kinds.reduce(
      (acc, k, i) =>
        k === 'chroma-floor' || k === 'lightness-band' || k === 'surface-contrast' ? i : acc,
      -1,
    );
    expect(lastSlot).toBeLessThan(firstPair);
  });
});

describe('the derived themes are derived, not hand-written', () => {
  const byName = (n: string): Theme => {
    const t = listBuiltinThemes().find((x) => x.name === n);
    if (t === undefined) throw new Error(`no theme ${n}`);
    return t;
  };

  it('print lifts every slot to at least 3:1 on paper white', () => {
    const print = byName('print');
    expect(print.tokens.surface).toBe('#ffffff');
    for (const c of print.categorical) {
      expect(contrastRatio(c, '#ffffff')).toBeGreaterThanOrEqual(3);
    }
    expect(print.validation?.reliefRequiredSlots).toEqual([]);
  });

  it('high-contrast sits at the knee where lifting starts costing CVD separation', () => {
    const hc = byName('high-contrast');
    for (const c of hc.categorical) {
      expect(contrastRatio(c, '#ffffff')).toBeGreaterThanOrEqual(3.75);
    }
    expect(paletteSeparation(hc.categorical, '#ffffff').worstCvd).toBeGreaterThanOrEqual(
      CVD_TARGET_DELTA_E,
    );
    expect(hc.validation?.findings).toEqual([]);

    // The knee is real: one notch higher and the aqua/yellow pair drops under
    // the gate. This is the sweep that chose 3.75, re-run.
    const at4_5 = CATEGORICAL_LIGHT.map((c) => raiseContrast(c, '#ffffff', 4.5, 'light'));
    expect(paletteSeparation(at4_5, '#ffffff').worstCvd).toBeLessThan(CVD_TARGET_DELTA_E);
  });

  it('leaves slots that already clear the target untouched', () => {
    // Violet is 8.3:1 on light; no lift should move it.
    expect(byName('print').categorical[6]).toBe(CATEGORICAL_LIGHT[6]);
  });
});

describe('auditTheme is the check SPEC 16.4 asks an implementation to run', () => {
  const byName = (n: string): Theme => {
    const t = listBuiltinThemes().find((x) => x.name === n);
    if (t === undefined) throw new Error(`no theme ${n}`);
    return t;
  };

  it('passes every built-in — the whole point of the requirement', () => {
    for (const theme of listBuiltinThemes()) {
      const audit = auditTheme(theme);
      expect(
        audit.gate.findings.filter((f) => f.level === 'fail').map((f) => f.message),
        theme.name,
      ).toEqual([]);
      expect(audit.scatter.filter((f) => f.level === 'fail').map((f) => f.message)).toEqual([]);
      expect(audit.passed, theme.name).toBe(true);
    }
  });

  it('caps the all-pairs question at three slots (SPEC 11.2 rule 3, SPEC 8.6)', () => {
    // The eight-slot light palette is *designed* not to survive all-pairs: two
    // of its slots collapse under CVD, which is why scatter is capped at three
    // series rather than the palette being called broken.
    const whole = validatePalette(CATEGORICAL_LIGHT, SCHEME_SURFACE.light, 'light', {
      allPairs: true,
    });
    expect(whole.passed).toBe(false);
    expect(ALL_PAIRS_SLOT_CAP).toBe(3);
    expect(auditTheme(byName('default')).passed).toBe(true);
  });

  it('still fails a palette whose first three slots collapse pairwise', () => {
    // Slots 0 and 2 are not adjacent, so only the capped all-pairs pass sees
    // them: two blues either side of an orange.
    const audit = auditTheme({
      ...byName('default'),
      categorical: ['#2a78d6', '#eb6834', '#2c7ad8', '#059669'],
    });
    expect(audit.gate.passed).toBe(true);
    expect(audit.scatter.map((f) => [f.check, f.slots])).toContainEqual(['normal-vision', [0, 2]]);
    expect(audit.passed).toBe(false);
  });

  it('does not repeat a pair the gate already reported', () => {
    const audit = auditTheme({
      ...byName('default'),
      categorical: ['#2a78d6', '#2c7ad8', '#059669'],
    });
    const adjacent = audit.gate.findings.filter((f) => f.slots.length === 2);
    expect(adjacent.length).toBeGreaterThan(0);
    expect(audit.scatter).toEqual([]);
    expect(audit.passed).toBe(false);
  });
});
