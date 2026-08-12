/**
 * Summary statistics shared by the charts that describe a distribution.
 *
 * `histogram` needs quartiles for the Freedman–Diaconis bin width (SPEC 8.7)
 * and `box` needs the same quartiles for its hinges and whiskers (SPEC 8.8).
 * One implementation keeps the two agreeing: a box drawn beside a histogram of
 * the same column has to put its hinges where the histogram's rule said the
 * middle half was, and two separately-tuned interpolations would drift apart
 * on small samples exactly where the difference is most visible.
 */

/**
 * The `p`-quantile of an ascending sample, interpolated between neighbours.
 *
 * The caller sorts, because every caller here already has a sorted copy and
 * sorting again per quantile would turn a five-number summary into five sorts.
 */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const a = sorted[lower];
  const b = sorted[upper];
  if (a === undefined || b === undefined) return Number.NaN;
  return a + (b - a) * (position - lower);
}
