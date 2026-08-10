/**
 * Geometry the PDF operator set does not have natively.
 *
 * PDF knows lines, cubics and rectangles. The scene graph also knows elliptical
 * arcs, circles and per-corner rounded rectangles, and SPEC 20 is explicit that
 * the conversion belongs **in the backend**, not in layout: doing it here keeps
 * arc geometry exact for SVG while giving PDF something it can draw.
 */

import type { ArcCommand, PathCommand, RectNode } from '@mdv/core';

/** The circular-arc Bézier constant: `4/3 · tan(π/8)`. */
export const KAPPA = 0.5522847498307936;

/** An axis-aligned bounding box in scene coordinates. */
export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The empty box, which unions to whatever it meets. */
export function emptyBbox(): Bbox {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

/** Grow `box` to include `(x, y)`. Mutates and returns `box`. */
export function growBbox(box: Bbox, x: number, y: number): Bbox {
  if (x < box.minX) box.minX = x;
  if (y < box.minY) box.minY = y;
  if (x > box.maxX) box.maxX = x;
  if (y > box.maxY) box.maxY = y;
  return box;
}

/** `true` when the box never grew. */
export function isEmptyBbox(box: Bbox): boolean {
  return !(box.maxX >= box.minX && box.maxY >= box.minY);
}

/**
 * Bounding box of a command list.
 *
 * Control points are included rather than solving for curve extrema: the box is
 * used to map `objectBoundingBox` gradients, where a few tenths of a pixel of
 * slack is invisible, and an exact solve would cost more than it buys.
 */
export function pathBbox(commands: readonly PathCommand[]): Bbox {
  const box = emptyBbox();
  for (const c of commands) {
    switch (c.c) {
      case 'M':
      case 'L':
        growBbox(box, c.x, c.y);
        break;
      case 'C':
        growBbox(box, c.x1, c.y1);
        growBbox(box, c.x2, c.y2);
        growBbox(box, c.x, c.y);
        break;
      case 'Q':
        growBbox(box, c.x1, c.y1);
        growBbox(box, c.x, c.y);
        break;
      case 'A':
        growBbox(box, c.x, c.y);
        break;
      case 'Z':
        break;
    }
  }
  return box;
}

/** Normalise `RectNode.r` into four corner radii, clamped to the rectangle. */
export function cornerRadii(node: RectNode): [number, number, number, number] {
  const r = node.r;
  if (r === undefined) return [0, 0, 0, 0];
  const raw: [number, number, number, number] = typeof r === 'number' ? [r, r, r, r] : [...r];
  const limit = Math.min(Math.abs(node.w), Math.abs(node.h)) / 2;
  return [
    Math.max(0, Math.min(raw[0], limit)),
    Math.max(0, Math.min(raw[1], limit)),
    Math.max(0, Math.min(raw[2], limit)),
    Math.max(0, Math.min(raw[3], limit)),
  ];
}

/**
 * A rounded rectangle as structured commands, corners in
 * `[topLeft, topRight, bottomRight, bottomLeft]` order.
 *
 * Bars are rounded at the data end and square at the baseline (SPEC 11.4),
 * which is exactly why the per-corner form has to survive into the PDF.
 */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  radii: readonly [number, number, number, number],
): PathCommand[] {
  const [tl, tr, br, bl] = radii;
  const k = KAPPA;
  const out: PathCommand[] = [];
  out.push({ c: 'M', x: x + tl, y });
  out.push({ c: 'L', x: x + w - tr, y });
  if (tr > 0) {
    out.push({
      c: 'C',
      x1: x + w - tr + tr * k,
      y1: y,
      x2: x + w,
      y2: y + tr - tr * k,
      x: x + w,
      y: y + tr,
    });
  }
  out.push({ c: 'L', x: x + w, y: y + h - br });
  if (br > 0) {
    out.push({
      c: 'C',
      x1: x + w,
      y1: y + h - br + br * k,
      x2: x + w - br + br * k,
      y2: y + h,
      x: x + w - br,
      y: y + h,
    });
  }
  out.push({ c: 'L', x: x + bl, y: y + h });
  if (bl > 0) {
    out.push({
      c: 'C',
      x1: x + bl - bl * k,
      y1: y + h,
      x2: x,
      y2: y + h - bl + bl * k,
      x,
      y: y + h - bl,
    });
  }
  out.push({ c: 'L', x, y: y + tl });
  if (tl > 0) {
    out.push({ c: 'C', x1: x, y1: y + tl - tl * k, x2: x + tl - tl * k, y2: y, x: x + tl, y });
  }
  out.push({ c: 'Z' });
  return out;
}

