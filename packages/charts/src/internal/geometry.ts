/**
 * Path construction (SPEC 20: structured commands, never a `d` string).
 *
 * Every function here is total over degenerate input — zero-width frames,
 * single points, coincident points — and every emitted coordinate passes through
 * {@link round}, so the SVG and PDF backends receive byte-identical numbers
 * (SPEC 24.3 rule 4).
 */

import type { PathCommand } from '@mdv/core';
import type { CurveKind, PointShape } from './types.js';
import { clamp, finite, round, safeDiv } from './num.js';

/** Geometry precision. Four decimals is well under a device pixel at any zoom. */
const PRECISION = 4;

const p = (value: number): number => round(value, PRECISION);

/** A finite 2-D point in scene coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** `M` command. */
export function moveTo(x: number, y: number): PathCommand {
  return { c: 'M', x: p(x), y: p(y) };
}

/** `L` command. */
export function lineTo(x: number, y: number): PathCommand {
  return { c: 'L', x: p(x), y: p(y) };
}

/** `C` command. */
export function cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): PathCommand {
  return { c: 'C', x1: p(x1), y1: p(y1), x2: p(x2), y2: p(y2), x: p(x), y: p(y) };
}

/** `A` command with SVG semantics. */
export function arcTo(rx: number, ry: number, largeArc: boolean, sweep: boolean, x: number, y: number): PathCommand {
  return { c: 'A', rx: p(rx), ry: p(ry), rotate: 0, largeArc, sweep, x: p(x), y: p(y) };
}

