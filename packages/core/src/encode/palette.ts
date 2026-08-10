/**
 * Deterministic palette-slot allocation (SPEC 11.2 rule 1).
 *
 * The whole point of this module is one sentence from the spec: **color follows
 * the entity, not its rank.** A series' slot is keyed on its *identity* — its
 * value in the `series` field, or the field name in wide form — resolved in
 * first-appearance order over the **unfiltered** domain. Add a filter that
 * removes "EMEA" and "APAC" keeps its colour; sort the bars descending and
 * nothing moves. Keying on the index of the filtered array is exactly the bug
 * rule 1 exists to prevent, which is why chart types are given this object
 * instead of the palette array.
 *
 * Two caps bound the allocator:
 *
 * - the palette has **eight** slots and is never cycled (rule 2) — a ninth series
 *   folds into "Other" (`MDV3062`) rather than getting a generated hue;
 * - **all-pairs forms cap at three** (rule 3): scatter, bubble, choropleth and
 *   small multiples can put any two series side by side, and only the first three
 *   slots clear the all-pairs CVD gate (`MDV3061`).
 */

import type { PaletteAllocator } from '../registry.js';
import type { ColorString } from '../types/theme.js';
import { ALL_PAIRS_SERIES_CAP, CATEGORICAL_SLOT_COUNT } from '../types/theme.js';

/** Options for {@link createPaletteAllocator}. */
export interface PaletteAllocatorOptions {
  /**
   * Series identities in **first-appearance order over the unfiltered domain**.
   * Order here *is* the colour assignment; getting it from filtered data is the
   * rule-1 violation.
   */
  identities: readonly string[];
  /** The categorical palette: the theme's, or the block's `palette:` override. */
  colors: readonly ColorString[];
  /**
   * Hard slot cap for the form. `3` for all-pairs forms (SPEC 11.2 rule 3).
   * @defaultValue 8
   */
  cap?: number;
  /** `maxItems` from `legend:` — series past it fold into "Other". @defaultValue 12 */
  maxItems?: number;
  /** Colour of the folded "Other" series. @defaultValue the theme's muted text */
  otherColor?: ColorString;
  /**
   * Texture def ids by slot, when the texture channel is on (SPEC 12.6). Core has
   * already put the defs in the scene.
   */
  patternDefs?: readonly string[];
}

/** A {@link PaletteAllocator} plus what core needs to report on it. */
export interface AllocatedPalette {
  allocator: PaletteAllocator;
  /** Identities that folded into "Other" (`MDV3062`), in first-appearance order. */
  overflow: readonly string[];
  /** Slots actually in use, ascending. */
  usedSlots: readonly number[];
  /** `true` when the all-pairs cap bound the result before the palette did. */
  cappedByForm: boolean;
}

/** Fallback for the folded series: a neutral that reads as "not one of these". */
const DEFAULT_OTHER_COLOR = '#898781';

/**
 * Build the allocator for one block.
 *
 * The mapping is computed once, up front, over the full identity list; `slot`
 * and `color` are then pure lookups. That is deliberate: an allocator that
 * assigned lazily would hand out different slots depending on the order a chart
 * type happened to ask, which is the same non-determinism in a new costume.
 */
export function createPaletteAllocator(options: PaletteAllocatorOptions): AllocatedPalette {
  const colors = options.colors.length > 0 ? [...options.colors] : ['#2a78d6'];
  const formCap = options.cap ?? CATEGORICAL_SLOT_COUNT;
  const maxItems = options.maxItems ?? 12;
  const cap = Math.max(1, Math.min(colors.length, formCap, maxItems));
  const otherColor = options.otherColor ?? DEFAULT_OTHER_COLOR;

  const slots = new Map<string, number>();
  const overflow: string[] = [];
  let next = 0;
  for (const identity of options.identities) {
    if (slots.has(identity)) continue;
    if (next < cap) {
      slots.set(identity, next);
      ++next;
    } else {
      slots.set(identity, -1);
      overflow.push(identity);
    }
  }

  const usedSlots: number[] = [];
  for (let i = 0; i < next; ++i) usedSlots.push(i);

  const allocator: PaletteAllocator = Object.freeze({
    size: cap,
    slot(seriesId: string): number {
      return slots.get(seriesId) ?? -1;
    },
    color(seriesId: string): ColorString {
      const slot = slots.get(seriesId);
      if (slot === undefined || slot < 0) return otherColor;
      return colors[slot % colors.length] ?? otherColor;
    },
    isOverflow(seriesId: string): boolean {
      const slot = slots.get(seriesId);
      return slot === undefined || slot < 0;
    },
    patternDef(seriesId: string): string | undefined {
      const defs = options.patternDefs;
      if (defs === undefined) return undefined;
      const slot = slots.get(seriesId);
      if (slot === undefined || slot < 0) return undefined;
      return defs[slot % Math.max(1, defs.length)];
    },
  });

  return {
    allocator,
    overflow,
    usedSlots,
    cappedByForm: formCap < colors.length && formCap <= maxItems,
  };
}

/**
 * The slot cap for a chart family (SPEC 11.2 rule 3).
 *
 * `nearest` is scatter and bubble — an all-pairs form, because any two points can
 * land next to each other. Bars and cells are adjacent-pair forms and get the
 * full eight.
 */
export function slotCapForFamily(family: string): number {
  return family === 'nearest' ? ALL_PAIRS_SERIES_CAP : CATEGORICAL_SLOT_COUNT;
}
