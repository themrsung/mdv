/**
 * Scene graph → {@link VNode} tree (SPEC 23.1).
 *
 * The only place in this package that knows what a `RectNode` looks like. It
 * makes **no layout decisions** (SPEC 17.1): every coordinate, colour and font
 * size arrives resolved, and this module's entire job is to spell them in SVG.
 *
 * Two rules run through all of it:
 *
 * - **Attribute order is fixed**, declared literally at each call site, because
 *   the string serialiser's byte-stability is exactly the order these arrays are
 *   built in (SPEC 23.1, 24.3).
 * - **Structured `PathCommand`s are emitted directly.** There is no `d`-string
 *   parser anywhere in this package, in either direction. SPEC 20 makes paths
 *   structured precisely so that no backend has to re-parse them, and a
 *   round-trip through a string would reintroduce the divergence the design
 *   exists to prevent.
 */

import type {
  ArcCommand,
  CircleNode,
  CubicCommand,
  Def,
  Font,
  GroupNode,
  HitRegion,
  ImageNode,
  LineCommand,
  LineNode,
  MoveCommand,
  Paint,
  PathCommand,
  PathNode,
  QuadraticCommand,
  RectNode,
  Scene,
  SceneNode,
  Stroke,
  TextNode,
  Transform,
  UseNode,
} from '@mdv/core';
import { escapeXml, formatNumber, isSafeId, sanitiseClasses, sanitiseUrl } from './format.js';
import type { VNode } from './vnode.js';
import { el } from './vnode.js';

/** Resolved options; every field has a value by the time the builder sees it. */
export interface BuildOptions {
  readonly precision: number;
  readonly classes: boolean;
  readonly interaction: boolean;
  readonly idPrefix: string;
}

/** Defaults for {@link BuildOptions} (SPEC 23.1: 3 decimals is canonical). */
export const DEFAULTS: BuildOptions = Object.freeze({
  precision: 3,
  classes: true,
  interaction: true,
  idPrefix: '',
});

// ─────────────────────────────────────────────────────────────────────────────
// Scalars
// ─────────────────────────────────────────────────────────────────────────────

class Ctx {
  constructor(
    readonly o: BuildOptions,
    readonly prefix: string,
  ) {}

  /** A coordinate or length. */
  n(value: number): string {
    return formatNumber(value, this.o.precision);
  }

  /**
   * An opacity. Opacities are rounded harder than coordinates — three decimals
   * of alpha is below the 8-bit compositing floor, so the extra digits are noise
   * that only makes golden files longer.
   */
  alpha(value: number): string {
    return formatNumber(value, Math.min(this.o.precision, 3));
  }

  /** Namespace an id so two blocks on one page cannot collide (SPEC 13.3). */
  id(raw: string): string | undefined {
    const full = this.prefix.length === 0 ? raw : `${this.prefix}-${raw}`;
    return isSafeId(full) ? full : undefined;
  }

  /** A `url(#…)` reference to a def, or `undefined` when the id is unusable. */
  ref(rawId: string): string | undefined {
    const id = this.id(rawId);
    return id === undefined ? undefined : `url(#${id})`;
  }

