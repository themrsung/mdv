/**
 * Domain computation (SPEC 7.2, "Domain rules").
 *
 * > By default a quantitative y-domain **includes zero** for area/bar
 * > (`zero: true`) and **does not** for line/scatter (`zero: false`), and is
 * > extended to "nice" round bounds.
 *
 * Everything here is defined for the degenerate inputs a real document produces:
 * no rows, one row, and a column that is entirely null. Each of those returns a
 * usable domain rather than `[Infinity, -Infinity]`, which is what would
 * otherwise propagate into every coordinate as `NaN`.
 */

import type { Channel, ScaleSpec, ScaleType } from '@mdv/core';
import { isFiniteNumber } from './num.js';
import { niceBounds } from './scale.js';

/** A closed numeric interval. */
export type Extent = readonly [number, number];

/** The domain used when there is nothing at all to plot. */
export const EMPTY_DOMAIN: Extent = [0, 1];

/** Min/max over finite values, or `undefined` when none were finite. */
export function extentOf(values: Iterable<number>): Extent | undefined {
  let lo: number | undefined;
  let hi: number | undefined;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (lo === undefined || value < lo) lo = value;
    if (hi === undefined || value > hi) hi = value;
  }
  if (lo === undefined || hi === undefined) return undefined;
  return [lo, hi];
}

/** Union of two extents, either of which may be absent. */
export function unionExtent(a: Extent | undefined, b: Extent | undefined): Extent | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/**
 * Give a zero-width extent room to breathe.
 *
 * A single row, or a column whose values are all equal, produces `[v, v]`. The
 * scale would still be safe — it centres a degenerate domain — but the axis would
 * carry one tick and the mark would sit on the frame edge. Padding by half the
 * magnitude (or ±1 at zero) produces a readable axis with no special cases
 * downstream.
 */
export function undegenerate(extent: Extent): Extent {
  const [lo, hi] = extent;
  if (!isFiniteNumber(lo) || !isFiniteNumber(hi)) return EMPTY_DOMAIN;
  if (lo !== hi) return extent;
  if (lo === 0) return [0, 1];
  const pad = Math.abs(lo) * 0.5;
  return [lo - pad, hi + pad];
}

/** Options for {@link resolveDomain}. */
export interface DomainOptions {
  /** The data extent, or `undefined` when nothing was plottable. */
  data: Extent | undefined;
  /** Whether this channel includes zero by default (bar/area: `true`). */
  zeroByDefault: boolean;
  /** `nice: true` by default (SPEC 7.2). */
  niceByDefault?: boolean;
  /** The author's `scale:` request, which overrides both. */
  spec?: ScaleSpec | undefined;
  /** Extra baseline that must be inside the domain, e.g. a bar's `baseline`. */
  include?: number | undefined;
}

/** What {@link resolveDomain} decided, including whether zero was suppressed. */
export interface ResolvedDomain {
  domain: Extent;
  /** `true` when the author set `zero: false` on a type that needs zero (`MDV3021`). */
  zeroSuppressed: boolean;
}

/**
 * Apply the SPEC 7.2 domain rules to a data extent.
 *
 * Precedence: an explicit `domain` wins outright; `domain: [null, 100]` pins one
 * end and leaves the other to the data; otherwise `zero` and `nice` apply.
 */
export function resolveDomain(options: DomainOptions): ResolvedDomain {
  const spec = options.spec;
  const wantsZero = spec?.zero ?? options.zeroByDefault;
  const zeroSuppressed = options.zeroByDefault && spec?.zero === false;

  let extent = options.data;
  if (options.include !== undefined && isFiniteNumber(options.include)) {
    extent = unionExtent(extent, [options.include, options.include]);
  }
  if (wantsZero) extent = unionExtent(extent, [0, 0]);
  if (extent === undefined) return { domain: EMPTY_DOMAIN, zeroSuppressed };

  let [lo, hi] = undegenerate(extent);

  const explicit = spec?.domain;
  const pinnedLo = explicit?.[0];
  const pinnedHi = explicit?.[1];
  const hasPinnedLo = typeof pinnedLo === 'number' && Number.isFinite(pinnedLo);
  const hasPinnedHi = typeof pinnedHi === 'number' && Number.isFinite(pinnedHi);

  if ((spec?.nice ?? options.niceByDefault ?? true) && !(hasPinnedLo && hasPinnedHi)) {
    [lo, hi] = niceBounds(lo, hi);
    // `nice` must never pull a bound past zero when zero was requested.
    if (wantsZero) {
      if (lo > 0) lo = 0;
      if (hi < 0) hi = 0;
    }
  }
  if (hasPinnedLo) lo = pinnedLo;
  if (hasPinnedHi) hi = pinnedHi;

  if (!isFiniteNumber(lo) || !isFiniteNumber(hi)) return { domain: EMPTY_DOMAIN, zeroSuppressed };
  if (lo === hi) return { domain: undegenerate([lo, hi]), zeroSuppressed };
  return { domain: lo <= hi ? [lo, hi] : [hi, lo], zeroSuppressed };
}

/**
 * The scale type a channel should use.
 *
 * The author's `scale.type` wins; otherwise the type's declared default applies.
 */
export function resolveScaleType(channel: Channel | undefined, fallback: ScaleType): ScaleType {
  return channel?.scale?.type ?? fallback;
}

/** `true` when a log scale is in force and non-positive rows must be dropped. */
export function isLogLike(type: ScaleType): boolean {
  return type === 'log';
}
