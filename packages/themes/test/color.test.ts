/**
 * The colour primitives, against known reference values.
 *
 * These are the foundations everything else in the package stands on, so they
 * are checked against externally-known answers — Ottosson's published OKLab
 * examples, the WCAG worked examples, and the structural invariants of the
 * Brettel projections — rather than against this implementation's own output.
 */

import { describe, expect, it } from 'vitest';
import {
  CVD_TYPES,
  contrastRatio,
  deltaEOklab,
  formatHex,
  gamutMap,
  inGamut,
  oklabToOklch,
  oklabToRgb,
  oklchToOklab,
  parseColor,
  projectionRowSums,
  relativeLuminance,
  rgbToOklab,
  simulateCvd,
  toOklab,
  toOklch,
} from '../src/index.js';

describe('the CSS colour parser', () => {
  it('reads every hex length', () => {
    expect(formatHex(parseColor('#f00'))).toBe('#ff0000');
    expect(formatHex(parseColor('#ff0000'))).toBe('#ff0000');
    expect(formatHex(parseColor('#2a78d6'))).toBe('#2a78d6');
    expect(parseColor('#00000080').a).toBeCloseTo(128 / 255, 6);
    expect(parseColor('#0008').a).toBeCloseTo(136 / 255, 6);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(formatHex(parseColor('  #2A78D6 '))).toBe('#2a78d6');
  });

  it('reads rgb() in both syntaxes', () => {
    expect(formatHex(parseColor('rgb(42, 120, 214)'))).toBe('#2a78d6');
    expect(formatHex(parseColor('rgb(42 120 214)'))).toBe('#2a78d6');
    expect(parseColor('rgba(11,11,11,0.10)').a).toBeCloseTo(0.1, 6);
    expect(parseColor('rgb(11 11 11 / 10%)').a).toBeCloseTo(0.1, 6);
  });

  it('reads hsl()', () => {
    expect(formatHex(parseColor('hsl(0 100% 50%)'))).toBe('#ff0000');
    expect(formatHex(parseColor('hsl(120, 100%, 50%)'))).toBe('#00ff00');
    expect(formatHex(parseColor('hsl(240 100% 50%)'))).toBe('#0000ff');
    expect(formatHex(parseColor('hsl(0 0% 50%)'))).toBe('#808080');
  });

  it('reads oklch() and round-trips it', () => {
    const lch = toOklch('#2a78d6');
    const spelled = `oklch(${lch.L} ${lch.C} ${lch.h}deg)`;
    expect(formatHex(parseColor(spelled))).toBe('#2a78d6');
  });

  it('reads named colours and `transparent`', () => {
    expect(formatHex(parseColor('rebeccapurple'))).toBe('#663399');
    expect(formatHex(parseColor('WHITE'))).toBe('#ffffff');
    expect(parseColor('transparent').a).toBe(0);
  });

  it('throws MdvConfigError rather than substituting black', () => {
    expect(() => parseColor('not-a-colour')).toThrow(/Cannot parse color/);
    expect(() => parseColor('#12345')).toThrow(/Cannot parse color/);
    expect(() => parseColor('')).toThrow(/Cannot parse color/);
    expect(() => parseColor('lab(50 20 30)')).toThrow(/unsupported color function/);
  });
});

