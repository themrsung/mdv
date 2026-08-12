/**
 * Seriation — ordering the rows and columns of a matrix so that similar ones sit
 * together (SPEC 8.9 `sort: cluster`).
 *
 * A heatmap under `sort: cluster` is asking for the ordering that makes its
 * structure visible: rows that behave alike should be neighbours, so blocks form
 * instead of confetti. The textbook answer is hierarchical clustering with an
 * optimal leaf ordering, which is O(n³) in time and needs a tie-breaking rule at
 * every merge to stay reproducible.
 *
 * This module takes the cheaper and steadier route: **order by the first
 * principal component**. Projecting each row onto the direction of greatest
 * variance and sorting by that projection is a classical seriation, it is
 * O(n · m · iterations), and — the reason it was chosen over agglomerative
 * clustering — it needs no size cap. There is no diagnostic in SPEC 15.2 for
 * "this matrix was too big to cluster", so the implementation must not be able
 * to reach that state.
 *
 * Everything here is arithmetic on doubles plus `Math.sqrt`, which IEEE-754
 * requires to be correctly rounded. No `Math.random`, no transcendental
 * functions whose last bit is implementation-defined, and a fixed iteration
 * count rather than a convergence threshold: the same matrix seriates to the
 * same order on every machine and every run (SPEC 24.3).
 */

import { compareNumbers } from './num.js';

/** Below this many rows there is nothing to reorder that the reader would notice. */
const MIN_ROWS = 3;

/**
 * Power-iteration steps. Fixed rather than convergence-tested, because a
 * threshold makes the result depend on how fast the machine's arithmetic
 * happens to settle; a count makes it depend on nothing.
 */
const ITERATIONS = 64;

/** A matrix cell that was never observed. */
export type Cell = number | null | undefined;

/**
 * Deterministic non-constant seed for the power iteration.
 *
 * A constant seed vector can be exactly orthogonal to the leading eigenvector of
 * a symmetric matrix, in which case the iteration never leaves the subspace it
 * started in and the seriation silently degrades to the input order. Knuth's
 * multiplicative hash costs nothing and cannot be orthogonal to anything in
 * particular. It is integer arithmetic below 2⁵³ followed by one division, so it
 * is bit-identical everywhere.
 */
function seedComponent(index: number): number {
  return ((index * 2654435761) % 2097152) / 2097152 - 0.5;
}

/** Euclidean norm. */
function norm(vector: readonly number[]): number {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}

/**
 * Order the rows of `matrix` so that similar rows are adjacent.
 *
 * Returns a permutation of `0 … rows-1`. Missing cells are imputed with the
 * grand mean of the observed ones — the neutral choice, which pulls a row with
 * gaps towards the middle rather than towards either extreme.
 *
 * The direction of the ordering is fixed so that rows with small values come
 * first: an eigenvector is only defined up to its sign, and leaving the sign to
 * the arithmetic would let a chart flip end-for-end between two runs on
 * different data with the same shape.
 */
export function clusterOrder(matrix: readonly (readonly Cell[])[]): number[] {
  const rows = matrix.length;
  const identity = Array.from({ length: rows }, (_, index) => index);
  if (rows < MIN_ROWS) return identity;

  let columns = 0;
  for (const row of matrix) columns = Math.max(columns, row.length);
  if (columns === 0) return identity;

  // ── Impute, then centre each column ─────────────────────────────────────────
  let observed = 0;
  let total = 0;
  for (const row of matrix) {
    for (const value of row) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        observed += 1;
      }
    }
  }
  if (observed === 0) return identity;
  const grand = total / observed;

  const data: number[][] = [];
  for (let r = 0; r < rows; ++r) {
    const source = matrix[r] ?? [];
    const row: number[] = new Array<number>(columns);
    for (let c = 0; c < columns; ++c) {
      const value = source[c];
      row[c] = typeof value === 'number' && Number.isFinite(value) ? value : grand;
    }
    data.push(row);
  }
  for (let c = 0; c < columns; ++c) {
    let columnTotal = 0;
    for (const row of data) columnTotal += row[c] ?? 0;
    const mean = columnTotal / rows;
    for (const row of data) row[c] = (row[c] ?? 0) - mean;
  }

  // ── Leading eigenvector of XᵀX, by power iteration ──────────────────────────
  let axis: number[] = Array.from({ length: columns }, (_, index) => seedComponent(index));
  const seedNorm = norm(axis);
  if (!(seedNorm > 0)) return identity;
  axis = axis.map((value) => value / seedNorm);

  const projected: number[] = new Array<number>(rows).fill(0);
  for (let step = 0; step < ITERATIONS; ++step) {
    for (let r = 0; r < rows; ++r) {
      const row = data[r] ?? [];
      let dot = 0;
      for (let c = 0; c < columns; ++c) dot += (row[c] ?? 0) * (axis[c] ?? 0);
      projected[r] = dot;
    }
    const next: number[] = new Array<number>(columns).fill(0);
    for (let r = 0; r < rows; ++r) {
      const row = data[r] ?? [];
      const weight = projected[r] ?? 0;
      for (let c = 0; c < columns; ++c) next[c] = (next[c] ?? 0) + (row[c] ?? 0) * weight;
    }
    const length = norm(next);
    // No variance left to find: the matrix is constant, or the iteration has
    // collapsed. Either way the input order is as good as any other.
    if (!(length > 0)) return identity;
    axis = next.map((value) => value / length);
  }

  const scores: number[] = new Array<number>(rows).fill(0);
  for (let r = 0; r < rows; ++r) {
    const row = data[r] ?? [];
    let dot = 0;
    for (let c = 0; c < columns; ++c) dot += (row[c] ?? 0) * (axis[c] ?? 0);
    scores[r] = dot;
  }

  // ── Orient: small totals first ──────────────────────────────────────────────
  let orientation = 0;
  for (let r = 0; r < rows; ++r) {
    const row = data[r] ?? [];
    let rowTotal = 0;
    for (let c = 0; c < columns; ++c) rowTotal += row[c] ?? 0;
    orientation += (scores[r] ?? 0) * rowTotal;
  }
  if (orientation === 0) {
    // The projection is uncorrelated with row magnitude, so "small first" has
    // nothing to say. Fall back to the conventional sign rule: the first row
    // that has an opinion gets a positive score.
    orientation = scores.find((value) => value !== 0) ?? 0;
  }
  if (orientation < 0) {
    for (let r = 0; r < rows; ++r) scores[r] = -(scores[r] ?? 0);
  }

  return identity.sort((a, b) => {
    const delta = compareNumbers(scores[a] ?? 0, scores[b] ?? 0);
    return delta !== 0 ? delta : a - b;
  });
}

/** Transpose a matrix, so {@link clusterOrder} can seriate its columns. */
export function transpose(matrix: readonly (readonly Cell[])[]): Cell[][] {
  let columns = 0;
  for (const row of matrix) columns = Math.max(columns, row.length);
  const out: Cell[][] = [];
  for (let c = 0; c < columns; ++c) {
    const row: Cell[] = new Array<Cell>(matrix.length);
    for (let r = 0; r < matrix.length; ++r) row[r] = matrix[r]?.[c];
    out.push(row);
  }
  return out;
}
