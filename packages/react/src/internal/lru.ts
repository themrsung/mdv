/**
 * A tiny insertion-ordered LRU, used for every stage memo in this package.
 *
 * `Map` iteration is insertion order, so "least recently used" is "first key",
 * and promoting an entry is a delete followed by a set. That is O(1) and needs
 * no linked list.
 *
 * **No instance of this is module-level.** SPEC 17.3 invariant 4 forbids global
 * mutable state: two documents must render concurrently without interference, so
 * every cache is owned by the provider (or by the component) that created it.
 */
export class Lru<V> {
  readonly #max: number;
  readonly #entries = new Map<string, V>();

  constructor(max: number) {
    this.#max = Math.max(1, Math.floor(max));
  }

  /** Number of live entries. */
  get size(): number {
    return this.#entries.size;
  }

  get(key: string): V | undefined {
    const found = this.#entries.get(key);
    if (found === undefined) return undefined;
    // Promote. `has` first would be a second lookup; `undefined` is not a legal
    // stored value in any of this package's caches.
    this.#entries.delete(key);
    this.#entries.set(key, found);
    return found;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  set(key: string, value: V): V {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, value);
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    return value;
  }

  /** Get, or compute and store. The computation runs at most once per key. */
  getOrCompute(key: string, compute: () => V): V {
    const found = this.get(key);
    if (found !== undefined) return found;
    return this.set(key, compute());
  }

  clear(): void {
    this.#entries.clear();
  }
}