describe('OKLab', () => {
  // Ottosson's published sRGB → OKLab examples, to the precision he quotes.
  it('maps white to L = 1, a = b = 0', () => {
    const w = toOklab('#ffffff');
    expect(w.L).toBeCloseTo(1, 5);
    expect(w.a).toBeCloseTo(0, 5);
    expect(w.b).toBeCloseTo(0, 5);
  });

  it('maps black to the origin', () => {
    const k = toOklab('#000000');
    expect(k.L).toBeCloseTo(0, 6);
    expect(k.a).toBeCloseTo(0, 6);
    expect(k.b).toBeCloseTo(0, 6);
  });

  it('maps sRGB red, green and blue to their published coordinates', () => {
    const r = toOklab('#ff0000');
    expect(r.L).toBeCloseTo(0.6279, 3);
    expect(r.a).toBeCloseTo(0.2249, 3);
    expect(r.b).toBeCloseTo(0.1258, 3);

    const g = toOklab('#00ff00');
    expect(g.L).toBeCloseTo(0.8664, 3);
    expect(g.a).toBeCloseTo(-0.2339, 3);
    expect(g.b).toBeCloseTo(0.1795, 3);

    const b = toOklab('#0000ff');
    expect(b.L).toBeCloseTo(0.452, 3);
    expect(b.a).toBeCloseTo(-0.0324, 3);
    expect(b.b).toBeCloseTo(-0.3115, 3);
  });

  it('keeps a neutral grey neutral', () => {
    for (const hex of ['#111111', '#808080', '#cccccc']) {
      const c = toOklab(hex);
      expect(Math.hypot(c.a, c.b)).toBeLessThan(1e-6);
    }
  });

  it('round-trips sRGB → OKLab → sRGB to within a quantisation step', () => {
    for (const hex of ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#0d366b', '#fcfcfb']) {
      expect(formatHex(oklabToRgb(toOklab(hex)))).toBe(hex);
    }
  });

  it('round-trips OKLab ↔ OKLCh', () => {
    const lab = toOklab('#e87ba4');
    const back = oklchToOklab(oklabToOklch(lab));
    expect(back.L).toBeCloseTo(lab.L, 10);
    expect(back.a).toBeCloseTo(lab.a, 10);
    expect(back.b).toBeCloseTo(lab.b, 10);
  });

  it('reports ΔE 0 for a colour against itself and is symmetric', () => {
    expect(deltaEOklab('#2a78d6', '#2a78d6')).toBe(0);
    expect(deltaEOklab('#2a78d6', '#eb6834')).toBeCloseTo(deltaEOklab('#eb6834', '#2a78d6'), 12);
  });

  it('scales ΔE ×100, so black-to-white is ~100', () => {
    expect(deltaEOklab('#000000', '#ffffff')).toBeCloseTo(100, 2);
  });
});

describe('gamut mapping', () => {
  it('leaves an in-gamut colour alone', () => {
    expect(formatHex(gamutMap(toOklch('#2a78d6')))).toBe('#2a78d6');
  });

  it('reduces chroma, not lightness, to reach the gamut', () => {
    const wild = { L: 0.6, C: 0.9, h: 150 };
    expect(inGamut(gamutMap(wild))).toBe(true);
    const mapped = oklabToOklch(rgbToOklab(gamutMap(wild)));
    expect(mapped.L).toBeCloseTo(0.6, 2);
    expect(mapped.h).toBeCloseTo(150, 0);
    expect(mapped.C).toBeLessThan(0.9);
  });

  it('is deterministic', () => {
    expect(formatHex(gamutMap({ L: 0.7, C: 0.5, h: 30 }))).toBe(
      formatHex(gamutMap({ L: 0.7, C: 0.5, h: 30 })),
    );
  });
});

describe('WCAG contrast', () => {
  it('reproduces the anchors: black on white is 21:1, a colour on itself is 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('#2a78d6', '#2a78d6')).toBeCloseTo(1, 12);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#2a78d6', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#2a78d6'), 12);
  });

  it('uses the WCAG luminance coefficients', () => {
    expect(relativeLuminance(parseColor('#ffffff'))).toBeCloseTo(1, 9);
    expect(relativeLuminance(parseColor('#000000'))).toBeCloseTo(0, 9);
    expect(relativeLuminance(parseColor('#ff0000'))).toBeCloseTo(0.2126, 6);
    expect(relativeLuminance(parseColor('#00ff00'))).toBeCloseTo(0.7152, 6);
    expect(relativeLuminance(parseColor('#0000ff'))).toBeCloseTo(0.0722, 6);
  });

  it('composites a translucent colour before measuring', () => {
    // The `border` token: 10 % ink on the light surface is a hairline, not text.
    expect(contrastRatio('rgba(11,11,11,0.10)', '#fcfcfb')).toBeLessThan(1.2);
    expect(contrastRatio('#0b0b0b', '#fcfcfb')).toBeGreaterThan(18);
  });
});