/** `Z` command. */
export function closePath(): PathCommand {
  return { c: 'Z' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rectangles
// ─────────────────────────────────────────────────────────────────────────────

/** Per-corner radii, in the `RectNode.r` order: TL, TR, BR, BL. */
export type CornerRadii = [number, number, number, number];

/**
 * Clamp corner radii so they can never exceed the rectangle they round.
 *
 * A 4 px radius on a 3 px tall bar would otherwise produce a self-intersecting
 * outline, which renders as a blob in SVG and as an error in some PDF viewers.
 */
export function clampRadii(radii: CornerRadii, width: number, height: number): CornerRadii {
  const w = Math.max(0, finite(width, 0));
  const h = Math.max(0, finite(height, 0));
  const limit = Math.min(w, h) / 2;
  const fit = (r: number): number => clamp(finite(r, 0), 0, limit);
  return [fit(radii[0]), fit(radii[1]), fit(radii[2]), fit(radii[3])];
}

/**
 * The rounding a bar carries: **the data end only, square at the baseline**
 * (SPEC 11.4).
 *
 * @param vertical - `true` for a column, `false` for a horizontal bar
 * @param positive - `true` when the bar grows in the increasing-value direction
 */
export function barRadii(radius: number, vertical: boolean, positive: boolean): CornerRadii {
  const r = Math.max(0, finite(radius, 0));
  if (vertical) {
    // Scene y grows downward, so a positive bar's data end is its *top*.
    return positive ? [r, r, 0, 0] : [0, 0, r, r];
  }
  return positive ? [0, r, r, 0] : [r, 0, 0, r];
}

// ─────────────────────────────────────────────────────────────────────────────
// Arcs (SPEC 8.5)
// ─────────────────────────────────────────────────────────────────────────────

/** Point on a circle. Angles are radians, 0 at 12 o'clock, growing clockwise. */
export function polar(cx: number, cy: number, radius: number, angle: number): Point {
  const r = finite(radius, 0);
  const a = finite(angle, 0);
  return { x: finite(cx, 0) + r * Math.sin(a), y: finite(cy, 0) - r * Math.cos(a) };
}

/**
 * An annular sector: the pie slice and the donut ring segment.
 *
 * A full turn cannot be expressed as one SVG arc — start and end coincide and the
 * renderer draws nothing — so a sweep of ≥ 2π is emitted as two half-turns. A
 * single-slice pie is a common, correct document, not an edge case to reject.
 */
export function arcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): PathCommand[] {
  const ro = Math.max(0, finite(outerRadius, 0));
  const ri = clamp(finite(innerRadius, 0), 0, ro);
  const a0 = finite(startAngle, 0);
  let a1 = finite(endAngle, a0);
  if (a1 < a0) a1 = a0;
  const sweep = a1 - a0;
  if (ro <= 0 || sweep <= 0) return [];

  const full = sweep >= Math.PI * 2 - 1e-9;
  const commands: PathCommand[] = [];

  if (full) {
    const mid = a0 + Math.PI;
    const outerStart = polar(cx, cy, ro, a0);
    const outerMid = polar(cx, cy, ro, mid);
    commands.push(moveTo(outerStart.x, outerStart.y));
    commands.push(arcTo(ro, ro, false, true, outerMid.x, outerMid.y));
    commands.push(arcTo(ro, ro, false, true, outerStart.x, outerStart.y));
    if (ri > 0) {
      const innerStart = polar(cx, cy, ri, a0);
      const innerMid = polar(cx, cy, ri, mid);
      commands.push(moveTo(innerStart.x, innerStart.y));
      // Opposite sweep so the even-odd/nonzero fill punches the hole out.
      commands.push(arcTo(ri, ri, false, false, innerMid.x, innerMid.y));
      commands.push(arcTo(ri, ri, false, false, innerStart.x, innerStart.y));
    }
    commands.push(closePath());
    return commands;
  }

  const largeArc = sweep > Math.PI;
  const outerStart = polar(cx, cy, ro, a0);
  const outerEnd = polar(cx, cy, ro, a1);
  commands.push(moveTo(outerStart.x, outerStart.y));
  commands.push(arcTo(ro, ro, largeArc, true, outerEnd.x, outerEnd.y));
  if (ri > 0) {
    const innerEnd = polar(cx, cy, ri, a1);
    const innerStart = polar(cx, cy, ri, a0);
    commands.push(lineTo(innerEnd.x, innerEnd.y));
    commands.push(arcTo(ri, ri, largeArc, false, innerStart.x, innerStart.y));
  } else {
    commands.push(lineTo(finite(cx, 0), finite(cy, 0)));
  }
  commands.push(closePath());
  return commands;
}

// ─────────────────────────────────────────────────────────────────────────────
// Curves (SPEC 8.3 `curve`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the path of one contiguous run of points.
 *
 * Runs are already split on nulls by the caller: a gap means the line **breaks**
 * and does not interpolate (SPEC 6.5), so an interpolator never sees a hole and
 * can assume its input is dense.
 */
export function curvePath(points: readonly Point[], curve: CurveKind): PathCommand[] {
  const pts = points.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (pts.length === 0) return [];
  const first = pts[0];
  if (first === undefined) return [];
  if (pts.length === 1) {
    // A one-point run still needs a mark: a zero-length line with a round cap
    // paints a dot, which is the honest rendering of a single observation.
    return [moveTo(first.x, first.y), lineTo(first.x, first.y)];
  }
  switch (curve) {
    case 'monotone':
      return monotonePath(pts);
    case 'natural':
      return naturalPath(pts);
    case 'basis':
      return basisPath(pts);
    case 'step':
      return stepPath(pts, 'mid');
    case 'stepBefore':
      return stepPath(pts, 'before');
    case 'stepAfter':
      return stepPath(pts, 'after');
    default:
      return linearPath(pts);
  }
}

function linearPath(pts: readonly Point[]): PathCommand[] {
  const first = pts[0];
  if (first === undefined) return [];
  const out: PathCommand[] = [moveTo(first.x, first.y)];
  for (let i = 1; i < pts.length; i += 1) {
    const pt = pts[i];
    if (pt !== undefined) out.push(lineTo(pt.x, pt.y));
  }
  return out;
}

function stepPath(pts: readonly Point[], where: 'mid' | 'before' | 'after'): PathCommand[] {
  const first = pts[0];
  if (first === undefined) return [];
  const out: PathCommand[] = [moveTo(first.x, first.y)];
  for (let i = 1; i < pts.length; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    if (prev === undefined || cur === undefined) continue;
    if (where === 'before') {
      out.push(lineTo(prev.x, cur.y));
      out.push(lineTo(cur.x, cur.y));
    } else if (where === 'after') {
      out.push(lineTo(cur.x, prev.y));
      out.push(lineTo(cur.x, cur.y));
    } else {
      const midX = (prev.x + cur.x) / 2;
      out.push(lineTo(midX, prev.y));
      out.push(lineTo(midX, cur.y));
      out.push(lineTo(cur.x, cur.y));
    }
  }
  return out;
}

/**
 * Fritsch–Carlson monotone cubic interpolation.
 *
 * Monotone is the only smooth curve MDV offers by default because it **cannot
 * overshoot**: a spline that dips below zero between two positive observations
 * invents data that was never measured (SPEC 8.3 warns against `monotone` on
 * step-change data for the same reason).
 */
function monotonePath(pts: readonly Point[]): PathCommand[] {
  const n = pts.length;
  const slopes: number[] = new Array<number>(n).fill(0);
  const secants: number[] = new Array<number>(Math.max(0, n - 1)).fill(0);

  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a === undefined || b === undefined) continue;
    secants[i] = safeDiv(b.y - a.y, b.x - a.x, 0);
  }
  slopes[0] = secants[0] ?? 0;
  slopes[n - 1] = secants[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = secants[i - 1] ?? 0;
    const s1 = secants[i] ?? 0;
    slopes[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    const s = secants[i] ?? 0;
    if (s === 0) {
      slopes[i] = 0;
      slopes[i + 1] = 0;
      continue;
    }
    const a = safeDiv(slopes[i] ?? 0, s, 0);
    const b = safeDiv(slopes[i + 1] ?? 0, s, 0);
    const magnitude = Math.hypot(a, b);
    if (magnitude > 3) {
      const t = 3 / magnitude;
      slopes[i] = t * a * s;
      slopes[i + 1] = t * b * s;
    }
  }

  const first = pts[0];
  if (first === undefined) return [];
  const out: PathCommand[] = [moveTo(first.x, first.y)];
  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a === undefined || b === undefined) continue;
    const dx = (b.x - a.x) / 3;
    out.push(
      cubicTo(a.x + dx, a.y + (slopes[i] ?? 0) * dx, b.x - dx, b.y - (slopes[i + 1] ?? 0) * dx, b.x, b.y),
    );
  }
  return out;
}

