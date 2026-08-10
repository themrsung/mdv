/**
 * `layoutBlock` — stage 6 (SPEC 18, SPEC 21).
 *
 * ```text
 * (ResolvedBlock, Size, LayoutContext) → Scene
 * ```
 *
 * Pure, per SPEC 17.3 invariant 2: no DOM, no clock, no randomness, no host
 * locale. Two runs over the same inputs produce byte-identical scenes, which is
 * what golden files, content-addressed caching and PDF diffing all rest on.
 *
 * **It never throws for document content** (SPEC 21). A chart type that throws
 * is caught, becomes `MDV5000`, and the block renders its error card with the
 * data table — the document still renders (SPEC 14.1 principle 1).
 *
 * The division of labour is the registry contract's: core computes the frame,
 * ticks the axes, places the legend, resolves label collisions, grows the hit
 * regions to 24 px, assembles the a11y tree and emits the scene; the chart type
 * contributes marks, their hit targets, their defs and their proposed labels.
 */

import type { Diagnostic } from '@mdv/parser';
import type {
  ChartHitRegion,
  ChartType,
  ChartTypeRegistry,
  DirectLabel,
  EncodeInput,
  EncodeResult,
  PaletteAllocator,
} from '../registry.js';
import type { Column, Table } from '../types/data.js';
import type { AxisModel, LegendModel, Scale, ScaleBundle } from '../types/encode.js';
import type { LayoutContext, Rect, Size } from '../types/layout.js';
import type { ResolvedBlock } from '../types/resolved.js';
import type {
  A11yTable,
  ClipDef,
  Def,
  GroupNode,
  HitRegion,
  Scene,
  SceneNode,
} from '../types/scene.js';
import type { FacetPanel, FacetPlan } from './facet.js';
import { createDiagnostic } from '../types/diagnostics.js';
import {
  buildA11yTable,
  buildA11yTree,
  defaultTableCaption,
  generateDescription,
  needsDescriptionDiagnostic,
} from '../a11y/index.js';
import { blockReporter } from '../encode/report.js';
import { buildSeriesDescriptors, seriesIdentities } from '../encode/series.js';
import { createPaletteAllocator, slotCapForFamily } from '../encode/palette.js';
import { detectSecondAxisRequest, enforceOneAxisRule } from '../encode/axis.js';
import { buildLegendModel, normalizeLegendAttr } from '../encode/legend.js';
import { rerangeScale } from '../scale/rerange.js';
import { measureAxis, renderAxis, type AxisGeometry } from './axis.js';
import { computeFrame } from './frame.js';
import { buildErrorScene } from './error-card.js';
import { facetSubtable, planFacets, FACET_TITLE_HEIGHT } from './facet.js';
import { buildHitIndex } from './hit.js';
import { CLS } from './ids.js';
import { placeDirectLabels } from './labels.js';
import { renderLegend } from './legend.js';
import { roundScene } from './precision.js';
import { ellipsize, lineHeight, makeText, solid, themeFont } from './text.js';
import { buildTextureDefs } from './texture.js';
import { CORE_LAYOUT_VERSION } from './version.js';

/**
 * How much a mark may bleed past the plot frame before it is clipped.
 *
 * An end dot sits *on* the domain maximum and carries a 2 px surface ring
 * (SPEC 11.4); clipping exactly at the frame would shave both. The bleed is a
 * little over the marker diameter, which is the largest thing a mark
 * legitimately hangs over the edge.
 */
const CLIP_BLEED = 12;

/** Scale types that carry a positional range and may be re-ranged. */
const POSITIONAL = new Set(['linear', 'log', 'sqrt', 'pow', 'symlog', 'time', 'band', 'point']);

/**
 * Layout may be given a registry either as an argument or on the context.
 *
 * CONTRACT: `packages/core/src/types/layout.ts`, `LayoutContext` — SPEC 21's
 * `layoutBlock(block, size, ctx)` has nowhere to name the chart type, and there
 * is no global registry (SPEC 17.3 invariant 4 forbids one). Adding
 * `registry?: ChartTypeRegistry` to `LayoutContext` would remove this shim.
 */
export type LayoutContextWithRegistry = LayoutContext & { registry?: ChartTypeRegistry };

