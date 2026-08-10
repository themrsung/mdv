/**
 * Discrete positional scales (SPEC 7.2): `band` and `point`.
 *
 * A band scale divides the range into `n` steps and gives each category a slice;
 * a point scale is the degenerate band whose slices have no width, which is the
 * right model for a line or a scatter over categories — a point sits *on* the
 * category, not inside a box.
 *
 * The geometry is the standard band construction:
 *
 * ```text
 * step      = span / (n − paddingInner + 2·paddingOuter)
 * bandwidth = step · (1 − paddingInner)
 * start     = r0 + 2·paddingOuter·step · align
 * ```
 *
 * so `padding: 0` gives touching bars and `padding: 0.2` (the default) leaves a
 * fifth of each step as air.
 *
 * The arithmetic lives in {@link bandGeometry} rather than in this factory
 * because `@mdv/charts` builds its own band scale objects — mutable ones, over a
 * `ScaleInput` domain — and two implementations of *this* formula are how an
 * axis ladder and the bars under it end up disagreeing. The object protocols may
 * differ; the geometry may not.
 */

import type { Scale } from '../types/encode.js';
import { attachRerange } from './rerange.js';

/** Construction options for {@link createBandScale}. */
export interface BandScaleOptions {
  /** Category values in first-appearance order. Duplicates are dropped. */
  domain: readonly string[];
  range: readonly [number, number];
  /** Space between bands as a fraction of the step. @defaultValue 0.2 */
  paddingInner?: number;
  /**
   * Space before the first and after the last band.
   *
   * @defaultValue paddingInner — **not** d3's `paddingInner / 2`. SPEC 8.1
   * gives the author one `padding` knob, `@mdv/charts` spends it on both gaps,
   * and that is the geometry every rendered bar in this repository already has.
   * A scale built here for an axis has to land on the same pixels as the bars it
   * labels, so the default follows the renderer rather than d3.
   */
  paddingOuter?: number;
  /** Where leftover space goes: 0 start, 0.5 centred, 1 end. @defaultValue 0.5 */
  align?: number;
  /** `point` produces zero-width bands positioned at the step centres. */
  point?: boolean;
  /** Snap band edges to whole pixels. Off by default: rounding is done once, at emit. */
  round?: boolean;
  /** Flip the range; re-applied by {@link Rerangeable.withRange}. */
  reverse?: boolean;
}

/** What {@link bandGeometry} needs to know. All paddings are already clamped. */
export interface BandGeometryRequest {
  /** Number of categories. Zero yields a degenerate, `NaN`-free geometry. */
  count: number;
  /**
   * `[r0, r1]` as the caller holds it. A descending pair is normalised here and
   * reported back as {@link BandGeometry.reverse}, so the bands of a top-to-bottom
   * axis have positive width and the caller flips only the *order* it walks them
   * in. Computing on a negative span instead is the classic way to end up with a
   * negative bandwidth and marks that silently vanish.
   */
  range: readonly [number, number];
  /** Gap between adjacent bands as a fraction of the step, in `[0, 1]`. */
  paddingInner: number;
  /** Gap before the first and after the last band, as a fraction of the step. */
  paddingOuter: number;
  /** Where the outer space goes: 0 start, 0.5 centred, 1 end. @defaultValue 0.5 */
  align?: number;
  /** Snap step and bandwidth to whole pixels. @defaultValue false */
  round?: boolean;
}

/** The three numbers a band or point scale is made of. */
export interface BandGeometry {
  /** Leading edge of the first band. */
  start: number;
  /** Distance between adjacent leading edges. Never negative. */
  step: number;
  /** Width of one band; `0` for a point scale, where `paddingInner` is 1. */
  bandwidth: number;
  /**
   * The range ran high to low, so category `i` belongs in slot `count − 1 − i`.
   * Applying this is the caller's job: the geometry knows the slots, only the
   * caller knows the domain.
   */
  reverse: boolean;
}

