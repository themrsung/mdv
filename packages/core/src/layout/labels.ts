/**
 * Direct-label placement and collision resolution (SPEC 11.5).
 *
 * > **A label that will not fit is not clipped.** The layout engine measures
 * > first. Outside the bar end if there is room, else the tooltip and the table
 * > view. `overflow: hidden` on a segment is never an acceptable solution —
 * > cropping the first characters is worse than no label.
 *
 * The chart proposes and **core disposes**: a chart type emits
 * {@link DirectLabel}s with a preferred side and a priority, and this module
 * decides which survive. Labels are placed highest priority first, so when space
 * runs out the ones that go are the ones the chart cared least about — "label the
 * endpoint, the extreme, or the one series the story is about" only works if the
 * endpoint wins the contest.
 *
 * Dropped labels emit `MDV5011` and point at the table view, which is why the
 * table view is mandatory (SPEC 12.3).
 */

import type { DirectLabel } from '../registry.js';
import type { LayoutContext, Rect } from '../types/layout.js';
import type { Font, SceneNode, TextNode } from '../types/scene.js';
import { relativeLuminance } from '../scale/color.js';
import { CLS } from './ids.js';
import { lineHeight, makeText, measureWidth, solid, themeFont } from './text.js';

/** Clear space kept between two placed labels. */
export const LABEL_PADDING = 2;
/** Distance from the anchor point to the label box. */
export const LABEL_OFFSET = 4;
/** Luminance above which a label inside a fill switches to ink. */
const LIGHT_FILL_LUMINANCE = 0.45;

/** The order candidate placements are tried in, per preferred side. */
const FALLBACKS: Readonly<Record<DirectLabel['placement'], readonly DirectLabel['placement'][]>> =
  Object.freeze({
    above: ['above', 'below', 'end', 'start', 'inside'],
    below: ['below', 'above', 'end', 'start', 'inside'],
    start: ['start', 'end', 'above', 'below', 'inside'],
    end: ['end', 'start', 'above', 'below', 'inside'],
    inside: ['inside', 'above', 'below', 'end', 'start'],
    outside: ['above', 'end', 'below', 'start', 'inside'],
  });

/** The outcome of placing a set of labels. */
export interface LabelPlacement {
  nodes: SceneNode[];
  /** Labels drawn. */
  placed: number;
  /** Labels omitted rather than clipped. Drives `MDV5011`. */
  dropped: number;
}

/** Options for {@link placeDirectLabels}. */
export interface LabelPlacementOptions {
  /** Labels must stay inside this rectangle. Usually the content box. */
  bounds: Rect;
  /** Boxes already occupied — axis labels, the legend — that labels must avoid. */
  occupied?: readonly Rect[];
  font?: Font;
}

/**
 * Place direct labels, dropping the ones that will not fit.
 *
 * Ordering is by priority descending, then by series identity and datum index —
 * a total order that does not depend on the input array's order, so two runs
 * place the same labels (SPEC 24.3).
 */
export function placeDirectLabels(
  labels: readonly DirectLabel[],
  ctx: LayoutContext,
  options: LabelPlacementOptions,
): LabelPlacement {
  if (labels.length === 0) return { nodes: [], placed: 0, dropped: 0 };

  const font = options.font ?? themeFont(ctx.theme, 'label');
  const height = lineHeight(font, ctx.metrics);
  const occupied: Rect[] = [...(options.occupied ?? [])];
  const nodes: SceneNode[] = [];
  let dropped = 0;

  const ordered = [...labels].sort(compareLabels);

  for (const label of ordered) {
    const width = measureWidth(label.text, font, ctx.metrics);
    const chain = FALLBACKS[label.placement] ?? FALLBACKS.above;

    let chosen:
      { rect: Rect; anchor: TextNode['anchor']; baseline: TextNode['baseline'] } | undefined;
    for (const placement of chain) {
      const candidate = candidateBox(label, placement, width, height);
      if (!contains(options.bounds, candidate.rect)) continue;
      if (overlapsAny(candidate.rect, occupied)) continue;
      chosen = candidate;
      break;
    }

    if (chosen === undefined) {
      ++dropped;
      continue;
    }

    occupied.push(chosen.rect);
    nodes.push(
      makeText(
        {
          x: anchorX(chosen.rect, chosen.anchor),
          y: anchorY(chosen.rect, chosen.baseline),
          text: label.text,
          font,
          fill: solid(labelColor(label, ctx)),
          anchor: chosen.anchor,
          baseline: chosen.baseline,
          cls: CLS.label,
          id: ctx.ids.next('label'),
        },
        ctx.metrics,
      ),
    );
  }

  return { nodes, placed: nodes.length, dropped };
}