/** Natural cubic spline: second derivative zero at both ends. */
function naturalPath(pts: readonly Point[]): PathCommand[] {
  const n = pts.length;
  if (n < 3) return linearPath(pts);
  const xs = pts.map((pt) => pt.x);
  const ys = pts.map((pt) => pt.y);
  const a: number[] = new Array<number>(n).fill(0);
  const b: number[] = new Array<number>(n).fill(0);
  const r: number[] = new Array<number>(n).fill(0);

  a[0] = 0;
  b[0] = 2;
  r[0] = (ys[0] ?? 0) + 2 * (ys[1] ?? 0);
  for (let i = 1; i < n - 1; i += 1) {
    a[i] = 1;
    b[i] = 4;
    r[i] = 4 * (ys[i] ?? 0) + 2 * (ys[i + 1] ?? 0);
  }
  a[n - 1] = 2;
  b[n - 1] = 7;
  r[n - 1] = 8 * (ys[n - 2] ?? 0) + (ys[n - 1] ?? 0);

  // Thomas algorithm; the matrix is diagonally dominant so no pivoting is needed.
  for (let i = 1; i < n; i += 1) {
    const m = safeDiv(a[i] ?? 0, b[i - 1] ?? 1, 0);
    b[i] = (b[i] ?? 0) - m;
    r[i] = (r[i] ?? 0) - m * (r[i - 1] ?? 0);
  }
  const c1: number[] = new Array<number>(n).fill(0);
  c1[n - 1] = safeDiv(r[n - 1] ?? 0, b[n - 1] ?? 1, 0);
  for (let i = n - 2; i >= 0; i -= 1) {
    c1[i] = safeDiv((r[i] ?? 0) - (c1[i + 1] ?? 0), b[i] ?? 1, 0);
  }
  const c2: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i += 1) c2[i] = 2 * (ys[i + 1] ?? 0) - (c1[i + 1] ?? 0);
  c2[n - 1] = ((c1[n - 1] ?? 0) + (ys[n - 1] ?? 0)) / 2;

  const out: PathCommand[] = [moveTo(xs[0] ?? 0, ys[0] ?? 0)];
  for (let i = 0; i < n - 1; i += 1) {
    const x0 = xs[i] ?? 0;
    const x1 = xs[i + 1] ?? 0;
    const dx = (x1 - x0) / 3;
    out.push(cubicTo(x0 + dx, c1[i] ?? 0, x1 - dx, c2[i] ?? 0, x1, ys[i + 1] ?? 0));
  }
  return out;
}

