/**
 * The ordinal scale (SPEC 7.2): discrete domain → discrete range.
 *
 * Used for shape, for texture, and for color where the range is a fixed palette.
 *
 * **The range is not cycled.** SPEC 11.2 rule 2 is explicit that a ninth series
 * is never a generated hue, and cycling is the same failure wearing a different
 * hat: two entities would share a color and the legend would lie. Past the end
 * of the range the scale returns `undefined` and the caller folds the value into
 * "Other" (`MDV3062`).
 */

import type { Scale, ScaleInput } from '../types/encode.js';

/** Construction options for {@link createOrdinalScale}. */
export interface OrdinalScaleOptions<R> {
  /** Domain values in first-appearance order over the *unfiltered* data. */
  domain: readonly string[];
  /** Range values, consumed in order. */
  range: readonly R[];
  /** Returned for a domain value past the end of the range. */
  unknown?: R;
}

/** Build an ordinal scale. */
export function createOrdinalScale<R>(options: OrdinalScaleOptions<R>): Scale<string, R> {
  const domain: string[] = [];
  const index = new Map<string, number>();
  for (const value of options.domain) {
    if (index.has(value)) continue;
    index.set(value, domain.length);
    domain.push(value);
  }
  const range = [...options.range];

  const scale: Scale<string, R> = {
    type: 'ordinal',
    domain: Object.freeze([...domain]),
    range: Object.freeze(range) as readonly R[],
    scale(value: string): R | undefined {
      const slot = index.get(String(value));
      if (slot === undefined || slot >= range.length) return options.unknown;
      return range[slot];
    },
    ticks: () => domain,
    format: (value: string) => String(value),
  };
  return Object.freeze(scale);
}

/**
 * Distinct values of a column, in **first-appearance order**.
 *
 * First appearance rather than sorted, because SPEC 11.2 rule 1 keys color on
 * identity resolved in first-appearance order: sorting would make a series'
 * color depend on its neighbours' names.
 */
export function distinctInOrder(values: Iterable<ScaleInput | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const key = value instanceof Date ? value.toISOString() : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
