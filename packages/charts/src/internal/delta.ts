/**
 * The delta rules, shared between the `metric` tile and `:mdv-delta[]` (SPEC 8.13, 9.2).
 *
 * A stat tile and the sentence beside it are the same claim written twice:
 *
 * ```markdown
 * Revenue is up :mdv-delta[0.124]{goodDirection=up}, and the tile says so too.
 * ```
 *
 * Both have to answer two questions the same way — how the number is spelled
 * when the author gave no `deltaFormat`, and whether "up" is good news — because
 * a document whose prose calls a rise green while its tile calls it red is worse
 * than one that simply got the colour wrong. Both answers live here, so the tile
 * and the inline directive read one rule rather than two copies of it.
 *
 * The tone is *not* a colour. SPEC 16.2 requires status to carry a second
 * channel, and each renderer picks its own: the tile paints from
 * `STATUS_PALETTE` and prints an arrow, the React renderer sets a `data-*`
 * attribute the stylesheet keys off and prints the same arrow. What is shared is
 * the classification, which is the part a reader could catch disagreeing.
 */

/** `goodDirection` (SPEC 8.13): which way is the good news. */
export type GoodDirection = 'up' | 'down' | 'none';

/** The accepted values, for `enumAttr` and for the directive's own reader. */
export const GOOD_DIRECTIONS: readonly GoodDirection[] = ['up', 'down', 'none'];

/**
 * How a delta reads against its `goodDirection`.
 *
 * Deliberately three-valued and deliberately not `'warning'`/`'serious'`: a
 * delta is good news, bad news, or no news. The middle two of the four status
 * levels describe a *state* — a threshold crossed — which a change alone cannot
 * tell you about.
 */
export type DeltaTone = 'good' | 'critical' | 'neutral';

/**
 * Direction × `goodDirection` (SPEC 8.13).
 *
 * Zero is neutral whatever the direction, because "unchanged" is neither good
 * nor bad news, and `goodDirection: none` is the author saying explicitly that
 * the metric has no better or worse — a headcount, a share that must sum to one.
 */
export function deltaTone(delta: number, goodDirection: GoodDirection): DeltaTone {
  if (delta === 0 || goodDirection === 'none') return 'neutral';
  const rose = delta > 0;
  if (goodDirection === 'up') return rose ? 'good' : 'critical';
  return rose ? 'critical' : 'good';
}

/**
 * The format an unspelled delta prints in.
 *
 * A delta arrives as either a proportion (`0.124`, "up 12.4%") or an absolute
 * change (`1284`, "up 1,284"), and the author writing `delta: 0.124` in a tile
 * plainly means the first. The magnitude is the only signal available, so the
 * rule is the blunt one — at most 1 in absolute value is a proportion — and it
 * is stated once here rather than guessed twice. An author whose metric really
 * does change by less than one unit writes `deltaFormat` and this never runs.
 *
 * Both formats are signed (`+.1%`, `+,.0f`): a delta without its sign is not a
 * delta, and the sign is what the arrow beside it agrees with.
 */
export function defaultDeltaFormat(delta: number): string {
  return Math.abs(delta) <= 1 ? '+.1%' : '+,.0f';
}
