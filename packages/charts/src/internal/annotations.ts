/**
 * Annotations (SPEC 8.14), available on any cartesian block.
 *
 * ```yaml
 * annotations:
 *   - {type: line, y: 1500, label: Target, style: dashed}
 *   - {type: band, x: [2026-03-01, 2026-03-15], label: Outage}
 *   - {type: point, x: 2026-05-02, y: 1820, label: Launch}
 *   - {type: text, x: 2026-06-01, y: 1900, text: "Peak", anchor: start}
 * ```
 *
 * > **Annotation ink is chrome, not data**: it uses text and border tokens, never
 * > a series color, so it can never be mistaken for a series.
 *
 * That rule is enforced structurally here — no function in this module accepts a
 * series or a palette, so there is nothing to draw a series color from.
 */

import type { BlockAttrs, LayoutContext, Rect, Scale, SceneNode } from '@mdv/core';
import { finite, isFiniteNumber } from './num.js';
import { chromeStroke, labelFont, solid } from './paint.js';
import { px } from './geometry.js';

/** The four annotation forms of SPEC 8.14. */
export type AnnotationKind = 'line' | 'band' | 'point' | 'text';

/** One parsed annotation. Positions are still in data space. */
export interface Annotation {
  kind: AnnotationKind;
  /** Scalar position, or a two-element extent for a `band`. */
  x?: unknown;
  y?: unknown;
  label?: string;
  text?: string;
  dashed: boolean;
  anchor: 'start' | 'middle' | 'end';
}

/** A raw annotation entry as it appears in the attribute bag. */
type RawAnnotation = Readonly<Record<string, unknown>>;

/**
 * Parse the `annotations` attribute.
 *
 * Entries that name no usable position are dropped rather than rejected: one
 * malformed annotation must not cost the reader the chart (SPEC 14.1).
 */
export function parseAnnotations(attrs: BlockAttrs): Annotation[] {
  const raw = (attrs as Readonly<Record<string, unknown>>)['annotations'];
  if (!Array.isArray(raw)) return [];
  const out: Annotation[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as RawAnnotation;
    const kindText = typeof record['type'] === 'string' ? record['type'] : 'line';
    const kind: AnnotationKind =
      kindText === 'band' || kindText === 'point' || kindText === 'text' ? kindText : 'line';
    const anchorText = record['anchor'];
    const annotation: Annotation = {
      kind,
      dashed: record['style'] === 'dashed',
      anchor: anchorText === 'start' || anchorText === 'end' ? anchorText : 'middle',
    };
    if (record['x'] !== undefined) annotation.x = record['x'];
    if (record['y'] !== undefined) annotation.y = record['y'];
    if (typeof record['label'] === 'string') annotation.label = record['label'];
    if (typeof record['text'] === 'string') annotation.text = record['text'];
    if (annotation.x === undefined && annotation.y === undefined) continue;
    out.push(annotation);
  }
  return out;
}

/** Coerce an annotation position to something a scale accepts. */
function toScaleInput(value: unknown): number | string | Date | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    return trimmed;
  }
  return undefined;
}

/**
 * Project an annotation position through a scale, trying a date reading when the
 * scale is temporal — `x: 2026-03-01` arrives as a string from YAML.
 */
function project(scale: Scale | undefined, value: unknown): number | undefined {
  if (scale === undefined) return undefined;
  const input = toScaleInput(value);
  if (input === undefined) return undefined;
  const direct = scale.scale(input);
  if (isFiniteNumber(direct)) return direct;
  if (typeof input === 'string') {
    if (scale.type === 'time') {
      const parsed = Date.parse(input);
      if (Number.isFinite(parsed)) {
        const viaDate = scale.scale(new Date(parsed));
        if (isFiniteNumber(viaDate)) return viaDate;
      }
    }
    const numeric = Number(input);
    if (Number.isFinite(numeric)) {
      const viaNumber = scale.scale(numeric);
      if (isFiniteNumber(viaNumber)) return viaNumber;
    }
  }
  return undefined;
}

/** Both ends of a `band` extent, in scene coordinates, ordered low to high. */
function projectExtent(scale: Scale | undefined, value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const a = project(scale, value[0]);
  const b = project(scale, value[1]);
  if (a === undefined || b === undefined) return undefined;
  return a <= b ? [a, b] : [b, a];
}

/** Scales an annotation layer draws against. */
export interface AnnotationScales {
  x?: Scale | undefined;
  y?: Scale | undefined;
}

/**
 * Render annotations into scene nodes.
 *
 * Called from a chart type's `layout` **after** the scales have been ranged, so
 * every projection lands in the same coordinate space as the marks.
 */
