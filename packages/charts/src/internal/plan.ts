/**
 * Carrying a chart type's own state from `encode` to `layout`.
 *
 * ## Why this exists
 *
 * CONTRACT — `packages/core/src/registry.ts`. `ChartType.layout` is
 * `(encoded: EncodeResult<M>, frame: Rect, ctx: LayoutContext)`. None of those
 * three carries the block, its attributes, or the prepared table, yet every real
 * chart type needs resolved attributes at geometry time: `bar` needs
 * `orientation` and `corner`, `line` needs `curve` and `points`, `pie` needs
 * `innerRadius` and `padAngle`, `table` needs its whole column configuration.
 * Re-deriving them is impossible — `attrs` is simply not reachable from `layout`.
 *
 * ## How it is carried, now
 *
 * Through {@link EncodeResult.state}, a declared `unknown` slot that core
 * promises to carry from `encode` to `layout` untouched and never to read.
 *
 * This used to be smuggled: `PlannedEncodeResult` added an *undeclared* `plan`
 * member and relied on structural subtyping to get it past the boundary, which
 * worked only because core happens to rebuild the result with a spread
 * (`{ ...encoded, scales, axes }`). Any core-side change to a fresh object
 * literal would have silently dropped every chart type's attributes and every
 * chart would have quietly reverted to its defaults — no type error, no
 * diagnostic, just wrong pictures. The slot is declared now, so that refactor
 * would be a compile error instead.
 *
 * ## Degradation
 *
 * {@link planOf} still never throws, and still falls back. `state` is typed
 * `unknown` on the shared interface precisely because a foreign `EncodeResult`
 * may carry someone else's value in it; a chart type that throws becomes
 * `MDV5000` and costs the reader the whole block (SPEC 14.1).
 */

import type { EncodeResult, Mark } from '@mdv/core';

/**
 * An {@link EncodeResult} carrying a chart type's private layout state.
 *
 * The narrowing is the point: `EncodeResult.state` is `unknown`, and each type
 * declares what *its* state is.
 */
export interface PlannedEncodeResult<M extends Mark, P> extends EncodeResult<M> {
  /** Resolved attributes and precomputed per-mark data, owned by one chart type. */
  readonly state: P;
}

/**
 * Recover the plan a chart type attached in `encode`.
 *
 * @param encoded - the value core handed back to `layout`
 * @param fallback - the type's defaults, used when the state is missing or was
 * produced by a different chart type
 */
export function planOf<M extends Mark, P>(encoded: EncodeResult<M>, fallback: P): P {
  const candidate = encoded.state;
  return candidate === undefined ? fallback : (candidate as P);
}