/** Priority descending; ties broken by identity, then datum. Never locale-aware. */
function compareLabels(a: DirectLabel, b: DirectLabel): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.seriesId !== b.seriesId) return a.seriesId < b.seriesId ? -1 : 1;
  if (a.datum !== b.datum) return a.datum - b.datum;
  if (a.text !== b.text) return a.text < b.text ? -1 : 1;
  return 0;
}

/** The box a placement would occupy, plus the text anchoring that produces it. */
function candidateBox(
  label: DirectLabel,
  placement: DirectLabel['placement'],
  width: number,
  height: number,
): { rect: Rect; anchor: TextNode['anchor']; baseline: TextNode['baseline'] } {
  switch (placement) {
    case 'below':
      return {
        rect: { x: label.x - width / 2, y: label.y + LABEL_OFFSET, width, height },
        anchor: 'middle',
        baseline: 'top',
      };
    case 'start':
      return {
        rect: {
          x: label.x - LABEL_OFFSET - width,
          y: label.y - height / 2,
          width,
          height,
        },
        anchor: 'end',
        baseline: 'middle',
      };
    case 'end':
      return {
        rect: { x: label.x + LABEL_OFFSET, y: label.y - height / 2, width, height },
        anchor: 'start',
        baseline: 'middle',
      };
    case 'inside':
      return {
        rect: { x: label.x - width / 2, y: label.y - height / 2, width, height },
        anchor: 'middle',
        baseline: 'middle',
      };
    case 'outside':
    case 'above':
    default:
      return {
        rect: { x: label.x - width / 2, y: label.y - LABEL_OFFSET - height, width, height },
        anchor: 'middle',
        baseline: 'bottom',
      };
  }
}

function anchorX(rect: Rect, anchor: TextNode['anchor']): number {
  if (anchor === 'start') return rect.x;
  if (anchor === 'end') return rect.x + rect.width;
  return rect.x + rect.width / 2;
}

function anchorY(rect: Rect, baseline: TextNode['baseline']): number {
  if (baseline === 'top') return rect.y;
  if (baseline === 'bottom') return rect.y + rect.height;
  return rect.y + rect.height / 2;
}

/** `true` when `inner` lies wholly inside `outer`. */
export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - 0.001 &&
    inner.y >= outer.y - 0.001 &&
    inner.x + inner.width <= outer.x + outer.width + 0.001 &&
    inner.y + inner.height <= outer.y + outer.height + 0.001
  );
}

/** `true` when two rectangles overlap, allowing for the label padding. */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width + LABEL_PADDING &&
    b.x < a.x + a.width + LABEL_PADDING &&
    a.y < b.y + b.height + LABEL_PADDING &&
    b.y < a.y + a.height + LABEL_PADDING
  );
}

function overlapsAny(rect: Rect, boxes: readonly Rect[]): boolean {
  for (const box of boxes) if (overlaps(rect, box)) return true;
  return false;
}

/**
 * The colour of a direct label (SPEC 11.5).
 *
 * **Text never wears the data colour.** A label on the surface uses a text
 * token; the one exception is a label set *inside* a coloured fill, which picks
 * white or ink by the fill's luminance so it stays legible on either.
 */
export function labelColor(label: DirectLabel, ctx: LayoutContext): string {
  if (label.insideFill === undefined) return ctx.theme.tokens['text-primary'];
  return relativeLuminance(label.insideFill) > LIGHT_FILL_LUMINANCE
    ? ctx.theme.tokens['text-primary']
    : ctx.theme.tokens.surface;
}
