/**
 * Small shared vocabularies used across chart types.
 *
 * These mirror attribute enums in SPEC 8; they live here rather than in each
 * type's module so that `bar` and `area` cannot drift apart on what `stack`
 * means.
 */

/** `stack` (SPEC 8.2, 8.4). `center` is a streamgraph. */
export type StackMode = 'none' | 'normal' | 'percent' | 'center';

/** Every legal `stack` spelling, for {@link enumAttr}. */
export const STACK_MODES: readonly StackMode[] = ['none', 'normal', 'percent', 'center'];

/** `orientation` (SPEC 8.2). */
export type Orientation = 'vertical' | 'horizontal';

/** Every legal `orientation` spelling. */
export const ORIENTATIONS: readonly Orientation[] = ['vertical', 'horizontal'];

/** `curve` (SPEC 8.3). */
export type CurveKind =
  'linear' | 'monotone' | 'step' | 'stepBefore' | 'stepAfter' | 'natural' | 'basis';

/** Every legal `curve` spelling. */
export const CURVE_KINDS: readonly CurveKind[] = [
  'linear',
  'monotone',
  'step',
  'stepBefore',
  'stepAfter',
  'natural',
  'basis',
];

/** `nullPolicy` (SPEC 6.5). */
export type NullPolicy = 'gap' | 'skip' | 'zero' | 'drop';

/** Every legal `nullPolicy` spelling. */
export const NULL_POLICIES: readonly NullPolicy[] = ['gap', 'skip', 'zero', 'drop'];

/** `points` (SPEC 8.3): the marker policy. */
export type PointPolicy = 'none' | 'all' | 'ends' | 'extremes';

/** Every legal `points` spelling. */
export const POINT_POLICIES: readonly PointPolicy[] = ['none', 'all', 'ends', 'extremes'];

/** `sort` (SPEC 8.2, 8.5). */
export type SortMode = 'none' | 'asc' | 'desc';

/** Every legal `sort` spelling. */
export const SORT_MODES: readonly SortMode[] = ['none', 'asc', 'desc'];

/** Point shapes (SPEC 8.6). Secondary encoding for colour-vision deficiency. */
export type PointShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'star';

/** Every legal `shape` spelling. */
export const POINT_SHAPES: readonly PointShape[] = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'cross',
  'star',
];