/** Uniform cubic B-spline. Approximating, not interpolating — it smooths noise. */
function basisPath(pts: readonly Point[]): PathCommand[] {
  const n = pts.length;
  if (n < 3) return linearPath(pts);
  const at = (i: number): Point => pts[clamp(i, 0, n - 1)] ?? { x: 0, y: 0 };
  const first = at(0);
  const out: PathCommand[] = [moveTo(first.x, first.y)];
  const second = at(1);
  out.push(lineTo((5 * first.x + second.x) / 6, (5 * first.y + second.y) / 6));
  for (let i = 1; i < n - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    out.push(
      cubicTo(
        (2 * p1.x + p2.x) / 3,
        (2 * p1.y + p2.y) / 3,
        (p1.x + 2 * p2.x) / 3,
        (p1.y + 2 * p2.y) / 3,
        (p0.x + 4 * p1.x + p2.x) / 6,
        (p0.y + 4 * p1.y + p2.y) / 6,
      ),
    );
  }
  const last = at(n - 1);
  const penultimate = at(n - 2);
  out.push(lineTo((penultimate.x + 5 * last.x) / 6, (penultimate.y + 5 * last.y) / 6));
  out.push(lineTo(last.x, last.y));
  return out;
}

/**
 * Close a line path down to a baseline, producing an area (SPEC 8.4).
 *
 * The lower boundary is traced in reverse with the same interpolator, so a
 * stacked band's shared edge is drawn identically by the series above and the
 * series below it — otherwise a hairline of surface shows through the seam.
 */
export function areaPath(upper: readonly Point[], lower: readonly Point[], curve: CurveKind): PathCommand[] {
  const top = curvePath(upper, curve);
  if (top.length === 0) return [];
  const bottom = curvePath([...lower].reverse(), curve);
  if (bottom.length === 0) return [...top, closePath()];
  const [, ...bottomRest] = bottom;
  const firstBottom = bottom[0];
  const join: PathCommand[] =
    firstBottom !== undefined && firstBottom.c === 'M' ? [lineTo(firstBottom.x, firstBottom.y)] : [];
  return [...top, ...join, ...bottomRest, closePath()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Point shapes (SPEC 8.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outline of a scatter shape, centred on `(cx, cy)`.
 *
 * Every shape is sized to the **same area** as a circle of radius `r`, so
 * swapping the shape channel on does not change how large a point reads.
 */
export function shapePath(shape: PointShape, cx: number, cy: number, r: number): PathCommand[] {
  const x = finite(cx, 0);
  const y = finite(cy, 0);
  const radius = Math.max(0, finite(r, 0));
  if (radius === 0) return [];
  const area = Math.PI * radius * radius;

  switch (shape) {
    case 'square': {
      const half = Math.sqrt(area) / 2;
      return [
        moveTo(x - half, y - half),
        lineTo(x + half, y - half),
        lineTo(x + half, y + half),
        lineTo(x - half, y + half),
        closePath(),
      ];
    }
    case 'triangle': {
      // Equilateral triangle of the same area, apex up.
      const side = Math.sqrt((4 * area) / Math.sqrt(3));
      const height = (side * Math.sqrt(3)) / 2;
      return [
        moveTo(x, y - (2 / 3) * height),
        lineTo(x + side / 2, y + height / 3),
        lineTo(x - side / 2, y + height / 3),
        closePath(),
      ];
    }
    case 'diamond': {
      const half = Math.sqrt(area / 2);
      return [moveTo(x, y - half), lineTo(x + half, y), lineTo(x, y + half), lineTo(x - half, y), closePath()];
    }
    case 'cross': {
      // A plus sign of five equal squares.
      const arm = Math.sqrt(area / 5) / 2;
      const long = arm * 3;
      return [
        moveTo(x - arm, y - long),
        lineTo(x + arm, y - long),
        lineTo(x + arm, y - arm),
        lineTo(x + long, y - arm),
        lineTo(x + long, y + arm),
        lineTo(x + arm, y + arm),
        lineTo(x + arm, y + long),
        lineTo(x - arm, y + long),
        lineTo(x - arm, y + arm),
        lineTo(x - long, y + arm),
        lineTo(x - long, y - arm),
        lineTo(x - arm, y - arm),
        closePath(),
      ];
    }
    case 'star': {
      const outer = radius * 1.4;
      const inner = outer * 0.382;
      const commands: PathCommand[] = [];
      for (let i = 0; i < 10; i += 1) {
        const angle = (i * Math.PI) / 5;
        const pt = polar(x, y, i % 2 === 0 ? outer : inner, angle);
        commands.push(i === 0 ? moveTo(pt.x, pt.y) : lineTo(pt.x, pt.y));
      }
      commands.push(closePath());
      return commands;
    }
    default:
      return [];
  }
}

/** Round a point pair once, at the boundary into the scene graph. */
export function scenePoint(x: number, y: number): Point {
  return { x: p(x), y: p(y) };
}

/** Expose the shared rounding so chart modules never invent their own precision. */
export function px(value: number): number {
  return p(value);
}