/**
 * Lay one block out into a {@link Scene}.
 *
 * @param block - a block from a resolved document
 * @param size - the outer box in CSS pixels. A zero dimension is `MDV5001`.
 * @param ctx - theme, metrics, locale, level, ids, diagnostic sink
 * @param registry - the chart types in force. May also be supplied as
 * `ctx.registry`; an unknown type renders as a table (`MDV1500`).
 */
export function layoutBlock(
  block: ResolvedBlock,
  size: Size,
  ctx: LayoutContext,
  registry?: ChartTypeRegistry,
): Scene {
  const reporter = blockReporter(block, (d) => ctx.diagnostic(d), 'render');
  const resolved = registry ?? (ctx as LayoutContextWithRegistry).registry;

  const presentation = tablePresentation(block);
  if (presentation === 'none') {
    reporter.emit('MDV3090', {
      message: '`table: none` — this block’s data is not reachable as a table',
      detail:
        'Permitted only when the same data appears in a visible table elsewhere in the ' +
        'document (SPEC 12.3).',
    });
  }

  const fallbackTable = buildA11yTable({
    table: block.table,
    caption: defaultTableCaption(stringAttr(block, 'title'), block.blockType),
    presentation,
    locale: ctx.locale,
    timezone: ctx.timezone,
  });

  // ── Degenerate container ────────────────────────────────────────────────────
  if (!(size.width > 0) || !(size.height > 0)) {
    reporter.emit('MDV5001', {
      message: `Container is ${size.width} × ${size.height}; nothing can be drawn`,
      detail: 'Give the block a width and a height, or wait for the container to be measured.',
    });
    return emptyScene(block, size, ctx, fallbackTable);
  }

  // ── A block that already failed upstream ────────────────────────────────────
  const upstreamErrors = block.diagnostics.filter((d) => d.severity === 'error');
  if (block.failed || upstreamErrors.length > 0) {
    return errorScene(block, size, ctx, upstreamErrors, fallbackTable);
  }

  // ── The chart type ──────────────────────────────────────────────────────────
  const type = resolved?.get(block.blockType);
  if (type === undefined) {
    const unknown = createDiagnostic('MDV1500', {
      range: block.range,
      source: 'render',
      blockId: block.id,
      message: `Unknown block type \`${block.blockType}\` — rendered as a table`,
      detail:
        resolved === undefined
          ? 'No chart-type registry was supplied to layoutBlock.'
          : `Known types: ${resolved
              .list()
              .map((t) => t.name)
              .join(', ')}.`,
    });
    ctx.diagnostic(unknown);
    return errorScene(block, size, ctx, [unknown], {
      ...fallbackTable,
      presentation: presentation === 'none' ? 'visible' : presentation,
    });
  }

  // ── Semantic validation (stage 3) ───────────────────────────────────────────
  const validation = safely(() => type.validate(block, block.table), []);
  for (const diagnostic of validation) ctx.diagnostic(diagnostic);
  const validationErrors = validation.filter((d) => d.severity === 'error');
  if (validationErrors.length > 0) {
    return errorScene(block, size, ctx, validationErrors, fallbackTable);
  }

  detectSecondAxisRequest(block.attrs, reporter);
  const faceted = block.attrs.row !== undefined || block.attrs.column !== undefined;
  if (faceted && (block.attrs.shareY === false || block.attrs.shareX === false)) {
    reporter.emit('MDV3030', {
      message: 'Facet panels do not share a scale — they are not comparable',
      detail:
        'A shared scale is what makes small multiples comparable (SPEC 7.6). If the panels ' +
        'measure different quantities, say so in the caption.',
    });
  }

  // ── Encode (stage 5) ────────────────────────────────────────────────────────
  const encodeOutcome = runEncode(type, block, ctx);
  if (encodeOutcome.kind === 'failed') {
    ctx.diagnostic(encodeOutcome.diagnostic);
    return errorScene(block, size, ctx, [encodeOutcome.diagnostic], fallbackTable);
  }
  const encoded = encodeOutcome.result;

  // ── Axes and legend, core's to police ───────────────────────────────────────
  const axes = enforceOneAxisRule(encoded.axes, reporter);
  const legend = resolveLegend(encoded, block, type);

  // ── Frame ───────────────────────────────────────────────────────────────────
  const frame = computeFrame({
    size,
    attrs: block.attrs,
    axes,
    legend,
    reserved: encoded.reserved,
    minWidth: type.minWidth,
    rerange: rerangeAxis,
    ctx,
    reporter,
  });

  if (frame.plot.width <= 0 || frame.plot.height <= 0) {
    reporter.emit('MDV5001', {
      message: 'No room left for the plot after titles, legend and axes',
      detail: 'Increase the block height, or remove the legend or the axis titles.',
    });
  }

  // ── Re-range the bundle onto the frame ──────────────────────────────────────
  //
  // The spread is load-bearing and must stay one. `ChartType.layout` is
  // documented as receiving "this type's own `encode` output", and every real
  // chart type relies on that to get its resolved attributes across the seam
  // through `EncodeResult.state` (registry.ts). Rebuilding this as an explicit
  // object literal of the fields core happens to care about would drop `state`,
  // `a11yTable`, `boundColumns`, `droppedRows` and `reserved` — and every chart
  // would silently fall back to its defaults, with no type error and no
  // diagnostic. Only `scales` and `axes` are core's to replace.
  const blockAxes = frame.axes.map((geometry) => geometry.model);
  const scales = rerangeBundle(encoded.scales, encoded.axes, blockAxes, frame.plot);
  const forLayout: EncodeResult = { ...encoded, scales, axes: blockAxes };

  // ── Faceting (SPEC 7.6) ─────────────────────────────────────────────────────
  const plan = faceted
    ? planFacets({ attrs: block.attrs, table: block.table, area: frame.plot })
    : undefined;

  const marks: SceneNode[] = [];
  const rawHits: ChartHitRegion[] = [];
  const proposedLabels: DirectLabel[] = [];
  const defs: Def[] = [...encodeOutcome.textureDefs];
  const grid: SceneNode[] = [];
  const axisNodes: SceneNode[] = [];
  const geometries: AxisGeometry[] = [];

  if (plan === undefined || plan.panels.length <= 1) {
    const outcome = runChartLayout(type, forLayout, frame.plot, ctx, block);
    if (outcome.kind === 'failed') {
      ctx.diagnostic(outcome.diagnostic);
      return errorScene(block, size, ctx, [outcome.diagnostic], fallbackTable);
    }
    marks.push(...outcome.nodes);
    rawHits.push(...outcome.hits);
    proposedLabels.push(...outcome.labels);
    defs.push(...outcome.defs);
    for (const diagnostic of outcome.diagnostics) ctx.diagnostic(diagnostic);

    for (const geometry of frame.axes) {
      geometries.push(geometry);
      const rendered = renderAxis(geometry, frame.plot, ctx);
      grid.push(...rendered.grid);
      axisNodes.push(...rendered.axis);
    }
  } else {
    for (const panel of plan.panels) {
      const panelPlot = panel.body;
      const panelEncoded = encodeForPanel(type, forLayout, block, panel, ctx, plan);
      if (panelEncoded !== undefined) {
        const panelScales = rerangeBundleToRect(panelEncoded.scales, blockAxes, panelPlot);
        const outcome = runChartLayout(
          type,
          { ...panelEncoded, scales: panelScales, axes: [] },
          panelPlot,
          ctx,
          block,
        );
        if (outcome.kind === 'failed') {
          ctx.diagnostic(outcome.diagnostic);
          return errorScene(block, size, ctx, [outcome.diagnostic], fallbackTable);
        }
        marks.push(...outcome.nodes);
        rawHits.push(...outcome.hits);
        proposedLabels.push(...outcome.labels);
        defs.push(...outcome.defs);
        for (const diagnostic of outcome.diagnostics) ctx.diagnostic(diagnostic);
      }

      // Axes on the outer panels only: an identical ladder in every cell is ink
      // that is not data (SPEC 11.4).
      for (const model of blockAxes) {
        const vertical = model.position === 'left' || model.position === 'right';
        if (vertical && !panel.showValueAxis) continue;
        if (!vertical && !panel.showCategoryAxis) continue;
        const panelModel = rerangeAxis(model, panelPlot);
        const geometry = measureAxis(
          panelModel,
          vertical ? panelPlot.height : panelPlot.width,
          vertical ? size.width : size.height,
          ctx,
        );
        geometries.push(geometry);
        const rendered = renderAxis(geometry, panelPlot, ctx);
        grid.push(...rendered.grid);
        axisNodes.push(...rendered.axis);
      }

      if (panel.title !== '') {
        const font = themeFont(ctx.theme, 'caption');
        axisNodes.push(
          makeText(
            {
              x: panel.rect.x,
              y: panel.rect.y + FACET_TITLE_HEIGHT - lineHeight(font, ctx.metrics) / 2,
              text: ellipsize(panel.title, font, ctx.metrics, panel.rect.width),
              font: { ...font, weight: 600 },
              fill: solid(ctx.theme.tokens['text-secondary']),
              anchor: 'start',
              baseline: 'middle',
              cls: CLS.facetTitle,
              id: ctx.ids.next('facet'),
            },
            ctx.metrics,
          ),
        );
      }
    }
  }

  for (const geometry of geometries) {
    if (geometry.dropped > 0 || (!geometry.showLabels && geometry.ticks.length > 0)) {
      reporter.emit('MDV5011', {
        message: `${geometry.dropped} ${geometry.model.position}-axis label${
          geometry.dropped === 1 ? '' : 's'
        } omitted to avoid collision`,
        detail:
          'A label that will not fit is omitted, never clipped. Every value is in the table view.',
      });
    }
  }

  const hits = buildHitIndex(rawHits, {
    ids: ctx.ids,
    bounds: { x: 0, y: 0, width: size.width, height: size.height },
  });

  // ── Legend ──────────────────────────────────────────────────────────────────
  const legendNodes =
    frame.legend !== undefined && frame.legendBox !== undefined
      ? renderLegend(frame.legend, frame.legendBox, ctx)
      : [];
  if (frame.legend !== undefined && frame.legend.folded > 0) {
    reporter.emit('MDV3062', {
      message: `${frame.legend.folded} series folded into “Other”`,
      detail:
        'The palette has a fixed number of slots and is never cycled (SPEC 11.2 rule 2). ' +
        'Facet into small multiples, or aggregate the tail before plotting.',
    });
  }

  // ── Direct labels ───────────────────────────────────────────────────────────
  const labelPlacement = placeDirectLabels(proposedLabels, ctx, {
    bounds: frame.content,
    occupied: frame.legendBox === undefined ? [] : [frame.legendBox],
  });
  if (labelPlacement.dropped > 0) {
    reporter.emit('MDV5011', {
      message: `${labelPlacement.dropped} direct label${
        labelPlacement.dropped === 1 ? '' : 's'
      } omitted to avoid collision`,
      detail:
        'A label that will not fit is omitted, never clipped (SPEC 11.5). See the table view.',
    });
  }

  // ── Assemble ────────────────────────────────────────────────────────────────
  const clipId = ctx.ids.next('clip');
  defs.push(plotClip(clipId, frame.plot));

  const children: SceneNode[] = [
    {
      kind: 'rect',
      x: 0,
      y: 0,
      w: size.width,
      h: size.height,
      fill: solid(ctx.theme.tokens.surface),
      cls: CLS.surface,
    },
  ];
  if (grid.length > 0) {
    children.push({ kind: 'group', cls: CLS.grid, id: ctx.ids.next('grid'), children: grid });
  }
  children.push({
    kind: 'group',
    cls: CLS.marks,
    id: ctx.ids.next('marks'),
    clip: clipId,
    role: 'graphics-object',
    children: marks,
  });
  if (axisNodes.length > 0) {
    children.push({ kind: 'group', cls: CLS.axis, id: ctx.ids.next('axis'), children: axisNodes });
  }
  children.push(...legendNodes);
  children.push(...frame.chrome);
  if (labelPlacement.nodes.length > 0) {
    children.push({
      kind: 'group',
      cls: CLS.label,
      id: ctx.ids.next('labels'),
      children: labelPlacement.nodes,
    });
  }

  // ── Accessibility (SPEC 12) ─────────────────────────────────────────────────
  const a11yTable =
    encoded.a11yTable ??
    buildA11yTable({
      table: block.table,
      columns: boundColumns(block.table, encoded),
      caption: defaultTableCaption(stringAttr(block, 'title'), block.blockType),
      presentation,
      locale: ctx.locale,
      timezone: ctx.timezone,
    });

  const authored = stringAttr(block, 'desc');
  const generated =
    authored === undefined && ctx.a11y.generateDesc
      ? describeSafely(type, block, encoded, ctx)
      : undefined;

  const tree = buildA11yTree({
    title: stringAttr(block, 'title'),
    desc: authored,
    generated,
    caption: stringAttr(block, 'caption'),
    table: a11yTable,
    hits,
    fallbackName: `${block.blockType} chart`,
  });
  if (needsDescriptionDiagnostic(tree)) {
    reporter.emit('MDV3091', {
      message: 'No accessible description, and none could be generated',
      detail: 'Add `desc:` to the block (SPEC 12.2).',
    });
  }

  const root: GroupNode = {
    kind: 'group',
    cls: CLS.root,
    id: ctx.ids.next('root'),
    role: tree.role === 'figure' ? 'figure' : 'img',
    label: tree.name,
    children,
  };

  return roundScene({
    width: size.width,
    height: size.height,
    background: solid(ctx.theme.tokens.page),
    defs,
    root,
    a11y: tree,
    hitIndex: hits,
    meta: {
      blockId: block.id,
      type: block.blockType,
      theme: ctx.theme.name,
      version: CORE_LAYOUT_VERSION,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Encode
// ─────────────────────────────────────────────────────────────────────────────

type EncodeOutcome =
  | { kind: 'ok'; result: EncodeResult; textureDefs: Def[] }
  | { kind: 'failed'; diagnostic: Diagnostic };

/** Run a chart type's `encode`, catching a throw as `MDV5000`. */
function runEncode(type: ChartType, block: ResolvedBlock, ctx: LayoutContext): EncodeOutcome {
  const valueChannel = type.channels.some((channel) => channel.name === 'y')
    ? 'y'
    : type.channels.some((channel) => channel.name === 'value')
      ? 'value'
      : 'x';
  const identities = seriesIdentities(block.table, block.encoding, valueChannel);

  const legendRequest = normalizeLegendAttr(block.attrs.legend);
  const colors = paletteColors(block, ctx);

  const texture = ctx.a11y.texture
    ? buildTextureDefs(colors, ctx.theme.tokens['text-primary'], ctx.ids)
    : { defs: [] as Def[], idsBySlot: [] as string[] };

  const allocated = createPaletteAllocator({
    identities: identities.map((identity) => identity.id),
    colors,
    cap: slotCapForFamily(type.family),
    maxItems: legendRequest.maxItems,
    otherColor: ctx.theme.tokens['text-muted'],
    ...(texture.idsBySlot.length > 0 ? { patternDefs: texture.idsBySlot } : {}),
  });

  const input: EncodeInput = {
    block,
    table: block.table,
    encoding: block.encoding,
    attrs: block.attrs,
    theme: ctx.theme,
    level: ctx.level,
    palette: allocated.allocator,
    locale: ctx.locale,
    timezone: ctx.timezone,
    buildTime: ctx.buildTime,
    diagnostic: (d) => ctx.diagnostic(d),
  };

  try {
    const result = type.encode(input);
    // A type that returned no series still needs descriptors for the legend and
    // the a11y tree; derive them from the identities core already resolved.
    const series =
      result.series.length > 0
        ? result.series
        : buildSeriesDescriptors({ identities, palette: allocated.allocator }).series;
    return { kind: 'ok', result: { ...result, series }, textureDefs: texture.defs };
  } catch (error) {
    return {
      kind: 'failed',
      diagnostic: renderFailure(block, `encode threw: ${describeError(error)}`),
    };
  }
}

/** The categorical palette in force: the block's `palette:`, else the theme's. */
function paletteColors(block: ResolvedBlock, ctx: LayoutContext): string[] {
  const attr = block.attrs.palette;
  if (Array.isArray(attr) && attr.length > 0) return attr.map((color) => String(color));
  return [...ctx.theme.categorical];
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart layout
// ─────────────────────────────────────────────────────────────────────────────

type ChartOutcome =
  | {
      kind: 'ok';
      nodes: SceneNode[];
      hits: ChartHitRegion[];
      defs: Def[];
      labels: DirectLabel[];
      diagnostics: Diagnostic[];
    }
  | { kind: 'failed'; diagnostic: Diagnostic };

/** Call the chart type's `layout`, catching a throw as `MDV5000`. */
function runChartLayout(
  type: ChartType,
  encoded: EncodeResult,
  plot: Rect,
  ctx: LayoutContext,
  block: ResolvedBlock,
): ChartOutcome {
  try {
    const result = type.layout(encoded, plot, ctx);
    return {
      kind: 'ok',
      nodes: [...result.nodes],
      hits: [...result.hits],
      defs: [...(result.defs ?? [])],
      labels: [...(result.labels ?? [])],
      diagnostics: [...(result.diagnostics ?? [])],
    };
  } catch (error) {
    return {
      kind: 'failed',
      diagnostic: renderFailure(block, `layout threw: ${describeError(error)}`),
    };
  }
}

/**
 * Re-encode one panel's rows, keeping the block's shared scales.
 *
 * Each panel re-encodes its *own rows* so the marks are right, but the scales it
 * is handed are the whole block's. That is what `shareX`/`shareY` mean, and
 * doing it here rather than in every chart type is what makes it uniform.
 *
 * The palette allocator is the **block's** assignment replayed, never a fresh
 * one: a series must keep its colour across panels (SPEC 11.2 rule 1).
 */
function encodeForPanel(
  type: ChartType,
  encoded: EncodeResult,
  block: ResolvedBlock,
  panel: FacetPanel,
  ctx: LayoutContext,
  plan: FacetPlan,
): EncodeResult | undefined {
  const table = facetSubtable(block.table, panel.rowIndices);
  const bySeries = new Map(encoded.series.map((series) => [series.id, series]));
  const allocator: PaletteAllocator = {
    size: encoded.series.length,
    slot: (id) => bySeries.get(id)?.slot ?? -1,
    color: (id) => bySeries.get(id)?.color ?? ctx.theme.tokens['text-muted'],
    isOverflow: (id) => !bySeries.has(id),
    patternDef: (id) => bySeries.get(id)?.patternDef,
  };
  try {
    const result = type.encode({
      block,
      table,
      encoding: block.encoding,
      attrs: block.attrs,
      theme: ctx.theme,
      level: ctx.level,
      palette: allocator,
      locale: ctx.locale,
      timezone: ctx.timezone,
      buildTime: ctx.buildTime,
      // Already reported for the block as a whole; repeating per panel would
      // multiply one problem by the panel count.
      diagnostic: () => undefined,
    });
    const scales: ScaleBundle = { ...result.scales };
    if (plan.shareX && encoded.scales.x !== undefined) scales.x = encoded.scales.x;
    if (plan.shareY && encoded.scales.y !== undefined) scales.y = encoded.scales.y;
    return { ...result, scales, series: encoded.series };
  } catch {
    // One unencodable panel must not take the block down; the others still draw.
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale re-ranging
// ─────────────────────────────────────────────────────────────────────────────

/** The range an axis's scale takes on a plot rectangle. */
export function axisRange(position: AxisModel['position'], plot: Rect): [number, number] {
  if (position === 'top' || position === 'bottom') return [plot.x, plot.x + plot.width];
  // y grows downward in scene space and upward in value space, so the range is
  // inverted. A chart that wants otherwise sets `scale: {reverse: true}`.
  return [plot.y + plot.height, plot.y];
}

/** An axis model whose scale has been re-ranged onto `plot`. */
function rerangeAxis(model: AxisModel, plot: Rect): AxisModel {
  if (!POSITIONAL.has(model.scale.type)) return model;
  const scaled = rerangeScale(model.scale, axisRange(model.position, plot));
  return scaled === model.scale ? model : { ...model, scale: scaled };
}

/**
 * Replace every positional scale in the bundle with its re-ranged twin.
 *
 * Scales an axis already re-ranged are matched **by identity** to the model the
 * chart type handed over, so a chart that put the same instance on `scales.y`
 * and on its axis gets one instance back, not two — which is exactly what keeps
 * a bar edge and its gridline on the same pixel.
 */
function rerangeBundle(
  bundle: ScaleBundle,
  originalAxes: readonly AxisModel[],
  finalAxes: readonly AxisModel[],
  plot: Rect,
): ScaleBundle {
  const replacement = new Map<Scale, Scale>();
  for (const before of originalAxes) {
    const after = finalAxes.find((axis) => axis.channel === before.channel);
    if (after === undefined) continue;
    replacement.set(before.scale, after.scale);
  }

  const out: Record<string, Scale | undefined> = { ...bundle };
  for (const [key, scale] of Object.entries(out)) {
    if (scale === undefined) continue;
    const swapped = replacement.get(scale);
    if (swapped !== undefined) {
      out[key] = swapped;
      continue;
    }
    if (!POSITIONAL.has(scale.type)) continue;
    if (key === 'x') out[key] = rerangeScale(scale, axisRange('bottom', plot));
    else if (key === 'y') out[key] = rerangeScale(scale, axisRange('left', plot));
  }
  return out as ScaleBundle;
}

/** Re-range a whole bundle onto a rectangle, for a facet panel. */
function rerangeBundleToRect(
  bundle: ScaleBundle,
  axes: readonly AxisModel[],
  rect: Rect,
): ScaleBundle {
  const out: Record<string, Scale | undefined> = { ...bundle };
  for (const [key, scale] of Object.entries(out)) {
    if (scale === undefined || !POSITIONAL.has(scale.type)) continue;
    const axis = axes.find((candidate) => candidate.channel === key);
    const position = axis?.position ?? (key === 'x' ? 'bottom' : 'left');
    out[key] = rerangeScale(scale, axisRange(position, rect));
  }
  return out as ScaleBundle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile the chart type's legend with the author's `legend:`.
 *
 * The type proposes; the author disposes; core places. `legend: false` removes
 * it outright, and an explicit position is honoured even where the type declined
 * to offer one — asking for a legend on a single-series chart is a decision, not
 * an oversight.
 */
function resolveLegend(
  encoded: EncodeResult,
  block: ResolvedBlock,
  type: ChartType,
): LegendModel | undefined {
  const request = normalizeLegendAttr(block.attrs.legend);
  if (request.position === false) return undefined;

  const base =
    encoded.legend ??
    (request.position === 'auto'
      ? undefined
      : buildLegendModel({ series: encoded.series, request, family: type.family }));
  if (base === undefined) return undefined;

  const out: LegendModel = { ...base };
  if (request.position !== 'auto') out.position = request.position;
  if (request.title !== undefined) out.title = request.title;
  if (request.orient !== undefined) out.orient = request.orient;
  if (request.columns !== undefined) out.columns = request.columns;
  out.maxItems = request.maxItems;
  return out;
}

/**
 * The columns the table view should project: the ones the encoding bound.
 *
 * Three tiers, best first:
 *
 * 1. `encoded.boundColumns` — the type said so. Believe it.
 * 2. `series[].source` — an inference, and a weak one. `SeriesDescriptor.source`
 *    is documented as "source field name in wide form; the `series` field value
 *    in long form", so in long form it may not name a column at all, and in wide
 *    form it names only the *value* columns — never the category column the
 *    reader needs to know which row is which.
 * 3. The whole table.
 *
 * Tier 2 exists only for chart types that supply neither `boundColumns` nor
 * their own `a11yTable`. Every built-in supplies an `a11yTable`, so in practice
 * this runs for plugin types.
 */
function boundColumns(table: Table, encoded: EncodeResult): Column[] {
  const declared = encoded.boundColumns;
  if (declared !== undefined && declared.length > 0) return [...declared];

  const wanted = new Set<string>();
  for (const series of encoded.series) wanted.add(series.source);
  const out: Column[] = [];
  for (const field of table.fields) if (wanted.has(field.name)) out.push(field);
  // A single-series chart binds one column, and a one-column table view is not
  // reachable data — fall back to everything.
  return out.length > 1 ? out : [...table.fields];
}

/** A clip path for the plot, with a bleed so end markers survive. */
function plotClip(id: string, plot: Rect): ClipDef {
  const x = plot.x - CLIP_BLEED;
  const y = plot.y - CLIP_BLEED;
  const w = plot.width + CLIP_BLEED * 2;
  const h = plot.height + CLIP_BLEED * 2;
  return {
    kind: 'clip',
    id,
    path: [
      { c: 'M', x, y },
      { c: 'L', x: x + w, y },
      { c: 'L', x: x + w, y: y + h },
      { c: 'L', x, y: y + h },
      { c: 'Z' },
    ],
  };
}

/** `describe()` from the chart type, else the generic generator (SPEC 12.2). */
function describeSafely(
  type: ChartType,
  block: ResolvedBlock,
  encoded: EncodeResult,
  ctx: LayoutContext,
): string | undefined {
  if (type.describe !== undefined) {
    const own = safely(
      () =>
        type.describe?.({
          block,
          table: block.table,
          encoded,
          locale: ctx.locale,
          timezone: ctx.timezone,
        }) ?? '',
      '',
    );
    if (own !== '') return own;
  }
  const xAxis = encoded.axes.find((axis) => axis.channel === 'x');
  const yAxis = encoded.axes.find((axis) => axis.channel === 'y');
  const generated = generateDescription({
    blockType: block.blockType,
    marks: encoded.marks,
    series: encoded.series,
    ...(typeof yAxis?.title === 'string' ? { valueTitle: yAxis.title } : {}),
    ...(typeof xAxis?.title === 'string' ? { keyTitle: xAxis.title } : {}),
    ...(yAxis?.format !== undefined ? { valueFormat: yAxis.format } : {}),
    ...(xAxis?.format !== undefined ? { keyFormat: xAxis.format } : {}),
    locale: ctx.locale,
    timezone: ctx.timezone,
  });
  return generated === '' ? undefined : generated;
}

/** `table:` from the block, defaulting to `details` (SPEC 8.1). */
function tablePresentation(block: ResolvedBlock): A11yTable['presentation'] {
  const value = block.attrs.table;
  return value === 'visible' || value === 'hidden' || value === 'none' ? value : 'details';
}

/** A string attribute, or `undefined` when absent or empty. */
function stringAttr(
  block: ResolvedBlock,
  key: 'title' | 'subtitle' | 'caption' | 'desc',
): string | undefined {
  const value = block.attrs[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Run a chart-type callback, substituting a fallback if it throws. */
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/** `MDV5000` for a chart type that threw. */
function renderFailure(block: ResolvedBlock, message: string): Diagnostic {
  return createDiagnostic('MDV5000', {
    range: block.range,
    source: 'render',
    blockId: block.id,
    message: `Chart type \`${block.blockType}\` failed: ${message}`,
    detail:
      'A chart type must report through `diagnostic()` rather than throwing (see the ' +
      'registry contract). The block renders its error card and the document continues.',
  });
}

/** A message from an unknown thrown value, without leaking a stack. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The scene for a block that cannot draw. */
function errorScene(
  block: ResolvedBlock,
  size: Size,
  ctx: LayoutContext,
  diagnostics: readonly Diagnostic[],
  table: A11yTable,
): Scene {
  const scene = buildErrorScene({
    size,
    blockId: block.id,
    blockType: block.blockType,
    diagnostics,
    table,
    ctx,
    ...(stringAttr(block, 'title') !== undefined
      ? { title: stringAttr(block, 'title') as string }
      : {}),
  });
  return { ...scene, meta: { ...scene.meta, version: CORE_LAYOUT_VERSION } };
}

/** A structurally valid scene for a zero-size container. */
function emptyScene(block: ResolvedBlock, size: Size, ctx: LayoutContext, table: A11yTable): Scene {
  const hits: HitRegion[] = [];
  return roundScene({
    width: Math.max(0, size.width),
    height: Math.max(0, size.height),
    defs: [],
    root: {
      kind: 'group',
      cls: CLS.root,
      id: ctx.ids.next('root'),
      role: 'img',
      label: `${block.blockType} chart`,
      children: [],
    },
    a11y: {
      role: 'img',
      name: stringAttr(block, 'title') ?? `${block.blockType} chart`,
      descGenerated: false,
      table,
      focusOrder: [],
    },
    hitIndex: hits,
    meta: {
      blockId: block.id,
      type: block.blockType,
      theme: ctx.theme.name,
      version: CORE_LAYOUT_VERSION,
    },
  });
}