  cls(raw: string | undefined): string | undefined {
    if (!this.o.classes || raw === undefined) return undefined;
    const s = sanitiseClasses(raw);
    return s.length === 0 ? undefined : s;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paint, stroke, transform, font
// ─────────────────────────────────────────────────────────────────────────────

/** A paint's `fill`/`stroke` value and its separate opacity, if any. */
interface PaintAttrs {
  readonly value: string;
  readonly opacity: string | undefined;
}

function paintAttrs(paint: Paint | undefined, ctx: Ctx): PaintAttrs {
  if (paint === undefined) return { value: 'none', opacity: undefined };
  switch (paint.kind) {
    case 'solid':
      return {
        value: paint.color,
        opacity: paint.opacity === undefined ? undefined : ctx.alpha(paint.opacity),
      };
    case 'gradient': {
      const ref = ctx.ref(paint.def);
      return {
        value: ref ?? 'none',
        opacity: paint.opacity === undefined ? undefined : ctx.alpha(paint.opacity),
      };
    }
    case 'pattern': {
      const ref = ctx.ref(paint.def);
      return {
        // The pattern tile is transparent between its stripes, so the series
        // colour has to be painted underneath it. SVG has no two-layer fill, so
        // the caller emits a backing rect; see `paintedNode`.
        value: ref ?? paint.background ?? 'none',
        opacity: paint.opacity === undefined ? undefined : ctx.alpha(paint.opacity),
      };
    }
  }
}

/** `true` when a pattern paint needs a solid backing shape drawn beneath it. */
function needsBacking(paint: Paint | undefined): paint is Paint & { background: string } {
  return paint !== undefined && paint.kind === 'pattern' && paint.background !== undefined;
}

function transformValue(t: Transform, ctx: Ctx): string {
  switch (t.kind) {
    case 'translate':
      return `translate(${ctx.n(t.x)} ${ctx.n(t.y)})`;
    case 'scale':
      return `scale(${ctx.n(t.x)} ${ctx.n(t.y)})`;
    case 'rotate':
      return t.cx === undefined && t.cy === undefined
        ? `rotate(${ctx.n(t.angle)})`
        : `rotate(${ctx.n(t.angle)} ${ctx.n(t.cx ?? 0)} ${ctx.n(t.cy ?? 0)})`;
    case 'matrix':
      return `matrix(${ctx.n(t.a)} ${ctx.n(t.b)} ${ctx.n(t.c)} ${ctx.n(t.d)} ${ctx.n(t.e)} ${ctx.n(t.f)})`;
  }
}

/** Stroke attributes, in fixed order. Returns `[]` for no stroke. */
function strokeAttrs(
  stroke: Stroke | undefined,
  ctx: Ctx,
): (readonly [string, string | undefined])[] {
  if (stroke === undefined) return [];
  const p = paintAttrs(stroke.paint, ctx);
  return [
    ['stroke', p.value],
    ['stroke-width', ctx.n(stroke.width)],
    ['stroke-linecap', stroke.cap],
    ['stroke-linejoin', stroke.join],
    ['stroke-miterlimit', stroke.miterLimit === undefined ? undefined : ctx.n(stroke.miterLimit)],
    [
      'stroke-dasharray',
      stroke.dash === undefined || stroke.dash.length === 0
        ? undefined
        : stroke.dash.map((d) => ctx.n(d)).join(' '),
    ],
    ['stroke-dashoffset', stroke.dashOffset === undefined ? undefined : ctx.n(stroke.dashOffset)],
    ['stroke-opacity', stroke.opacity !== undefined ? ctx.alpha(stroke.opacity) : p.opacity],
  ];
}

function fontAttrs(font: Font, ctx: Ctx): (readonly [string, string | undefined])[] {
  return [
    ['font-family', font.family],
    ['font-size', ctx.n(font.size)],
    ['font-style', font.style],
    ['font-weight', font.weight === undefined ? undefined : String(font.weight)],
    ['letter-spacing', font.letterSpacing === undefined ? undefined : ctx.n(font.letterSpacing)],
  ];
}

/**
 * SVG's `dominant-baseline` values for the scene's four baselines.
 *
 * `alphabetic` maps to *nothing*: it is SVG's initial value, and omitting the
 * attribute is both smaller and more robust than restating it, since some PDF
 * and print pipelines mishandle an explicit `alphabetic`.
 */
function baselineValue(baseline: TextNode['baseline']): string | undefined {
  switch (baseline) {
    case 'top':
      return 'hanging';
    case 'middle':
      return 'central';
    case 'bottom':
      return 'text-after-edge';
    case 'alphabetic':
      return undefined;
  }
}

function anchorValue(anchor: TextNode['anchor']): string | undefined {
  return anchor === 'start' ? undefined : anchor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path commands — emitted directly, never via a `d`-string parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serialise structured path commands to a `d` attribute.
 *
 * All commands are absolute (SPEC 20), so every letter is uppercase and there is
 * no pen-state to track. Flags in `A` are emitted as bare `0`/`1`, which is the
 * only spelling the SVG path grammar accepts for them.
 */
export function pathData(commands: readonly PathCommand[], precision: number): string {
  const n = (v: number): string => formatNumber(v, precision);
  const parts: string[] = [];
  for (const cmd of commands) {
    switch (cmd.c) {
      case 'M': {
        const c: MoveCommand = cmd;
        parts.push(`M${n(c.x)} ${n(c.y)}`);
        break;
      }
      case 'L': {
        const c: LineCommand = cmd;
        parts.push(`L${n(c.x)} ${n(c.y)}`);
        break;
      }
      case 'C': {
        const c: CubicCommand = cmd;
        parts.push(`C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`);
        break;
      }
      case 'Q': {
        const c: QuadraticCommand = cmd;
        parts.push(`Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`);
        break;
      }
      case 'A': {
        const c: ArcCommand = cmd;
        parts.push(
          `A${n(c.rx)} ${n(c.ry)} ${n(c.rotate)} ${c.largeArc ? 1 : 0} ${c.sweep ? 1 : 0} ${n(c.x)} ${n(c.y)}`,
        );
        break;
      }
      case 'Z':
        parts.push('Z');
        break;
    }
  }
  return parts.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-corner radii are expressed as an explicit path, because SVG's `rx`/`ry`
 * are uniform. This is the shape SPEC 11.4 asks for by name: a bar **rounded at
 * the data end and square at the baseline**.
 */
function roundedRectPath(r: RectNode, radii: [number, number, number, number]): PathCommand[] {
  const { x, y, w, h } = r;
  const lim = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const cl = (v: number): number => Math.max(0, Math.min(v, lim));
  const [tl, tr, br, bl] = [cl(radii[0]), cl(radii[1]), cl(radii[2]), cl(radii[3])];
  const arc = (rx: number, px: number, py: number): ArcCommand => ({
    c: 'A',
    rx,
    ry: rx,
    rotate: 0,
    largeArc: false,
    sweep: true,
    x: px,
    y: py,
  });
  const d: PathCommand[] = [{ c: 'M', x: x + tl, y }];
  d.push({ c: 'L', x: x + w - tr, y });
  if (tr > 0) d.push(arc(tr, x + w, y + tr));
  d.push({ c: 'L', x: x + w, y: y + h - br });
  if (br > 0) d.push(arc(br, x + w - br, y + h));
  d.push({ c: 'L', x: x + bl, y: y + h });
  if (bl > 0) d.push(arc(bl, x, y + h - bl));
  d.push({ c: 'L', x, y: y + tl });
  if (tl > 0) d.push(arc(tl, x + tl, y));
  d.push({ c: 'Z' });
  return d;
}

function buildRect(node: RectNode, ctx: Ctx): VNode[] {
  const fill = paintAttrs(node.fill, ctx);
  const radii = node.r;
  const perCorner = Array.isArray(radii) ? radii : undefined;

  const common = [
    ['id', node.id === undefined ? undefined : ctx.id(node.id)],
    ['class', ctx.cls(node.cls)],
  ] as const;

  const paintTail = [
    ['fill', fill.value],
    ['fill-opacity', fill.opacity],
    ...strokeAttrs(node.stroke, ctx),
    ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
  ] as const;

  const out: VNode[] = [];
  if (needsBacking(node.fill)) out.push(...backingFor(node, ctx));

  if (perCorner !== undefined) {
    out.push(
      el('path', [
        ...common,
        ['d', pathData(roundedRectPath(node, perCorner), ctx.o.precision)],
        ...paintTail,
      ]),
    );
    return out;
  }

  out.push(
    el('rect', [
      ...common,
      ['x', ctx.n(node.x)],
      ['y', ctx.n(node.y)],
      ['width', ctx.n(node.w)],
      ['height', ctx.n(node.h)],
      ['rx', typeof radii === 'number' && radii > 0 ? ctx.n(radii) : undefined],
      ...paintTail,
    ]),
  );
  return out;
}

/**
 * A solid shape drawn under a pattern-filled one, carrying `PatternPaint.background`.
 *
 * SVG cannot layer two fills on one element, so the series colour becomes its own
 * shape. It is marked `aria-hidden` and given no id: it is a painting artefact,
 * not part of the drawing's structure.
 */
function backingFor(node: RectNode | CircleNode | PathNode, ctx: Ctx): VNode[] {
  const paint = node.fill;
  if (!needsBacking(paint)) return [];
  const bg = paint.background;
  switch (node.kind) {
    case 'rect':
      return [
        el('rect', [
          ['x', ctx.n(node.x)],
          ['y', ctx.n(node.y)],
          ['width', ctx.n(node.w)],
          ['height', ctx.n(node.h)],
          ['rx', typeof node.r === 'number' && node.r > 0 ? ctx.n(node.r) : undefined],
          ['fill', bg],
          ['aria-hidden', 'true'],
        ]),
      ];
    case 'circle':
      return [
        el('circle', [
          ['cx', ctx.n(node.cx)],
          ['cy', ctx.n(node.cy)],
          ['r', ctx.n(node.r)],
          ['fill', bg],
          ['aria-hidden', 'true'],
        ]),
      ];
    case 'path':
      return [
        el('path', [
          ['d', pathData(node.d, ctx.o.precision)],
          ['fill', bg],
          ['fill-rule', node.fillRule],
          ['aria-hidden', 'true'],
        ]),
      ];
  }
}

function buildLine(node: LineNode, ctx: Ctx): VNode[] {
  return [
    el('line', [
      ['id', node.id === undefined ? undefined : ctx.id(node.id)],
      ['class', ctx.cls(node.cls)],
      ['x1', ctx.n(node.x1)],
      ['y1', ctx.n(node.y1)],
      ['x2', ctx.n(node.x2)],
      ['y2', ctx.n(node.y2)],
      ...strokeAttrs(node.stroke, ctx),
      ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
    ]),
  ];
}

function buildPath(node: PathNode, ctx: Ctx): VNode[] {
  const fill = paintAttrs(node.fill, ctx);
  const out: VNode[] = [...backingFor(node, ctx)];
  out.push(
    el('path', [
      ['id', node.id === undefined ? undefined : ctx.id(node.id)],
      ['class', ctx.cls(node.cls)],
      ['d', pathData(node.d, ctx.o.precision)],
      ['fill', fill.value],
      ['fill-opacity', fill.opacity],
      ['fill-rule', node.fillRule],
      ...strokeAttrs(node.stroke, ctx),
      ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
    ]),
  );
  return out;
}

function buildCircle(node: CircleNode, ctx: Ctx): VNode[] {
  const fill = paintAttrs(node.fill, ctx);
  const out: VNode[] = [...backingFor(node, ctx)];
  out.push(
    el('circle', [
      ['id', node.id === undefined ? undefined : ctx.id(node.id)],
      ['class', ctx.cls(node.cls)],
      ['cx', ctx.n(node.cx)],
      ['cy', ctx.n(node.cy)],
      ['r', ctx.n(node.r)],
      ['fill', fill.value],
      ['fill-opacity', fill.opacity],
      ...strokeAttrs(node.stroke, ctx),
      ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
    ]),
  );
  return out;
}

function buildText(node: TextNode, ctx: Ctx): VNode[] {
  const fill = paintAttrs(node.fill, ctx);
  return [
    el(
      'text',
      [
        ['id', node.id === undefined ? undefined : ctx.id(node.id)],
        ['class', ctx.cls(node.cls)],
        ['x', ctx.n(node.x)],
        ['y', ctx.n(node.y)],
        [
          'transform',
          node.rotate === undefined || node.rotate === 0
            ? undefined
            : `rotate(${ctx.n(node.rotate)} ${ctx.n(node.x)} ${ctx.n(node.y)})`,
        ],
        ['text-anchor', anchorValue(node.anchor)],
        ['dominant-baseline', baselineValue(node.baseline)],
        ...fontAttrs(node.font, ctx),
        // SPEC 11.5: y-axis ticks and table values use tabular figures, so a
        // column of numbers lines up. Set through the standardised property, not
        // a font-specific feature string.
        ['font-variant-numeric', node.tabular === true ? 'tabular-nums' : undefined],
        ['fill', fill.value],
        ['fill-opacity', fill.opacity],
        ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
      ],
      [],
      // Real `<text>`, never outlines (SPEC 23.1) — selectable, searchable,
      // translatable, and embeddable as text by the PDF backend. The content is
      // untrusted document data and is escaped on the way out (SPEC 13.3).
      node.text,
    ),
  ];
}

function buildImage(node: ImageNode, ctx: Ctx): VNode[] {
  const href = sanitiseUrl(node.href);
  const children: VNode[] =
    node.alt === undefined || node.alt.length === 0 ? [] : [el('title', [], [], node.alt)];
  return [
    el(
      'image',
      [
        ['id', node.id === undefined ? undefined : ctx.id(node.id)],
        ['class', ctx.cls(node.cls)],
        ['x', ctx.n(node.x)],
        ['y', ctx.n(node.y)],
        ['width', ctx.n(node.w)],
        ['height', ctx.n(node.h)],
        // A rejected scheme drops the reference and keeps the node: the drawing
        // stays structurally intact and the alt text still reaches the reader,
        // which is what SPEC 14.1 principle 2 asks for. `MDV4010` is the
        // caller's to raise — this package has no diagnostic sink.
        ['href', href],
        ['preserveAspectRatio', node.preserveAspectRatio],
        ['aria-label', node.alt],
        ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
      ],
      children,
    ),
  ];
}

function buildUse(node: UseNode, ctx: Ctx): VNode[] {
  const ref = ctx.id(node.ref);
  if (ref === undefined) return [];
  const fill = node.fill === undefined ? undefined : paintAttrs(node.fill, ctx);
  return [
    el('use', [
      ['id', node.id === undefined ? undefined : ctx.id(node.id)],
      ['class', ctx.cls(node.cls)],
      ['href', `#${ref}`],
      ['x', node.x === undefined ? undefined : ctx.n(node.x)],
      ['y', node.y === undefined ? undefined : ctx.n(node.y)],
      ['transform', node.transform === undefined ? undefined : transformValue(node.transform, ctx)],
      ['fill', fill?.value],
      ['fill-opacity', fill?.opacity],
      ...strokeAttrs(node.stroke, ctx),
      ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
    ]),
  ];
}

function buildGroup(node: GroupNode, ctx: Ctx): VNode[] {
  const children: VNode[] = [];
  for (const child of node.children) children.push(...buildNode(child, ctx));
  return [
    el(
      'g',
      [
        ['id', node.id === undefined ? undefined : ctx.id(node.id)],
        ['class', ctx.cls(node.cls)],
        [
          'transform',
          node.transform === undefined ? undefined : transformValue(node.transform, ctx),
        ],
        ['clip-path', node.clip === undefined ? undefined : ctx.ref(node.clip)],
        ['opacity', node.opacity === undefined ? undefined : ctx.alpha(node.opacity)],
        ['role', node.role],
        ['aria-label', node.label],
      ],
      children,
    ),
  ];
}

/**
 * One scene node → zero or more elements.
 *
 * Zero for a `use` whose symbol id is unusable; two when a pattern fill needs a
 * backing shape. Everything else is one.
 *
 * The switch is exhaustive over `SceneNode['kind']`, which is how SPEC 17.3
 * invariant 3 ("backends are total") is enforced here: adding a ninth node kind
 * to the scene graph makes this function fail to compile, rather than making it
 * silently skip the node at runtime.
 */
export function buildNode(node: SceneNode, ctx: Ctx): VNode[] {
  switch (node.kind) {
    case 'group':
      return buildGroup(node, ctx);
    case 'rect':
      return buildRect(node, ctx);
    case 'line':
      return buildLine(node, ctx);
    case 'path':
      return buildPath(node, ctx);
    case 'circle':
      return buildCircle(node, ctx);
    case 'text':
      return buildText(node, ctx);
    case 'image':
      return buildImage(node, ctx);
    case 'use':
      return buildUse(node, ctx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Defs
// ─────────────────────────────────────────────────────────────────────────────

function buildDef(def: Def, ctx: Ctx): VNode[] {
  const id = ctx.id(def.id);
  if (id === undefined) return [];
  switch (def.kind) {
    case 'linear-gradient':
      return [
        el(
          'linearGradient',
          [
            ['id', id],
            ['x1', ctx.n(def.x1)],
            ['y1', ctx.n(def.y1)],
            ['x2', ctx.n(def.x2)],
            ['y2', ctx.n(def.y2)],
            ['gradientUnits', def.units === 'userSpace' ? 'userSpaceOnUse' : undefined],
          ],
          def.stops.map((s) =>
            el('stop', [
              ['offset', ctx.n(s.offset)],
              ['stop-color', s.color],
              ['stop-opacity', s.opacity === undefined ? undefined : ctx.alpha(s.opacity)],
            ]),
          ),
        ),
      ];
    case 'radial-gradient':
      return [
        el(
          'radialGradient',
          [
            ['id', id],
            ['cx', ctx.n(def.cx)],
            ['cy', ctx.n(def.cy)],
            ['r', ctx.n(def.r)],
            ['gradientUnits', def.units === 'userSpace' ? 'userSpaceOnUse' : undefined],
          ],
          def.stops.map((s) =>
            el('stop', [
              ['offset', ctx.n(s.offset)],
              ['stop-color', s.color],
              ['stop-opacity', s.opacity === undefined ? undefined : ctx.alpha(s.opacity)],
            ]),
          ),
        ),
      ];
    case 'pattern': {
      const content: VNode[] = [];
      for (const child of def.content) content.push(...buildNode(child, ctx));
      return [
        el(
          'pattern',
          [
            ['id', id],
            ['width', ctx.n(def.width)],
            ['height', ctx.n(def.height)],
            ['patternUnits', 'userSpaceOnUse'],
            // The tile geometry is authored upright and the *lattice* is rotated,
            // so a 45° hatch tiles seamlessly instead of showing a seam wherever
            // a rotated tile's corner lands (SPEC 12.6).
            ['patternTransform', def.angle === 0 ? undefined : `rotate(${ctx.n(def.angle)})`],
          ],
          content,
        ),
      ];
    }
    case 'clip':
      return [
        el('clipPath', [['id', id]], [el('path', [['d', pathData(def.path, ctx.o.precision)]])]),
      ];
    case 'symbol': {
      const inner = buildNode(def.node, ctx);
      return [el('g', [['id', id]], inner)];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The interaction overlay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flatten a readout to the label a screen reader announces for a hit region.
 *
 * The value leads and the series name follows, matching SPEC 7.5's ordering rule
 * for the visual tooltip — hover and focus must produce the *same* readout
 * (SPEC 12.4), and "same" includes which part is prominent.
 */
export function readoutLabel(region: HitRegion): string {
  return region.readout
    .map((r) => (r.label.length === 0 ? r.value : `${r.value}, ${r.label}`))
    .join('; ');
}

/**
 * The overlay `<g>` of transparent hit rects (SPEC 23.1).
 *
 * Every rect comes straight from `Scene.hitIndex`, which layout already grew to
 * the 24 × 24 minimum (SPEC 7.5, 12.5). This backend does **no hit-testing of its
 * own**: the browser hit-tests the rects, and the rects are the scene's.
 *
 * `fill="none"` with `pointer-events="all"` is the combination that makes a shape
 * hittable while painting nothing at all — not a transparent fill, which some
 * printers and PDF converters still rasterise.
 */
function buildOverlay(scene: Scene, ctx: Ctx): VNode[] {
  if (!ctx.o.interaction || scene.hitIndex.length === 0) return [];
  const rects = scene.hitIndex.map((region) =>
    el('rect', [
      ['id', ctx.id(`hit-${region.id}`)],
      ['class', ctx.o.classes ? 'mdv-hit' : undefined],
      ['x', ctx.n(region.x)],
      ['y', ctx.n(region.y)],
      ['width', ctx.n(region.w)],
      ['height', ctx.n(region.h)],
      ['fill', 'none'],
      ['pointer-events', 'all'],
      ['role', 'graphics-symbol'],
      ['aria-label', readoutLabel(region)],
      ['data-mdv-region', region.id],
      ['data-mdv-group', region.group],
      ['data-mdv-series', region.seriesId],
      ['data-mdv-datum', String(region.datumIndex)],
      ['data-mdv-mark', region.markNodeId === undefined ? undefined : ctx.id(region.markNodeId)],
    ]),
  );
  return [
    el(
      'g',
      [
        ['class', ctx.o.classes ? 'mdv-interaction' : undefined],
        ['role', 'list'],
        ['aria-label', 'Data points'],
      ],
      rects,
    ),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// The root
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve partial options against {@link DEFAULTS}. */
export function resolveOptions(
  options: Partial<BuildOptions> | undefined,
  scene: Scene,
): BuildOptions {
  return {
    precision: options?.precision ?? DEFAULTS.precision,
    classes: options?.classes ?? DEFAULTS.classes,
    interaction: options?.interaction ?? DEFAULTS.interaction,
    // Default the namespace to the block id, which is already deterministic
    // (`mdv-{blockIndex}`, SPEC 24.3 rule 7) and already unique in a document.
    idPrefix: options?.idPrefix ?? scene.meta.blockId,
  };
}

/**
 * Build the complete `<svg>` for a scene.
 *
 * The root carries `role="img"`/`"figure"` from the a11y tree, `aria-labelledby`
 * wired to a real `<title>` and `<desc>`, a `viewBox`, and
 * `preserveAspectRatio="xMidYMid meet"` (SPEC 23.1).
 */
export function buildScene(scene: Scene, options?: Partial<BuildOptions>): VNode {
  const o = resolveOptions(options, scene);
  const prefix = isSafeId(o.idPrefix) ? o.idPrefix : 'mdv';
  const ctx = new Ctx(o, prefix);

  const titleId = `${prefix}-title`;
  const descId = `${prefix}-desc`;
  const hasDesc = scene.a11y.desc !== undefined && scene.a11y.desc.length > 0;

  const defs: VNode[] = [];
  for (const def of scene.defs) defs.push(...buildDef(def, ctx));

  const background =
    scene.background === undefined
      ? []
      : [
          el('rect', [
            ['class', o.classes ? 'mdv-surface' : undefined],
            ['x', '0'],
            ['y', '0'],
            ['width', ctx.n(scene.width)],
            ['height', ctx.n(scene.height)],
            ['fill', paintAttrs(scene.background, ctx).value],
            ['fill-opacity', paintAttrs(scene.background, ctx).opacity],
            ['aria-hidden', 'true'],
          ]),
        ];

  const children: VNode[] = [
    el('title', [['id', titleId]], [], scene.a11y.name),
    ...(hasDesc ? [el('desc', [['id', descId]], [], scene.a11y.desc)] : []),
    ...(defs.length > 0 ? [el('defs', [], defs)] : []),
    ...background,
    ...buildNode(scene.root, ctx),
    ...buildOverlay(scene, ctx),
  ];

  return el(
    'svg',
    [
      ['xmlns', 'http://www.w3.org/2000/svg'],
      ['class', o.classes ? 'mdv-root mdv-chart' : undefined],
      ['width', ctx.n(scene.width)],
      ['height', ctx.n(scene.height)],
      ['viewBox', `0 0 ${ctx.n(scene.width)} ${ctx.n(scene.height)}`],
      ['preserveAspectRatio', 'xMidYMid meet'],
      ['role', scene.a11y.role],
      ['aria-labelledby', hasDesc ? `${titleId} ${descId}` : titleId],
      ['xml:lang', scene.a11y.lang],
      // One tab stop for the whole chart (SPEC 12.4); arrow keys walk
      // `a11y.focusOrder` from there.
      ['tabindex', o.interaction && scene.hitIndex.length > 0 ? '0' : undefined],
      ['data-mdv-kind', scene.meta.type],
    ],
    children,
  );
}

/** Escape helper re-exported so the emitters share one implementation. */
export { escapeXml };
