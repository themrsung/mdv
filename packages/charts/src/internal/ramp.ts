/**
 * The value → color ramp behind `heatmap` and every later type that paints a
 * magnitude rather than a category (SPEC 8.9, 11.3).
 *
 * The arithmetic lives in `@mdv/core`'s scale module; what this file adds is the
 * part a chart type actually needs and core cannot know:
 *
 * - **Which ramp.** `scheme` names one of the theme's per-hue ramps, or lists
 *   colors outright, or is absent — and each way of getting it wrong has to
 *   degrade to something drawable and *say so* (SPEC 15.2).
 * - **Where the legend's labels go.** A ramp legend is a bar with labelled ends
 *   and midpoint (SPEC 8.9), and for a classed scale the labels belong on the
 *   class edges. Both are a function of the scale's shape, so the scale should
 *   hand them over rather than leave each chart type to re-derive them.
 *
 * Two invariants SPEC 11.3 is emphatic about, and how they are held here:
 *
 * - **A sequential ramp is one hue, light to dark — never a rainbow.** Every
 *   color this file produces is either a listed theme step or a point on the
 *   segment between two adjacent listed steps, so nothing can wander off the hue.
 * - **A diverging ramp meets at a neutral gray, never at a hue.** The midpoint
 *   color comes from `theme.diverging.mid`, and the domain is widened to contain
 *   the midpoint rather than folding one arm away.
 */

import type { ColorString, Scale, Theme } from '@mdv/core';
import {
  createDivergingScale,
  createQuantileScale,
  createQuantizeScale,
  createSequentialScale,
  createThresholdScale,
  sampleRamp,
} from '@mdv/core';
import { compareNumbers, compareStrings } from './num.js';

/** The five color scales SPEC 7.2 and 8.9 name. */
export type ColorScaleKind = 'sequential' | 'diverging' | 'quantize' | 'quantile' | 'threshold';

/** Every spelling `colorScale` accepts, in the order SPEC 8.9 lists them. */
export const COLOR_SCALE_KINDS: readonly ColorScaleKind[] = Object.freeze([
  'sequential',
  'diverging',
  'quantize',
  'quantile',
  'threshold',
]);

/**
 * Classes to cut a classed scale into when the author did not say.
 *
 * Five is the largest number of fills a reader can tell apart and match back to
 * a legend without counting; past that the classes stop being a shorthand and
 * the reader is better served by the continuous ramp they did not ask for.
 */
export const DEFAULT_CLASSES = 5;

/**
 * Label every class edge up to this many, then fall back to ends and middle.
 *
 * Edge labels are what make a classed scale readable — "which bucket is this?"
 * is answerable from the legend only if the cuts are written on it — but they
 * are also the densest labels in the layout, and past a handful they collide
 * into illegibility, which serves the reader worse than three honest ones.
 */
const MAX_LABELLED_EDGES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Schemes
// ─────────────────────────────────────────────────────────────────────────────

/** Why a requested `scheme` was not honoured, for the caller to report. */
export type SchemeFallback =
  /** No ramp by that name in this theme. */
  | 'unknown'
  /** A single hue was named for a scale that needs two arms and a neutral. */
  | 'single-hue';

/** The outcome of reading `scheme`. */
export interface ResolvedScheme {
  /** The ramp, **lightest first** — the order `sampleRamp` expects. */
  readonly steps: readonly ColorString[];
  /** Present when the request could not be honoured and the default was used. */
  readonly fallback?: SchemeFallback;
}

/** The two arms and the neutral of a diverging ramp, in display order. */
export interface DivergingArms {
  /** The low extreme first, the step nearest the midpoint last. */
  readonly lowSteps: readonly ColorString[];
  /** The step nearest the midpoint first, the high extreme last. */
  readonly highSteps: readonly ColorString[];
  /** The neutral gray that sits at the midpoint. Never a hue (SPEC 11.3). */
  readonly mid: ColorString;
}

/** The ramp names this theme offers, sorted — the `allowed` list of MDV1502. */
export function schemeNames(theme: Theme): readonly string[] {
  if (theme.ramps === undefined) return [];
  return Object.keys(theme.ramps).sort(compareStrings);
}