describe('CVD simulation (Brettel–Viénot–Mollon 1997)', () => {
  it('fixes the neutral axis: every projection row sums to 1', () => {
    for (const type of CVD_TYPES) {
      for (const sum of projectionRowSums(type)) {
        expect(sum).toBeCloseTo(1, 4);
      }
    }
  });

  it('leaves greys unchanged, which is the observable form of that invariant', () => {
    for (const type of CVD_TYPES) {
      for (const hex of ['#000000', '#404040', '#808080', '#c0c0c0', '#ffffff']) {
        expect(formatHex(simulateCvd(parseColor(hex), type))).toBe(hex);
      }
    }
  });

  it('collapses red and green for a deuteranope', () => {
    const sim = (hex: string, type: 'protanopia' | 'deuteranopia' | 'tritanopia'): string =>
      formatHex(simulateCvd(parseColor(hex), type));

    // Deuteranopia is the pure hue collapse: the two map to nearly one yellow.
    expect(deltaEOklab(sim('#c0392b', 'deuteranopia'), sim('#3d8b37', 'deuteranopia'))).toBeLessThan(6);

    // A protanope also loses the hue difference, but *gains* a lightness one:
    // protanopia suppresses long-wavelength luminance, so the red darkens while
    // the green does not. The pair stays separable — which is precisely why the
    // gate takes the minimum over both dichromacies rather than either alone.
    expect(
      deltaEOklab(sim('#c0392b', 'protanopia'), sim('#3d8b37', 'protanopia')),
    ).toBeGreaterThan(6);

    // A tritanope keeps the red–green axis intact; that is why tritanopia is
    // excluded from the gate and handed to the texture channel instead.
    expect(deltaEOklab(sim('#c0392b', 'tritanopia'), sim('#3d8b37', 'tritanopia'))).toBeGreaterThan(15);
  });

  it('collapses blue and green for tritanopes but not for the other two', () => {
    const blue = parseColor('#2a78d6');
    const aqua = parseColor('#1baf7a');
    const tri = deltaEOklab(
      formatHex(simulateCvd(blue, 'tritanopia')),
      formatHex(simulateCvd(aqua, 'tritanopia')),
    );
    const deut = deltaEOklab(
      formatHex(simulateCvd(blue, 'deuteranopia')),
      formatHex(simulateCvd(aqua, 'deuteranopia')),
    );
    expect(tri).toBeLessThan(deut);
  });

  it('preserves alpha', () => {
    expect(simulateCvd({ r: 0.8, g: 0.2, b: 0.2, a: 0.5 }, 'protanopia').a).toBe(0.5);
  });

  it('treats severity 0 as a no-op and severity 1 as full dichromacy', () => {
    const c = parseColor('#eb6834');
    expect(formatHex(simulateCvd(c, 'deuteranopia', 0))).toBe('#eb6834');
    const full = simulateCvd(c, 'deuteranopia', 1);
    const half = simulateCvd(c, 'deuteranopia', 0.5);
    expect(deltaEOklab(formatHex(half), '#eb6834')).toBeLessThan(
      deltaEOklab(formatHex(full), '#eb6834'),
    );
  });

  it('stays inside the gamut', () => {
    for (const type of CVD_TYPES) {
      for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff']) {
        const out = simulateCvd(parseColor(hex), type);
        expect(inGamut(out)).toBe(true);
      }
    }
  });

  it('is idempotent: simulating twice changes nothing further', () => {
    for (const type of CVD_TYPES) {
      const once = simulateCvd(parseColor('#eb6834'), type);
      const twice = simulateCvd(once, type);
      expect(deltaEOklab(formatHex(once), formatHex(twice))).toBeLessThan(1);
    }
  });
});
