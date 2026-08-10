/**
 * Scene graph → content-stream operators (SPEC 20, SPEC 28.5).
 *
 * **Charts are vector content, never rasterised**, and they are drawn from the
 * very `Scene` the screen draws — there is no second layout path here, no
 * re-measurement, no re-ticking. That is not an optimisation: if the exporter
 * laid out again, pagination would be deciding how much space a chart needs
 * using different numbers from the ones the chart was drawn with, and the two
 * would eventually disagree in a way no test would catch.
 *
 * Coordinates stay in **scene pixels** throughout. The px→pt scale and the
 * y-axis flip live in one matrix pushed before the first node, so every number
 * below is directly comparable with the same number in the SVG backend's
 * output.
 */

import type {
  CircleNode,
  Def,
  GroupNode,
  ImageNode,
  LineNode,
  Paint,
  PathCommand,
  PathNode,
  RectNode,
  Scene,
  SceneNode,
  Stroke,
  TextNode,
  Transform,
  UseNode,
} from '@mdv/core';
import type { Rgba } from './color.js';
import { parseColorOr, toGray, WHITE } from './color.js';
import type { Bbox, Matrix } from './geometry.js';
import {
  arcToCubics,
  circlePath,
  cornerRadii,
  emptyBbox,
  growBbox,
  isEmptyBbox,
  pathBbox,
  roundedRectPath,
} from './geometry.js';
import { clamp } from './number.js';
import type { PdfOp } from './ops.js';
import * as O from './ops.js';
import type { FaceMetrics } from './fonts.js';
import { fontKeyOf, needsShaping, standardFace } from './fonts.js';
import type { ResourcePool, ShadingStop } from './resources.js';
import { PT_PER_PX } from './units.js';

/** Print-profile policy (SPEC 28.5). */
export interface PrintPolicy {
  /**
   * Hairlines are thickened to this many points. Thinner strokes disappear on
   * some printers, so a 1 px gridline that survives on screen has to grow.
   */
  minStrokePt: number;
  /**
   * Type below this size is **dropped, not shrunk** (SPEC 28.5). A 5 pt axis
   * label is not a small label, it is a smudge, and the table view carries the
   * same information.
   */
  minTypePt: number;
  /** Enable the texture channel and desaturate (`pdf.grayscale`). */
  grayscale: boolean;
}

/** The default print policy of SPEC 28.5. */
export const PRINT_POLICY: PrintPolicy = { minStrokePt: 0.5, minTypePt: 7, grayscale: false };

/** Where a scene sits on a page. */
export interface ScenePlacement {
  /** Distance from the page's left edge, in points. */
  xPt: number;
  /** Distance from the page's **top** edge, in points. */
  yPt: number;
  /** Scene pixels → points. `PT_PER_PX` draws 1:1; less shrinks the block. */
  scale: number;
  /** Page height in points, for the flip. */
  pageHeightPt: number;
}

/** What one scene cost, beyond its operators. */
export interface SceneDrawResult {
  ops: PdfOp[];
  /** Codepoints no available face could encode, sorted (`MDV5100`). */
  missingCodePoints: readonly number[];
  /** `true` when a run needed shaping this exporter cannot do (`MDV5101`). */
  shapingRequired: boolean;
  /** Labels dropped for falling below {@link PrintPolicy.minTypePt}. */
  droppedLabels: number;
}

/** Options for {@link drawScene}. */
export interface DrawSceneOptions {
  pool: ResourcePool;
  placement: ScenePlacement;
  policy?: PrintPolicy;
  /**
   * Wrap the whole scene in a marked-content sequence with this MCID, so the
   * structure tree can point a `/Figure` at it (SPEC 28.8).
   */
  mcid?: number;
  /** Resolve an `image` href to bytes. Backends never fetch (SPEC 20). */
  resolveImage?: (href: string) => { format: 'png' | 'jpg'; bytes: Uint8Array } | undefined;
}

