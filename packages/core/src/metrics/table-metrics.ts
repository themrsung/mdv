/**
 * `TableMetrics` — the deterministic {@link TextMetrics} provider (SPEC 21,
 * SPEC 24.3 rule 6).
 *
 * This is the **default**. Anything that must be reproducible across machines —
 * golden files, SSR that must match the client's first paint, PDF pagination —
 * measures through here. The browser's `CanvasMetrics` is faster and more exact
 * for the font actually installed, and is therefore *less* useful when the
 * requirement is that two machines agree.
 */

import type { Font } from '../types/scene.js';
import type { GlyphMetrics, TextMetrics } from '../types/layout.js';
import {
  DEFAULT_ASCENT,
  DEFAULT_DESCENT,
  stringWidthEm,
  styleFactor,
  weightFactor,
} from './width-table.js';

/** Options for {@link createTableMetrics}. */
export interface TableMetricsOptions {
  /**
   * Cap on the memo table. Measurement is called once per label per layout and
   * layouts repeat on every resize, so caching pays; an unbounded cache in a
   * long-lived editor session does not.
   * @defaultValue 4096
   */
  cacheSize?: number;
}

/** A measurement cache key. Fonts differing only in `lineHeight` measure alike. */
function cacheKey(text: string, font: Font): string {
  return `${font.size}|${font.weight ?? 400}|${font.style ?? 'normal'}|${
    font.letterSpacing ?? 0
  }|${text}`;
}

/**
 * Build the deterministic metrics provider.
 *
 * Pure and total: an unmeasurable string yields a best-effort width, never a
 * throw — one missing glyph must not take out a page (SPEC 21).
 */
export function createTableMetrics(options: TableMetricsOptions = {}): TextMetrics {
  const limit = Math.max(0, options.cacheSize ?? 4096);
  const cache = new Map<string, GlyphMetrics>();

  return {
    measure(text: string, font: Font): GlyphMetrics {
      const size = Number.isFinite(font.size) && font.size > 0 ? font.size : 13;
      if (text === '')
        return { width: 0, ascent: DEFAULT_ASCENT * size, descent: DEFAULT_DESCENT * size };

      const key = cacheKey(text, { ...font, size });
      const hit = cache.get(key);
      if (hit !== undefined) return hit;

      const em = stringWidthEm(text);
      const spacing = (font.letterSpacing ?? 0) * countGraphemes(text);
      const width = em * size * weightFactor(font.weight) * styleFactor(font.style) + spacing;

      const metrics: GlyphMetrics = {
        width,
        ascent: DEFAULT_ASCENT * size,
        descent: DEFAULT_DESCENT * size,
      };
      if (limit > 0) {
        if (cache.size >= limit) {
          // Evict the oldest entry. Map iteration is insertion order, which is
          // exactly the FIFO this wants and is deterministic (SPEC 24.3 rule 5).
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, metrics);
      }
      return metrics;
    },
  };
}

/** Code-point count, which is what letter-spacing applies between. */
function countGraphemes(text: string): number {
  let count = 0;
  for (const _ of text) ++count;
  return count > 0 ? count - 1 : 0;
}

/**
 * A shared instance for callers that do not need their own cache.
 *
 * Safe to share: the provider is pure, and its cache is a memo whose contents
 * cannot change an answer. It is not global *state* in the sense SPEC 17.3
 * invariant 4 forbids — two documents measuring the same string get the same
 * number, which is the whole point.
 */
export const defaultTableMetrics: TextMetrics = createTableMetrics();