/**
 * The band construction, and the only copy of it in the repository.
 *
 * A point scale is the same formula with `paddingInner: 1`, which is why there
 * is no separate entry point: `bandwidth` falls out as zero and `step` becomes
 * `span / (n − 1 + 2·paddingOuter)`, the point spacing.
 *
 * `start` is written as `2·paddingOuter·step·align` rather than d3's
 * equivalent `(span − step·(n − paddingInner))·align`. The two agree to the
 * last bit only when the division is exact, and they disagree in the last unit
 * in the last place for most inputs — 1.4 × 10⁻¹² at worst, which is invisible
 * on screen but is exactly the sort of difference that makes two renders of one
 * document differ by a byte. The product form is chosen because it is the one
 * `@mdv/charts` already ships, so adopting it changes no pixel that is
 * currently drawn. Doubling and halving are exact in binary floating point, so
 * the default `align: 0.5` reduces to `step · paddingOuter` with no rounding at
 * all.
 *
 * When `round` is set the step shrinks to a whole pixel and no longer fills the
 * span; the leftover is real, and `align` distributes it.
 */
export function bandGeometry(request: BandGeometryRequest): BandGeometry {
  const { count, paddingInner, paddingOuter } = request;
  const [r0, r1] = request.range;
  const align = request.align ?? 0.5;
  const round = request.round === true;

  const reverse = r1 < r0;
  const lo = reverse ? r1 : r0;
  const hi = reverse ? r0 : r1;

  const span = hi - lo;
  if (count <= 0 || !Number.isFinite(span) || !Number.isFinite(lo)) {
    return { start: Number.isFinite(r0) ? r0 : 0, step: 0, bandwidth: 0, reverse: false };
  }

  const divisor = count - paddingInner + paddingOuter * 2;
  let step = divisor > 0 ? span / divisor : span;
  if (round) step = Math.floor(step);

  let bandwidth = step * (1 - paddingInner);
  if (round) bandwidth = Math.round(bandwidth);

  const outerSpace = round ? span - step * (count - paddingInner) : step * paddingOuter * 2;
  let start = lo + outerSpace * align;
  if (round) start = Math.round(start);

  return { start, step, bandwidth, reverse };
}

/**
 * Build a band or point scale.
 *
 * `scale(value)` returns the **leading edge** of the band, matching d3 and
 * matching what a bar's `x` must be; a point scale returns the centre, because a
 * zero-width band has no leading edge worth the name.
 */
export function createBandScale(options: BandScaleOptions): Scale<string, number> {
  const seen = new Set<string>();
  const domain: string[] = [];
  for (const value of options.domain) {
    if (seen.has(value)) continue;
    seen.add(value);
    domain.push(value);
  }

  const isPoint = options.point === true;
  const paddingInner = isPoint ? 1 : clamp01(options.paddingInner ?? 0.2);
  const paddingOuter = clamp01(options.paddingOuter ?? (isPoint ? 0.5 : paddingInner));
  const align = clamp01(options.align ?? 0.5);

  const [r0, r1] =
    options.reverse === true
      ? [options.range[1], options.range[0]]
      : [options.range[0], options.range[1]];
  const n = domain.length;

  const { start, step, bandwidth, reverse } = bandGeometry({
    count: n,
    range: [r0, r1],
    paddingInner,
    paddingOuter,
    align,
    round: options.round === true,
  });

  const positions = new Map<string, number>();
  for (let i = 0; i < n; ++i) {
    const key = domain[i] as string;
    const offset = start + step * (reverse ? n - 1 - i : i);
    positions.set(key, isPoint ? offset + bandwidth / 2 : offset);
  }

  const scale: Scale<string, number> = {
    type: isPoint ? 'point' : 'band',
    domain: Object.freeze([...domain]),
    range: Object.freeze([r0, r1]),
    scale(value: string): number | undefined {
      return positions.get(String(value));
    },
    ticks(count?: number): readonly string[] {
      if (count === undefined || count <= 0 || count >= n) return domain;
      // Thin by an integer stride so the kept labels stay evenly spaced; never
      // drop the first, which anchors the reader.
      const stride = Math.ceil(n / count);
      const out: string[] = [];
      for (let i = 0; i < n; i += stride) out.push(domain[i] as string);
      return out;
    },
    format: (value: string) => String(value),
    bandwidth: () => (isPoint ? 0 : bandwidth),
    step: () => step,
  };
  return attachRerange(
    scale,
    (next) => createBandScale({ ...options, range: [next[0], next[1]] }) as unknown as Scale,
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * The **centre** of a band, which is where a tick, a point and a label belong.
 *
 * Callers must not compute this themselves: an off-by-half-a-bandwidth is the
 * classic way for a gridline and a bar to disagree.
 */
export function bandCenter(scale: Scale, value: string): number | undefined {
  const start = scale.scale(value);
  if (start === undefined) return undefined;
  const width = scale.bandwidth?.() ?? 0;
  return start + width / 2;
}