interface Ctx {
  pool: ResourcePool;
  policy: PrintPolicy;
  scale: number;
  defs: ReadonlyMap<string, Def>;
  ops: PdfOp[];
  missing: Set<number>;
  shaping: boolean;
  dropped: number;
  resolveImage:
    ((href: string) => { format: 'png' | 'jpg'; bytes: Uint8Array } | undefined) | undefined;
  /** Pattern space → page default space, for tiling-pattern matrices. */
  base: Matrix;
}

function colorFor(ctx: Ctx, value: string, fallback: Rgba): Rgba {
  const parsed = parseColorOr(value, fallback);
  return ctx.policy.grayscale ? toGray(parsed) : parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/** Emit the construction operators for a structured command list. */
export function pathOps(commands: readonly PathCommand[]): PdfOp[] {
  const out: PdfOp[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  for (const c of commands) {
    switch (c.c) {
      case 'M':
        out.push(O.moveTo(c.x, c.y));
        cx = c.x;
        cy = c.y;
        startX = c.x;
        startY = c.y;
        break;
      case 'L':
        out.push(O.lineTo(c.x, c.y));
        cx = c.x;
        cy = c.y;
        break;
      case 'C':
        out.push(O.curveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y));
        cx = c.x;
        cy = c.y;
        break;
      case 'Q': {
        // Degree-elevate: PDF has no quadratic operator, and elevation is exact.
        const c1x = cx + (2 / 3) * (c.x1 - cx);
        const c1y = cy + (2 / 3) * (c.y1 - cy);
        const c2x = c.x + (2 / 3) * (c.x1 - c.x);
        const c2y = c.y + (2 / 3) * (c.y1 - c.y);
        out.push(O.curveTo(c1x, c1y, c2x, c2y, c.x, c.y));
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'A': {
        for (const seg of arcToCubics({ x: cx, y: cy }, c)) {
          out.push(O.curveTo(seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y));
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case 'Z':
        out.push(O.closePath());
        cx = startX;
        cy = startY;
        break;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paint
// ─────────────────────────────────────────────────────────────────────────────

function stopsOf(
  stops: readonly { offset: number; color: string; opacity?: number }[],
  ctx: Ctx,
): ShadingStop[] {
  const out = stops.map((s) => ({
    offset: clamp(s.offset, 0, 1),
    color: { ...colorFor(ctx, s.color, WHITE), a: s.opacity ?? 1 },
  }));
  // A shading needs at least two stops and a monotonically increasing domain.
  if (out.length === 0)
    return [
      { offset: 0, color: WHITE },
      { offset: 1, color: WHITE },
    ];
  const first = out[0] as ShadingStop;
  if (out.length === 1)
    return [
      { ...first, offset: 0 },
      { ...first, offset: 1 },
    ];
  return out;
}

function mapUnit(value: number, lo: number, hi: number): number {
  return lo + value * (hi - lo);
}

/**
 * What to do with a `Paint` on a shape.
 *
 * `solid` is the overwhelmingly common case and costs one `rg`. The other two
 * need the shape's own bounding box, which is why they are resolved per shape
 * rather than once per def.
 */
type FillPlan =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgba }
  | { kind: 'shading'; resource: string }
  | { kind: 'pattern'; resource: string; background: Rgba | undefined };

function planFill(ctx: Ctx, paint: Paint | undefined, bbox: Bbox): FillPlan {
  if (paint === undefined) return { kind: 'none' };
  if (paint.kind === 'solid') {
    const color = colorFor(ctx, paint.color, { r: 0, g: 0, b: 0, a: 1 });
    return { kind: 'solid', color: { ...color, a: color.a * (paint.opacity ?? 1) } };
  }
  if (paint.kind === 'gradient') {
    const def = ctx.defs.get(paint.def);
    if (def === undefined) return { kind: 'none' };
    if (def.kind === 'linear-gradient') {
      const objectBox = (def.units ?? 'objectBoundingBox') === 'objectBoundingBox';
      const box = isEmptyBbox(bbox) ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : bbox;
      const coords = objectBox
        ? [
            mapUnit(def.x1, box.minX, box.maxX),
            mapUnit(def.y1, box.minY, box.maxY),
            mapUnit(def.x2, box.minX, box.maxX),
            mapUnit(def.y2, box.minY, box.maxY),
          ]
        : [def.x1, def.y1, def.x2, def.y2];
      return {
        kind: 'shading',
        resource: ctx.pool.shading({ kind: 'axial', coords, stops: stopsOf(def.stops, ctx) }),
      };
    }
    if (def.kind === 'radial-gradient') {
      const objectBox = (def.units ?? 'objectBoundingBox') === 'objectBoundingBox';
      const box = isEmptyBbox(bbox) ? { minX: 0, minY: 0, maxX: 1, maxY: 1 } : bbox;
      const spanX = box.maxX - box.minX;
      const spanY = box.maxY - box.minY;
      const cx = objectBox ? mapUnit(def.cx, box.minX, box.maxX) : def.cx;
      const cy = objectBox ? mapUnit(def.cy, box.minY, box.maxY) : def.cy;
      const r = objectBox ? def.r * Math.max(Math.abs(spanX), Math.abs(spanY)) : def.r;
      return {
        kind: 'shading',
        resource: ctx.pool.shading({
          kind: 'radial',
          coords: [cx, cy, 0, cx, cy, Math.abs(r)],
          stops: stopsOf(def.stops, ctx),
        }),
      };
    }
    return { kind: 'none' };
  }
  // Pattern (SPEC 12.6 textures).
  const def = ctx.defs.get(paint.def);
  if (def === undefined || def.kind !== 'pattern') return { kind: 'none' };
  const tileCtx: Ctx = { ...ctx, ops: [] };
  for (const child of def.content) drawNode(tileCtx, child);
  const content = tileCtx.ops.map(O.opToText).join('\n');
  const resource = ctx.pool.pattern(`${def.id}|${content}`, {
    width: def.width,
    height: def.height,
    matrix: ctx.base,
    content,
    usesGraphicsStates: [],
  });
  const background =
    paint.background === undefined ? undefined : colorFor(ctx, paint.background, WHITE);
  return { kind: 'pattern', resource, background };
}

/** Stroke geometry, resolved against the print policy. */
interface StrokePlan {
  color: Rgba;
  width: number;
  setup: PdfOp[];
}

function planStroke(ctx: Ctx, stroke: Stroke | undefined, bbox: Bbox): StrokePlan | undefined {
  if (stroke === undefined) return undefined;
  const plan = planFill(ctx, stroke.paint, bbox);
  // A gradient- or pattern-stroked shape is vanishingly rare and PDF would need
  // a pattern colour space per stroke; the first stop is a faithful stand-in and
  // never silently disappears.
  const color: Rgba =
    plan.kind === 'solid'
      ? plan.color
      : plan.kind === 'pattern' && plan.background !== undefined
        ? plan.background
        : { r: 0, g: 0, b: 0, a: 1 };
  const minPx = ctx.policy.minStrokePt / PT_PER_PX / (ctx.scale / PT_PER_PX);
  const width = Math.max(stroke.width, minPx);
  const setup: PdfOp[] = [O.strokeColor(color.r, color.g, color.b), O.lineWidth(width)];
  const cap = stroke.cap ?? 'butt';
  if (cap !== 'butt') setup.push(O.lineCap(cap === 'round' ? 1 : 2));
  const join = stroke.join ?? 'miter';
  if (join !== 'miter') setup.push(O.lineJoin(join === 'round' ? 1 : 2));
  if (stroke.miterLimit !== undefined) setup.push(O.miterLimit(stroke.miterLimit));
  if (stroke.dash !== undefined && stroke.dash.length > 0) {
    setup.push(O.dashPattern(stroke.dash, stroke.dashOffset ?? 0));
  }
  return { color, width, setup };
}

/**
 * Paint a shape: fill, then stroke, honouring the fill rule.
 *
 * `construct` is a thunk because a shading fill has to build the path twice —
 * once to clip with, once to stroke — and re-running the builder is cheaper and
 * far less error-prone than trying to reuse a consumed path.
 */
function paintShape(
  ctx: Ctx,
  construct: () => PdfOp[],
  bbox: Bbox,
  fill: Paint | undefined,
  stroke: Stroke | undefined,
  evenOdd: boolean,
  nodeOpacity: number,
): void {
  const fillPlan = planFill(ctx, fill, bbox);
  const strokePlan = planStroke(ctx, stroke, bbox);
  if (fillPlan.kind === 'none' && strokePlan === undefined) return;

  const fillAlpha = (fillPlan.kind === 'solid' ? fillPlan.color.a : 1) * nodeOpacity;
  const strokeAlpha = (strokePlan?.color.a ?? 1) * nodeOpacity * (stroke?.opacity ?? 1);

  ctx.ops.push(O.saveState());
  const gs = ctx.pool.alpha(fillAlpha, strokeAlpha);
  if (gs !== undefined) ctx.ops.push(O.extGState(gs));

  if (fillPlan.kind === 'shading') {
    ctx.ops.push(O.saveState());
    ctx.ops.push(...construct());
    ctx.ops.push(evenOdd ? O.clipEvenOdd() : O.clipNonZero(), O.endPath());
    ctx.ops.push(O.shade(fillPlan.resource));
    ctx.ops.push(O.restoreState());
    if (strokePlan !== undefined) {
      ctx.ops.push(...strokePlan.setup, ...construct(), O.strokePath());
    }
    ctx.ops.push(O.restoreState());
    return;
  }

  if (fillPlan.kind === 'pattern') {
    if (fillPlan.background !== undefined) {
      const bg = fillPlan.background;
      ctx.ops.push(
        O.fillColor(bg.r, bg.g, bg.b),
        ...construct(),
        evenOdd ? O.fillEvenOdd() : O.fillNonZero(),
      );
    }
    ctx.ops.push(...O.patternFill(fillPlan.resource));
    ctx.ops.push(...construct(), evenOdd ? O.fillEvenOdd() : O.fillNonZero());
    if (strokePlan !== undefined) {
      ctx.ops.push(...strokePlan.setup, ...construct(), O.strokePath());
    }
    ctx.ops.push(O.restoreState());
    return;
  }

  if (fillPlan.kind === 'solid') {
    const c = fillPlan.color;
    ctx.ops.push(O.fillColor(c.r, c.g, c.b));
  }
  if (strokePlan !== undefined) ctx.ops.push(...strokePlan.setup);
  ctx.ops.push(...construct());
  if (fillPlan.kind === 'solid' && strokePlan !== undefined) {
    ctx.ops.push(evenOdd ? O.fillEvenOddAndStroke() : O.fillAndStroke());
  } else if (fillPlan.kind === 'solid') {
    ctx.ops.push(evenOdd ? O.fillEvenOdd() : O.fillNonZero());
  } else {
    ctx.ops.push(O.strokePath());
  }
  ctx.ops.push(O.restoreState());
}

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────

function transformMatrix(t: Transform): Matrix {
  switch (t.kind) {
    case 'translate':
      return [1, 0, 0, 1, t.x, t.y];
    case 'scale':
      return [t.x, 0, 0, t.y, 0, 0];
    case 'rotate': {
      const a = (t.angle * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const cx = t.cx ?? 0;
      const cy = t.cy ?? 0;
      // Rotate about (cx, cy) in a y-down space: positive angles read clockwise.
      return [cos, sin, -sin, cos, cx - cx * cos + cy * sin, cy - cx * sin - cy * cos];
    }
    case 'matrix':
      return [t.a, t.b, t.c, t.d, t.e, t.f];
  }
}

function drawRect(ctx: Ctx, node: RectNode, opacity: number): void {
  const radii = cornerRadii(node);
  const rounded = radii.some((r) => r > 0);
  const construct = rounded
    ? (): PdfOp[] => pathOps(roundedRectPath(node.x, node.y, node.w, node.h, radii))
    : (): PdfOp[] => [O.rectangle(node.x, node.y, node.w, node.h)];
  const bbox = growBbox(growBbox(emptyBbox(), node.x, node.y), node.x + node.w, node.y + node.h);
  paintShape(ctx, construct, bbox, node.fill, node.stroke, false, opacity * (node.opacity ?? 1));
}

function drawLine(ctx: Ctx, node: LineNode, opacity: number): void {
  const construct = (): PdfOp[] => [O.moveTo(node.x1, node.y1), O.lineTo(node.x2, node.y2)];
  const bbox = growBbox(growBbox(emptyBbox(), node.x1, node.y1), node.x2, node.y2);
  paintShape(ctx, construct, bbox, undefined, node.stroke, false, opacity * (node.opacity ?? 1));
}

function drawPath(ctx: Ctx, node: PathNode, opacity: number): void {
  const construct = (): PdfOp[] => pathOps(node.d);
  paintShape(
    ctx,
    construct,
    pathBbox(node.d),
    node.fill,
    node.stroke,
    node.fillRule === 'evenodd',
    opacity * (node.opacity ?? 1),
  );
}

function drawCircle(ctx: Ctx, node: CircleNode, opacity: number): void {
  const construct = (): PdfOp[] => pathOps(circlePath(node.cx, node.cy, Math.abs(node.r)));
  const r = Math.abs(node.r);
  const bbox = growBbox(growBbox(emptyBbox(), node.cx - r, node.cy - r), node.cx + r, node.cy + r);
  paintShape(ctx, construct, bbox, node.fill, node.stroke, false, opacity * (node.opacity ?? 1));
}

/** Baseline offset in scene px: distance from the node's `y` down to the baseline. */
function baselineOffset(node: TextNode, face: FaceMetrics): number {
  const size = node.font.size;
  switch (node.baseline) {
    case 'top':
      return face.ascentAtSize(size);
    case 'middle':
      return (face.ascentAtSize(size) - face.descentAtSize(size)) / 2;
    case 'bottom':
      return -face.descentAtSize(size);
    case 'alphabetic':
      return 0;
  }
}

function drawText(ctx: Ctx, node: TextNode, opacity: number): void {
  if (node.text === '') return;
  const sizePt = node.font.size * ctx.scale;
  if (sizePt < ctx.policy.minTypePt) {
    // SPEC 28.5: drop, never shrink. The table view carries the same value.
    ctx.dropped += 1;
    return;
  }
  const key = fontKeyOf(node.font);
  const face = standardFace(key);
  const resource = ctx.pool.font(key);
  for (const cp of face.missingCodePoints(node.text)) ctx.missing.add(cp);
  if (needsShaping(node.text)) ctx.shaping = true;

  const plan = planFill(ctx, node.fill, emptyBbox());
  const color = plan.kind === 'solid' ? plan.color : { r: 0, g: 0, b: 0, a: 1 };
  const alpha = color.a * opacity * (node.opacity ?? 1);

  // Prefer the width layout measured: the whole point of `TextNode.width` is
  // that every backend anchors a label at the same place (SPEC 20).
  const width = node.width ?? face.widthOfTextAtSize(node.text, node.font.size);
  const shift = node.anchor === 'middle' ? width / 2 : node.anchor === 'end' ? width : 0;
  const bo = baselineOffset(node, face);

  const angle = ((node.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const originX = node.x - shift * cos - bo * sin;
  const originY = node.y - shift * sin + bo * cos;

  ctx.ops.push(O.saveState());
  const gs = ctx.pool.alpha(alpha, 1);
  if (gs !== undefined) ctx.ops.push(O.extGState(gs));
  ctx.ops.push(O.fillColor(color.r, color.g, color.b));
  ctx.ops.push(O.beginText());
  ctx.ops.push(O.setFont(resource, node.font.size));
  if (node.font.letterSpacing !== undefined && node.font.letterSpacing !== 0) {
    ctx.ops.push(O.charSpacing(node.font.letterSpacing));
  }
  // The scene CTM flips y; this un-flips the glyphs so they read upright.
  ctx.ops.push(O.textMatrix([cos, sin, sin, -cos, originX, originY]));
  ctx.ops.push(O.showText(node.text, resource));
  ctx.ops.push(O.endText());
  ctx.ops.push(O.restoreState());
}

function drawImage(ctx: Ctx, node: ImageNode, opacity: number): void {
  const resolved = ctx.resolveImage?.(node.href);
  if (resolved === undefined) {
    // SPEC 14.1 principle 2: a failure is visible, never an empty space. The
    // backend must not fetch (SPEC 20), so an unresolvable href becomes a framed
    // placeholder carrying the alt text.
    ctx.ops.push(O.saveState());
    ctx.ops.push(O.strokeColor(0.6, 0.6, 0.6), O.lineWidth(1));
    ctx.ops.push(O.rectangle(node.x, node.y, node.w, node.h), O.strokePath());
    ctx.ops.push(O.restoreState());
    const alt = node.alt;
    if (alt !== undefined && alt !== '') {
      drawText(
        ctx,
        {
          kind: 'text',
          x: node.x + node.w / 2,
          y: node.y + node.h / 2,
          text: alt,
          font: { family: 'sans-serif', size: 11 },
          fill: { kind: 'solid', color: '#666666' },
          anchor: 'middle',
          baseline: 'middle',
        },
        opacity,
      );
    }
    return;
  }
  const resource = ctx.pool.image({ href: node.href, ...resolved });
  ctx.ops.push(O.saveState());
  const gs = ctx.pool.alpha(opacity * (node.opacity ?? 1), 1);
  if (gs !== undefined) ctx.ops.push(O.extGState(gs));
  // An image XObject draws into the unit square, y up; the scene space is y
  // down, so the height is negated and the origin moved to the bottom edge.
  ctx.ops.push(O.concatMatrix([node.w, 0, 0, -node.h, node.x, node.y + node.h]));
  ctx.ops.push(O.drawXObject(resource));
  ctx.ops.push(O.restoreState());
}

function drawUse(ctx: Ctx, node: UseNode, opacity: number): void {
  const def = ctx.defs.get(node.ref);
  if (def === undefined || def.kind !== 'symbol') return;
  ctx.ops.push(O.saveState());
  const dx = node.x ?? 0;
  const dy = node.y ?? 0;
  if (dx !== 0 || dy !== 0) ctx.ops.push(O.concatMatrix([1, 0, 0, 1, dx, dy]));
  if (node.transform !== undefined) ctx.ops.push(O.concatMatrix(transformMatrix(node.transform)));
  // A `use` overrides the symbol's paint only where the symbol declares none,
  // which is how one scatter geometry serves eight series (SPEC 20).
  drawNode(ctx, applyUseOverrides(def.node, node), opacity * (node.opacity ?? 1));
  ctx.ops.push(O.restoreState());
}

function applyUseOverrides(node: SceneNode, use: UseNode): SceneNode {
  if (node.kind === 'group') {
    return { ...node, children: node.children.map((c) => applyUseOverrides(c, use)) };
  }
  if (node.kind === 'text' || node.kind === 'image') return node;
  const next: SceneNode = { ...node };
  if (next.kind !== 'line' && next.fill === undefined && use.fill !== undefined) {
    next.fill = use.fill;
  }
  if (next.stroke === undefined && use.stroke !== undefined) next.stroke = use.stroke;
  return next;
}

function drawGroup(ctx: Ctx, node: GroupNode, opacity: number): void {
  const own = opacity * (node.opacity ?? 1);
  ctx.ops.push(O.saveState());
  if (node.transform !== undefined) ctx.ops.push(O.concatMatrix(transformMatrix(node.transform)));
  if (node.clip !== undefined) {
    const def = ctx.defs.get(node.clip);
    if (def !== undefined && def.kind === 'clip') {
      ctx.ops.push(...pathOps(def.path), O.clipNonZero(), O.endPath());
    }
  }
  for (const child of node.children) drawNode(ctx, child, own);
  ctx.ops.push(O.restoreState());
}

/**
 * Draw one node.
 *
 * The exhaustive switch is load-bearing: SPEC 17.3 invariant 3 says a backend is
 * total, and adding a node kind to the scene graph must make this fail to
 * compile rather than make a chart quietly lose a mark.
 */
function drawNode(ctx: Ctx, node: SceneNode, opacity = 1): void {
  switch (node.kind) {
    case 'group':
      drawGroup(ctx, node, opacity);
      break;
    case 'rect':
      drawRect(ctx, node, opacity);
      break;
    case 'line':
      drawLine(ctx, node, opacity);
      break;
    case 'path':
      drawPath(ctx, node, opacity);
      break;
    case 'circle':
      drawCircle(ctx, node, opacity);
      break;
    case 'text':
      drawText(ctx, node, opacity);
      break;
    case 'image':
      drawImage(ctx, node, opacity);
      break;
    case 'use':
      drawUse(ctx, node, opacity);
      break;
  }
}

/**
 * Draw a whole scene at a placement, returning the operators and what the pass
 * discovered about fonts.
 */
export function drawScene(scene: Scene, options: DrawSceneOptions): SceneDrawResult {
  const policy = options.policy ?? PRINT_POLICY;
  const { placement } = options;
  const s = placement.scale;
  const base: Matrix = [s, 0, 0, -s, placement.xPt, placement.pageHeightPt - placement.yPt];

  const defs = new Map<string, Def>();
  for (const def of scene.defs) defs.set(def.id, def);

  const ctx: Ctx = {
    pool: options.pool,
    policy,
    scale: s,
    defs,
    ops: [],
    missing: new Set<number>(),
    shaping: false,
    dropped: 0,
    resolveImage: options.resolveImage,
    base,
  };

  const ops: PdfOp[] = [];
  ops.push(O.saveState());
  ops.push(O.concatMatrix(base));
  // Clip to the block box: a mark that bleeds past the frame on screen must not
  // bleed into the neighbouring paragraph on paper.
  ops.push(O.rectangle(0, 0, scene.width, scene.height), O.clipNonZero(), O.endPath());
  if (options.mcid !== undefined) ops.push(O.beginMarkedContent('Figure', options.mcid));

  if (scene.background !== undefined) {
    const plan = planFill(
      ctx,
      scene.background,
      growBbox(growBbox(emptyBbox(), 0, 0), scene.width, scene.height),
    );
    if (plan.kind === 'solid') {
      ctx.ops.push(
        O.fillColor(plan.color.r, plan.color.g, plan.color.b),
        O.rectangle(0, 0, scene.width, scene.height),
        O.fillNonZero(),
      );
    }
  }
  drawNode(ctx, scene.root, 1);

  ops.push(...ctx.ops);
  if (options.mcid !== undefined) ops.push(O.endMarkedContent());
  ops.push(O.restoreState());

  return {
    ops,
    missingCodePoints: [...ctx.missing].sort((a, b) => a - b),
    shapingRequired: ctx.shaping,
    droppedLabels: ctx.dropped,
  };
}
