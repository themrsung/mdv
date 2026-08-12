/**
 * Deterministic pseudo-randomness (SPEC 24.3).
 *
 * Two charts scatter their marks on purpose — `scatter`'s `jitter` and `box`'s
 * `points: jitter` — and both must land in exactly the same place on every run,
 * on every machine, in every process. `Math.random` cannot do that, so it is
 * never used: the generator is seeded from the block id, which is stable across
 * renders of the same document and different between two blocks of one file.
 */

/** A deterministic seed from the block id (SPEC 24.3: never `Math.random`). */
export function seedFrom(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

/** Mulberry32: a small, fast, fully deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