export function annotationNodes(
  annotations: readonly Annotation[],
  scales: AnnotationScales,
  frame: Rect,
  ctx: LayoutContext,
): SceneNode[] {
  if (annotations.length === 0) return [];
  const nodes: SceneNode[] = [];
  const theme = ctx.theme;
  const font = labelFont(theme, theme.type.tickScale);
  const inkPaint = solid(theme.tokens['text-secondary']);
  const left = finite(frame.x, 0);
  const right = left + Math.max(0, finite(frame.width, 0));
  const top = finite(frame.y, 0);
  const bottom = top + Math.max(0, finite(frame.height, 0));

  for (const annotation of annotations) {
    switch (annotation.kind) {
      case 'line': {
        const y = project(scales.y, annotation.y);
        const x = project(scales.x, annotation.x);
        if (y !== undefined) {
          nodes.push({
            kind: 'line',
            cls: 'mdv-annotation mdv-annotation-line',
            x1: px(left),
            y1: px(y),
            x2: px(right),
            y2: px(y),
            stroke: chromeStroke(theme, annotation.dashed),
          });
          if (annotation.label !== undefined) {
            nodes.push(annotationLabel(annotation.label, right, y - 4, 'end', font, inkPaint, ctx));
          }
        } else if (x !== undefined) {
          nodes.push({
            kind: 'line',
            cls: 'mdv-annotation mdv-annotation-line',
            x1: px(x),
            y1: px(top),
            x2: px(x),
            y2: px(bottom),
            stroke: chromeStroke(theme, annotation.dashed),
          });
          if (annotation.label !== undefined) {
            nodes.push(
              annotationLabel(annotation.label, x, top - 2, 'middle', font, inkPaint, ctx),
            );
          }
        }
        break;
      }
      case 'band': {
        const xExtent = projectExtent(scales.x, annotation.x);
        const yExtent = projectExtent(scales.y, annotation.y);
        if (xExtent !== undefined) {
          nodes.push({
            kind: 'rect',
            cls: 'mdv-annotation mdv-annotation-band',
            x: px(xExtent[0]),
            y: px(top),
            w: px(xExtent[1] - xExtent[0]),
            h: px(bottom - top),
            fill: solid(theme.tokens.border, 0.18),
          });
          if (annotation.label !== undefined) {
            nodes.push(
              annotationLabel(
                annotation.label,
                (xExtent[0] + xExtent[1]) / 2,
                top - 2,
                'middle',
                font,
                inkPaint,
                ctx,
              ),
            );
          }
        } else if (yExtent !== undefined) {
          nodes.push({
            kind: 'rect',
            cls: 'mdv-annotation mdv-annotation-band',
            x: px(left),
            y: px(yExtent[0]),
            w: px(right - left),
            h: px(yExtent[1] - yExtent[0]),
            fill: solid(theme.tokens.border, 0.18),
          });
          if (annotation.label !== undefined) {
            nodes.push(
              annotationLabel(annotation.label, right, yExtent[0] - 2, 'end', font, inkPaint, ctx),
            );
          }
        }
        break;
      }
      case 'point': {
        const x = project(scales.x, annotation.x);
        const y = project(scales.y, annotation.y);
        if (x === undefined || y === undefined) break;
        nodes.push({
          kind: 'circle',
          cls: 'mdv-annotation mdv-annotation-point',
          cx: px(x),
          cy: px(y),
          r: px(Math.max(2, theme.marks.marker.minDiameter / 2)),
          fill: solid(theme.tokens.surface),
          stroke: {
            paint: solid(theme.tokens['text-secondary']),
            width: theme.marks.line.width,
            cap: 'round',
            join: 'round',
          },
        });
        if (annotation.label !== undefined) {
          nodes.push(
            annotationLabel(
              annotation.label,
              x,
              y - theme.marks.marker.minDiameter,
              'middle',
              font,
              inkPaint,
              ctx,
            ),
          );
        }
        break;
      }
      case 'text': {
        const x = project(scales.x, annotation.x);
        const y = project(scales.y, annotation.y);
        const body = annotation.text ?? annotation.label;
        if (x === undefined || y === undefined || body === undefined) break;
        nodes.push(annotationLabel(body, x, y, annotation.anchor, font, inkPaint, ctx));
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

/** An annotation's text, measured so a backend can reason about collisions. */
function annotationLabel(
  text: string,
  x: number,
  y: number,
  anchor: 'start' | 'middle' | 'end',
  font: ReturnType<typeof labelFont>,
  fill: ReturnType<typeof solid>,
  ctx: LayoutContext,
): SceneNode {
  return {
    kind: 'text',
    cls: 'mdv-annotation mdv-annotation-label',
    x: px(x),
    y: px(y),
    text,
    font,
    fill,
    anchor,
    baseline: 'bottom',
    width: px(ctx.metrics.measure(text, font).width),
  };
}
