/**
 * Colour-vision-deficiency simulation (SPEC 12.6, 16.4).
 *
 * The palette validator needs to know what a dichromat actually sees, so this is
 * a real simulation, not a table of pre-blessed hexes.
 *
 * **Method: Brettel, Viénot & Mollon (1997).** A dichromat's gamut is the union
 * of two half-planes in LMS space, each spanned by the neutral axis and one
 * anchor stimulus; a colour is projected onto whichever half-plane its side of
 * the separation plane selects. This is the reference method — the simpler
 * Viénot (1999) single-plane shortcut is adequate for protan/deutan but visibly
 * wrong for tritan, and the validator must not be wrong anywhere.
 *
 * The projection operators below are pre-composed into linear-sRGB space, so one
 * 3×3 multiply replaces the RGB→LMS→project→LMS→RGB chain. Their defining
 * property — and the invariant `cvd.test.ts` asserts — is that **every row sums
 * to 1**: the neutral axis is fixed, so a dichromat sees grey as grey.
 */

import type { Rgb } from './rgb.js';
import { clamp01, decodeGamma, encodeGamma } from './rgb.js';

/** The three dichromacies simulated. Anomalous trichromacy is a severity < 1 blend. */
export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

/** Every simulated deficiency, in a fixed order so findings are deterministic. */
export const CVD_TYPES: readonly CvdType[] = Object.freeze([
  'protanopia',
  'deuteranopia',
  'tritanopia',
]);

/** A row-major 3×3 operating on linear sRGB. */
type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

interface BrettelParams {
  /** Projection for the half-plane on the positive side of {@link normal}. */
  readonly planeA: Matrix3;
  /** Projection for the other half-plane. */
  readonly planeB: Matrix3;
  /** Normal of the separation plane, in linear sRGB. */
  readonly normal: readonly [number, number, number];
}

const BRETTEL: Readonly<Record<CvdType, BrettelParams>> = Object.freeze({
  protanopia: {
    planeA: [0.1451, 1.20165, -0.34675, 0.10447, 0.85316, 0.04237, 0.00429, -0.00603, 1.00174],
    planeB: [0.14115, 1.16782, -0.30897, 0.10495, 0.8573, 0.03776, 0.00431, -0.00586, 1.00155],
    normal: [0.00048, 0.00393, -0.00441],
  },
  deuteranopia: {
    planeA: [0.36198, 0.86755, -0.22953, 0.26099, 0.64512, 0.09389, -0.01975, 0.02686, 0.99289],
    planeB: [0.37009, 0.8854, -0.25549, 0.25767, 0.63782, 0.10451, -0.0195, 0.02741, 0.99209],
    normal: [-0.00281, -0.00611, 0.00892],
  },
  tritanopia: {
    planeA: [1.01354, 0.14268, -0.15622, -0.01181, 0.87561, 0.13619, 0.07707, 0.81208, 0.11085],
    planeB: [0.93337, 0.19999, -0.13336, 0.05809, 0.82565, 0.11626, -0.37923, 1.13825, 0.24098],
    normal: [0.0396, -0.02831, -0.01129],
  },
});

function at(m: Matrix3, i: number): number {
  // noUncheckedIndexedAccess: the tuple type guarantees 0…8, but the compiler
  // still widens a computed index. One narrowing helper beats nine assertions.
  return m[i] ?? 0;
}

/**
 * Simulate a dichromatic observer.
 *
 * @param color - the stimulus; alpha passes through untouched
 * @param type - which dichromacy
 * @param severity - `1` is full dichromacy, which is what SPEC 12.6's
 * "full-severity CVD" and the SPEC 16.4 gates mean. Values in `0…1` linearly
 * blend towards the original, modelling anomalous trichromacy.
 */
export function simulateCvd(color: Rgb, type: CvdType, severity = 1): Rgb {
  const p = BRETTEL[type];
  const r = decodeGamma(color.r);
  const g = decodeGamma(color.g);
  const b = decodeGamma(color.b);

  const side = r * p.normal[0] + g * p.normal[1] + b * p.normal[2];
  const m = side >= 0 ? p.planeA : p.planeB;

  const sr = at(m, 0) * r + at(m, 1) * g + at(m, 2) * b;
  const sg = at(m, 3) * r + at(m, 4) * g + at(m, 5) * b;
  const sb = at(m, 6) * r + at(m, 7) * g + at(m, 8) * b;

  const t = severity <= 0 ? 0 : severity >= 1 ? 1 : severity;
  return {
    r: clamp01(encodeGamma(sr * t + r * (1 - t))),
    g: clamp01(encodeGamma(sg * t + g * (1 - t))),
    b: clamp01(encodeGamma(sb * t + b * (1 - t))),
    a: color.a,
  };
}

/** Row sums of the projection operators, for the neutral-axis invariant test. */
export function projectionRowSums(type: CvdType): readonly number[] {
  const p = BRETTEL[type];
  const sums: number[] = [];
  for (const m of [p.planeA, p.planeB]) {
    for (let row = 0; row < 3; row += 1) {
      sums.push(at(m, row * 3) + at(m, row * 3 + 1) + at(m, row * 3 + 2));
    }
  }
  return sums;
}