/** The strings in an attribute value, whether it arrived as one or as a list. */
function stringList(requested: unknown): readonly string[] {
  const raw = Array.isArray(requested) ? requested : [requested];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * Read `scheme` for a one-hue ramp (SPEC 8.9).
 *
 * Two or more colors are taken **verbatim**: an author who lists a ramp has
 * already decided, and second-guessing them would leave no way to draw a ramp
 * the theme does not carry. A single entry is read as a name — a lone color
 * cannot be a ramp, and reading it as one would mean inventing the other end.
 */
export function resolveScheme(theme: Theme, requested: unknown): ResolvedScheme {
  const listed = stringList(requested);
  if (listed.length > 1) return { steps: listed };
  const name = listed[0];
  if (name === undefined) return { steps: theme.sequential.steps };
  const ramp = theme.ramps?.[name];
  if (ramp === undefined) return { steps: theme.sequential.steps, fallback: 'unknown' };
  return { steps: ramp.steps };
}

/**
 * Read `scheme` for a diverging ramp (SPEC 8.9).
 *
 * A **named** scheme is a single hue, and a single hue cannot diverge: bending
 * one into two arms would put that hue at zero, which SPEC 11.3 forbids outright
 * — zero has to read as nothing. So a name is reported and the theme's diverging
 * palette is used instead.
 *
 * A **listed** scheme is split down the middle. An odd count donates its middle
 * entry as the neutral, since that is plainly where the author put it; an even
 * count has no middle to donate, so the theme's neutral joins the two halves.
 */
export function resolveDivergingArms(
  theme: Theme,
  requested: unknown,
): { readonly arms: DivergingArms; readonly fallback?: SchemeFallback } {
  const listed = stringList(requested);
  if (listed.length > 2) {
    const odd = listed.length % 2 === 1;
    const half = Math.floor(listed.length / 2);
    const mid = odd ? (listed[half] as ColorString) : theme.diverging.mid;
    return {
      arms: {
        lowSteps: listed.slice(0, half),
        highSteps: listed.slice(odd ? half + 1 : half),
        mid,
      },
    };
  }
  const arms: DivergingArms = {
    lowSteps: theme.diverging.lowSteps,
    highSteps: theme.diverging.highSteps,
    mid: theme.diverging.mid,
  };
  if (listed.length === 1) return { arms, fallback: 'single-hue' };
  return { arms };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ramp
// ─────────────────────────────────────────────────────────────────────────────

/** One legend label: a value, and where along the bar it belongs (0…1). */
export interface RampTick {
  readonly at: number;
  readonly value: number;
}

/** A built color ramp, plus everything its legend needs. */
export interface ColorRamp {
  readonly kind: ColorScaleKind;
  /** The gradient, low end first. Sampled evenly — the legend re-samples it. */
  readonly stops: readonly ColorString[];
  /** True for a classed scale, whose legend is drawn with hard edges. */
  readonly discrete: boolean;
  /** The values worth writing on the bar, ascending. */
  readonly ticks: readonly RampTick[];
  /** The class edges, ascending; empty for a continuous scale. */
  readonly edges: readonly number[];
  /** The fill for one value; `undefined` when the value is not a number. */
  color(value: number): ColorString | undefined;
}

/** Construction options for {@link createColorRamp}. */
export interface ColorRampOptions {
  readonly kind: ColorScaleKind;
  /** The extent the ramp spans: the author's `domain`, or the data's. */
  readonly domain: readonly [number, number];
  /** The one-hue ramp, from {@link resolveScheme}. */
  readonly steps: readonly ColorString[];
  /** The two arms, from {@link resolveDivergingArms}. Diverging only. */
  readonly arms?: DivergingArms;
  /** Where the neutral sits. Diverging only; SPEC 8.9 defaults it to zero. */
  readonly midpoint?: number;
  /** `bins` — how many classes to cut a classed scale into. */
  readonly classes?: number;
  /** The sample. Quantile only: its cuts are data-defined, not extent-defined. */
  readonly values?: readonly number[];
  /** Author-supplied cuts. Threshold only. */
  readonly thresholds?: readonly number[];
}

/** `k` colors spanning the ramp, for a scale with `k` classes. */
function classColors(steps: readonly ColorString[], k: number): readonly ColorString[] {
  const out: ColorString[] = [];
  for (let i = 0; i < k; ++i) out.push(sampleRamp(steps, k === 1 ? 1 : i / (k - 1)));
  return out;
}

/** The labels for a continuous bar: both ends and the middle (SPEC 8.9). */
function continuousTicks(lo: number, hi: number, middle: number): readonly RampTick[] {
  if (!(hi > lo)) return [{ at: 0.5, value: lo }];
  return [
    { at: 0, value: lo },
    { at: (middle - lo) / (hi - lo), value: middle },
    { at: 1, value: hi },
  ];
}

/** The labels for a classed bar: the ends, and the cuts between the classes. */
function classedTicks(
  lo: number,
  hi: number,
  edges: readonly number[],
  classes: number,
): readonly RampTick[] {
  const ticks: RampTick[] = [{ at: 0, value: lo }];
  if (edges.length <= MAX_LABELLED_EDGES) {
    edges.forEach((value, index) => ticks.push({ at: (index + 1) / classes, value }));
  } else {
    const middle = Math.floor((edges.length - 1) / 2);
    ticks.push({ at: (middle + 1) / classes, value: edges[middle] as number });
  }
  ticks.push({ at: 1, value: hi });
  return ticks;
}

/** Ascending, finite and deduplicated — the shape every cut list has to be in. */
function usableCuts(cuts: readonly number[] | undefined): readonly number[] {
  if (cuts === undefined) return [];
  const sorted = cuts.filter((value) => Number.isFinite(value)).sort(compareNumbers);
  return sorted.filter((value, index) => index === 0 || value !== sorted[index - 1]);
}

/**
 * Build the ramp for one `colorScale` (SPEC 8.9).
 *
 * The five kinds fall into two families. `sequential` and `diverging` are
 * continuous: the gradient is the ramp itself and the labels sit at the ends and
 * the middle. `quantize`, `quantile` and `threshold` are classed: the gradient
 * becomes one flat band per class, and the labels move onto the cuts, because a
 * class boundary the reader cannot read is a class they cannot name.
 *
 * `bins` discretises a continuous ramp (SPEC 8.9), which is exactly `quantize`
 * over the same extent — so it is routed there rather than given a fourth code
 * path that would have to agree with it byte for byte.
 */
export function createColorRamp(options: ColorRampOptions): ColorRamp {
  const [d0, d1] = options.domain;
  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);
  const steps = options.steps.length > 0 ? options.steps : ['#000000'];

  if (options.kind === 'diverging') {
    const arms = options.arms ?? { lowSteps: [], highSteps: [], mid: steps[0] as ColorString };
    // A midpoint outside the extent would leave one arm no room, and a diverging
    // scale with one arm is a sequential scale wearing two hues. Widening the
    // extent to reach the midpoint keeps both arms, and keeps the neutral at the
    // value the author said means "nothing".
    const midpoint = Number.isFinite(options.midpoint) ? (options.midpoint as number) : 0;
    const low = Math.min(lo, midpoint);
    const high = Math.max(hi, midpoint);
    const scale = createDivergingScale({
      domain: [low, midpoint, high],
      lowSteps: arms.lowSteps,
      highSteps: arms.highSteps,
      mid: arms.mid,
    });
    return frozen({
      kind: 'diverging',
      // Sampled by value, not by step, so an off-centre midpoint puts the
      // neutral where the reader will look for it rather than halfway along.
      stops: sampleByValue(
        scale,
        low,
        high,
        (arms.lowSteps.length + arms.highSteps.length) * 2 + 1,
      ),
      discrete: false,
      ticks: continuousTicks(low, high, midpoint),
      edges: [],
      color: (value) => scale.scale(value),
    });
  }

  if (options.kind === 'sequential' && options.classes === undefined) {
    const scale = createSequentialScale({ domain: [lo, hi], steps });
    return frozen({
      kind: 'sequential',
      stops: [...steps],
      discrete: false,
      ticks: continuousTicks(lo, hi, (lo + hi) / 2),
      edges: [],
      color: (value) => scale.scale(value),
    });
  }

  if (options.kind === 'quantile') {
    const classes = Math.max(1, Math.round(options.classes ?? DEFAULT_CLASSES));
    const range = classColors(steps, classes);
    const scale = createQuantileScale({ values: options.values ?? [], range });
    const edges = usableCuts(scale.ticks?.());
    return frozen({
      kind: 'quantile',
      stops: range,
      discrete: true,
      ticks: classedTicks(lo, hi, edges, classes),
      edges,
      color: (value) => scale.scale(value),
    });
  }

  if (options.kind === 'threshold') {
    const edges = usableCuts(options.thresholds);
    if (edges.length > 0) {
      const range = classColors(steps, edges.length + 1);
      const scale = createThresholdScale({ thresholds: edges, range });
      return frozen({
        kind: 'threshold',
        stops: range,
        discrete: true,
        ticks: classedTicks(lo, hi, edges, edges.length + 1),
        edges,
        color: (value) => scale.scale(value),
      });
    }
    // No cuts to threshold on. Equal-width classes are the nearest thing to
    // what was asked for, and they are drawn with the same hard edges, so the
    // reader still gets the classed scale the author chose.
  }

  const classes = Math.max(1, Math.round(options.classes ?? DEFAULT_CLASSES));
  const range = classColors(steps, classes);
  const scale = createQuantizeScale({ domain: [lo, hi], range });
  const edges: number[] = [];
  for (let i = 1; i < classes; ++i) edges.push(lo + ((hi - lo) * i) / classes);
  return frozen({
    // The author's spelling, not the mechanism: a `sequential` ramp with `bins`
    // is still the sequential ramp they asked for, cut into bands.
    kind: options.kind,
    stops: range,
    discrete: true,
    ticks: classedTicks(lo, hi, edges, classes),
    edges,
    color: (value) => scale.scale(value),
  });
}

/** Even samples of a continuous scale across its extent, low end first. */
function sampleByValue(
  scale: Scale<number, ColorString>,
  lo: number,
  hi: number,
  count: number,
): readonly ColorString[] {
  const n = Math.max(2, count);
  const out: ColorString[] = [];
  for (let i = 0; i < n; ++i) {
    const value = hi > lo ? lo + ((hi - lo) * i) / (n - 1) : lo;
    out.push(scale.scale(value) ?? (scale.range[0] as ColorString));
  }
  return out;
}

/** Freeze a built ramp: nothing downstream may edit a scale out from under core. */
function frozen(ramp: ColorRamp): ColorRamp {
  return Object.freeze({
    ...ramp,
    stops: Object.freeze([...ramp.stops]),
    ticks: Object.freeze([...ramp.ticks]),
    edges: Object.freeze([...ramp.edges]),
  });
}
