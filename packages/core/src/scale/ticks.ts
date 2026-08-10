/**
 * Tick generation for continuous domains (SPEC 7.2, 7.3).
 *
 * The generator prefers **round values** over an exact count: `ticks` is a hint,
 * never a promise (SPEC 7.3). Steps are drawn from the 1 / 2 / 5 × 10ⁿ ladder,
 * which is the only ladder whose labels a reader can subdivide mentally.
 *
 * Everything here is integer-indexed arithmetic — `(i1 + i) * step` rather than
 * `start += step` — so a tick lands on the same double on every machine and no
 * accumulated error creeps into the last label (SPEC 24.3).
 */

/** Thresholds selecting between a 1, 2, 5 or 10 multiplier. */
const E10 = Math.sqrt(50);
const E5 = Math.sqrt(10);
const E2 = Math.sqrt(2);

/**
 * The step between ticks over `[start, stop]` at roughly `count` intervals.
 *
 * A **negative** return is an inverse step: the caller divides by `-value`
 * instead of multiplying, which keeps sub-unit steps exact (0.1 is not
 * representable, but 1/10 applied to an integer index is).
 */
export function tickIncrement(start: number, stop: number, count: number): number {
  const step = (stop - start) / Math.max(1, count);
  if (!Number.isFinite(step) || step <= 0) return Number.NaN;
  const power = Math.floor(Math.log(step) / Math.LN10);
  const error = step / 10 ** power;
  const factor = error >= E10 ? 10 : error >= E5 ? 5 : error >= E2 ? 2 : 1;
  return power >= 0 ? factor * 10 ** power : -(10 ** -power) / factor;
}

/** The positive step size between ticks, for callers that only need a magnitude. */
export function tickStep(start: number, stop: number, count: number): number {
  const inc = tickIncrement(start, stop, count);
  if (Number.isNaN(inc)) return Number.NaN;
  return inc > 0 ? inc : 1 / -inc;
}

/**
 * Round tick values inside `[start, stop]`.
 *
 * @param count - a hint. The result may be shorter or longer by one.
 * @returns ascending values when `start <= stop`, descending otherwise
 */
export function ticks(start: number, stop: number, count: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return [];
  if (start === stop) return [start];
  const reverse = stop < start;
  const [lo, hi] = reverse ? [stop, start] : [start, stop];
  const inc = tickIncrement(lo, hi, count);
  if (Number.isNaN(inc)) return [];

  const out: number[] = [];
  if (inc > 0) {
    let i1 = Math.round(lo / inc);
    let i2 = Math.round(hi / inc);
    if (i1 * inc < lo) ++i1;
    if (i2 * inc > hi) --i2;
    for (let i = i1; i <= i2; ++i) out.push(i * inc);
  } else {
    const div = -inc;
    let i1 = Math.round(lo * div);
    let i2 = Math.round(hi * div);
    if (i1 / div < lo) ++i1;
    if (i2 / div > hi) --i2;
    for (let i = i1; i <= i2; ++i) out.push(i / div);
  }
  if (reverse) out.reverse();
  return out;
}

/**
 * Extend `[start, stop]` outward to the nearest round step (SPEC 7.2, `nice`).
 *
 * Iterates because widening the domain can select a coarser step, which in turn
 * can widen it again; it converges in at most a few passes.
 */
export function niceDomain(start: number, stop: number, count: number): [number, number] {
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return [start, stop];
  let lo = Math.min(start, stop);
  let hi = Math.max(start, stop);
  if (lo === hi) return start <= stop ? [lo, hi] : [hi, lo];

  let previous = Number.NaN;
  for (let guard = 0; guard < 8; ++guard) {
    const step = tickIncrement(lo, hi, count);
    if (Number.isNaN(step) || step === previous) break;
    if (step > 0) {
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
    } else {
      // A negative increment is an inverse step: the real step is `1 / div`, so
      // flooring means `floor(lo · div) / div`. Applying `ceil` here — the shape
      // the sign-carrying formulation uses — would shrink the domain instead of
      // widening it, and the axis would clip its own extremes.
      const div = -step;
      lo = Math.floor(lo * div) / div;
      hi = Math.ceil(hi * div) / div;
    }
    previous = step;
  }
  return start <= stop ? [lo, hi] : [hi, lo];
}

/**
 * The number of decimal places a label needs to distinguish neighbouring ticks.
 *
 * Used to pick a default axis format: a 0.25 step wants two decimals, a 5000
 * step wants none.
 */
export function tickPrecision(step: number): number {
  if (!Number.isFinite(step) || step === 0) return 0;
  const magnitude = Math.abs(step);
  const exponent = Math.floor(Math.log(magnitude) / Math.LN10);
  return Math.max(0, -exponent);
}

/**
 * Guard against a degenerate `[v, v]` domain: a zero-width extent maps every
 * datum to the same pixel and produces a single tick with no context.
 *
 * Expands symmetrically by 1 for a zero value, else by 5 % of the magnitude, and
 * rounds the result outward.
 */
export function padDegenerate(value: number): [number, number] {
  if (!Number.isFinite(value)) return [0, 1];
  if (value === 0) return [0, 1];
  const pad = Math.abs(value) * 0.05;
  return [value - pad, value + pad];
}
