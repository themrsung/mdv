/**
 * Re-ranging a scale onto the frame core computed.
 *
 * The pipeline has a genuine ordering problem: `encode` constructs the scales
 * (SPEC 18 stage 5) but **never sees a pixel**, while the plot frame is not known
 * until core has measured the axis labels those very scales produce. The
 * resolution is that a scale's *domain* is decided in encode and its *range* is
 * decided in layout — the domain is the part that carries meaning, and it is the
 * part the marks were computed against.
 *
 * Every scale this package builds therefore carries a `withRange` method:
 * "the same scale, on this range". Core calls it once the frame is known and
 * hands the re-ranged bundle to the chart type's `layout`, so the marks, the
 * gridlines and the tick ladder are all driven by one instance and a bar edge
 * cannot land on a different pixel from its gridline.
 *
 * A scale from somewhere else — a plugin that built its own — is reconstructed
 * from its public interface instead. That path is lossy for exotic
 * configurations, so plugins are better off using these factories.
 */

import type { Scale, ScaleInput } from '../types/encode.js';

/** A scale that can produce a copy of itself on a different range. */
export interface Rerangeable {
  /** The same domain and configuration, on `range`. */
  withRange(range: readonly [number, number]): Scale;
}

/** Attach a `withRange` implementation and freeze. */
export function attachRerange<D extends ScaleInput, R>(
  scale: Scale<D, R>,
  rebuild: (range: readonly [number, number]) => Scale,
): Scale<D, R> {
  return Object.freeze({ ...scale, withRange: rebuild });
}

/** `true` when a scale can re-range itself losslessly. */
export function isRerangeable(scale: Scale): scale is Scale & Rerangeable {
  return typeof (scale as Partial<Rerangeable>).withRange === 'function';
}

/**
 * Return `scale` mapped onto `range`.
 *
 * Uses `withRange` when the scale has one. Otherwise reconstructs from the
 * public {@link Scale} surface: band geometry is recovered from
 * `bandwidth()`/`step()`, and continuous geometry from the domain. A scale whose
 * range already matches is returned unchanged, so a second layout pass at the
 * same size allocates nothing.
 */
export function rerangeScale(scale: Scale, range: readonly [number, number]): Scale {
  const current = scale.range;
  if (current.length === 2 && current[0] === range[0] && current[1] === range[1]) return scale;
  if (isRerangeable(scale)) return scale.withRange(range);
  return reconstruct(scale, range);
}

/** Best-effort reconstruction of a foreign scale. */
function reconstruct(scale: Scale, range: readonly [number, number]): Scale {
  const [r0, r1] = range;
  const domain = scale.domain;

  if (scale.type === 'band' || scale.type === 'point') {
    const step = scale.step?.() ?? 0;
    const bandwidth = scale.bandwidth?.() ?? 0;
    const paddingInner = step > 0 ? Math.max(0, Math.min(1, 1 - bandwidth / step)) : 0.2;
    const n = Math.max(1, domain.length);
    const isPoint = scale.type === 'point';
    const inner = isPoint ? 1 : paddingInner;
    const outer = inner / 2;
    const span = r1 - r0;
    const newStep = span / Math.max(1, n - inner + outer * 2);
    const newBand = newStep * (1 - inner);
    const start = r0 + (span - newStep * (n - inner)) * 0.5;
    const positions = new Map<string, number>();
    for (let i = 0; i < n; ++i) {
      positions.set(String(domain[i]), start + newStep * i + (isPoint ? newBand / 2 : 0));
    }
    return Object.freeze({
      type: scale.type,
      domain,
      range: Object.freeze([r0, r1]),
      scale: (value: ScaleInput) => positions.get(String(value)),
      ticks: (count?: number) => scale.ticks(count),
      format: (value: ScaleInput) => scale.format(value),
      bandwidth: () => (isPoint ? 0 : newBand),
      step: () => newStep,
    }) as Scale;
  }

  // Continuous and temporal: re-map linearly through the original range, which
  // preserves whatever non-linear transform the foreign scale applied.
  const [c0, c1] = [current(scale)[0], current(scale)[1]];
  const oldSpan = c1 - c0;
  const newSpan = r1 - r0;
  return Object.freeze({
    type: scale.type,
    domain,
    range: Object.freeze([r0, r1]),
    scale(value: ScaleInput): number | undefined {
      const mapped = scale.scale(value);
      if (mapped === undefined) return undefined;
      if (oldSpan === 0) return r0;
      return r0 + ((mapped - c0) / oldSpan) * newSpan;
    },
    invert(position: number): ScaleInput | undefined {
      if (scale.invert === undefined || newSpan === 0) return undefined;
      return scale.invert(c0 + ((position - r0) / newSpan) * oldSpan);
    },
    ticks: (count?: number) => scale.ticks(count),
    format: (value: ScaleInput) => scale.format(value),
  }) as Scale;
}

/** The numeric endpoints of a scale's current range, defaulting to `[0, 1]`. */
function current(scale: Scale): [number, number] {
  const range = scale.range;
  const first = range[0];
  const last = range[range.length - 1];
  return [typeof first === 'number' ? first : 0, typeof last === 'number' ? last : 1];
}