/** A circle as four cubic segments. */
export function circlePath(cx: number, cy: number, r: number): PathCommand[] {
  const k = r * KAPPA;
  return [
    { c: 'M', x: cx + r, y: cy },
    { c: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
    { c: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
    { c: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
    { c: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
    { c: 'Z' },
  ];
}

/** One cubic segment of an arc, in absolute coordinates. */
interface Cubic {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
}

function arcSegment(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  cosPhi: number,
  sinPhi: number,
  theta: number,
  delta: number,
): Cubic {
  const t = (4 / 3) * Math.tan(delta / 4);
  const cos1 = Math.cos(theta);
  const sin1 = Math.sin(theta);
  const cos2 = Math.cos(theta + delta);
  const sin2 = Math.sin(theta + delta);

  const p1x = cos1 - t * sin1;
  const p1y = sin1 + t * cos1;
  const p2x = cos2 + t * sin2;
  const p2y = sin2 - t * cos2;

  const map = (ux: number, uy: number): [number, number] => [
    cx + rx * ux * cosPhi - ry * uy * sinPhi,
    cy + rx * ux * sinPhi + ry * uy * cosPhi,
  ];
  const [x1, y1] = map(p1x, p1y);
  const [x2, y2] = map(p2x, p2y);
  const [x, y] = map(cos2, sin2);
  return { x1, y1, x2, y2, x, y };
}

/**
 * Convert an SVG elliptical arc to cubic segments (F.6 of the SVG spec).
 *
 * Degenerate cases follow the SVG rules exactly: a zero radius becomes a
 * straight line, and out-of-range radii are scaled up rather than rejected —
 * the alternative is a silently missing wedge in a donut chart.
 */
export function arcToCubics(from: { x: number; y: number }, arc: ArcCommand): Cubic[] {
  const { x: x2, y: y2 } = arc;
  const x1 = from.x;
  const y1 = from.y;
  let rx = Math.abs(arc.rx);
  let ry = Math.abs(arc.ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    return [{ x1, y1, x2, y2, x: x2, y: y2 }];
  }
  const phi = (arc.rotate * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = arc.largeArc === arc.sweep ? -1 : 1;
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coefficient = denominator === 0 ? 0 : sign * Math.sqrt(Math.max(0, numerator / denominator));
  const cxp = (coefficient * (rx * y1p)) / ry;
  const cyp = (coefficient * -(ry * x1p)) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    if (len === 0) return 0;
    const clamped = Math.max(-1, Math.min(1, dot / len));
    const a = Math.acos(clamped);
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, vx, vy);
  const twoPi = Math.PI * 2;
  if (!arc.sweep && delta > 0) delta -= twoPi;
  else if (arc.sweep && delta < 0) delta += twoPi;

  // Quarter-turn segments: the Bézier error of a 90° arc is ~2.7e-4 · r, which
  // is invisible at any print resolution; a half-turn would not be.
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / count;
  const out: Cubic[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(arcSegment(cx, cy, rx, ry, cosPhi, sinPhi, theta + i * step, step));
  }
  return out;
}

/** A 2×3 affine matrix, PDF order `[a b c d e f]`. */
export type Matrix = readonly [number, number, number, number, number, number];

/** The identity matrix. */
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 × m2`, applying `m1` first. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}
