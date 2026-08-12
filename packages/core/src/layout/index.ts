/**
 * Stage 6 — layout (SPEC 18, SPEC 21): marks + size + metrics → {@link Scene}.
 *
 * **Pure** (SPEC 17.3 invariant 2). Everything the engine needs arrives on a
 * {@link LayoutContext}: no DOM, no filesystem, no network, no clock. Two runs
 * over the same input are byte-identical, which is the contract golden files,
 * PDF diffing and content-addressed caching all depend on (SPEC 24.3).
 *
 * `layoutBlock` is the entry point; everything else here is the machinery it
 * uses and is exported because `@mdv/charts` and the conformance suite need to
 * measure the same way core does.
 */

export { layoutBlock } from './block.js';
export type { LayoutContextWithRegistry } from './block.js';
export { axisRange } from './block.js';

export type { LayoutContextOptions } from './context.js';
export { makeLayoutContext, DEFAULT_BUILD_TIME } from './context.js';

export { createIdFactory, CLS } from './ids.js';

export {
  SCENE_DECIMALS,
  roundCoord,
  roundRect,
  roundCommand,
  roundNode,
  roundDef,
  roundHitRegion,
  roundScene,
} from './precision.js';

export type { TextOptions } from './text.js';
export {
  themeFont,
  solid,
  makeText,
  measureWidth,
  lineHeight,
  rotatedWidth,
  rotatedHeight,
  ellipsize,
  wrapText,
} from './text.js';

export type { DimensionBasis } from './dimension.js';
export { resolveDimension, resolvePadding, insetRect, DEFAULT_PADDING } from './dimension.js';

export type { AxisTick, AxisGeometry, AxisNodes } from './axis.js';
export {
  measureAxis,
  renderAxis,
  tickCountHint,
  tickPosition,
  axisEdge,
  outwardSign,
  TICK_LENGTH,
  TICK_LABEL_GAP,
  AXIS_TITLE_GAP,
  MIN_LABEL_GAP_X,
  MIN_LABEL_GAP_Y,
  COLLISION_ROTATION,
} from './axis.js';

export type {
  LegendGeometry,
  LegendItemGeometry,
  LegendRampBand,
  LegendRampGeometry,
  LegendRampTick,
} from './legend.js';
export {
  measureLegend,
  renderLegend,
  SWATCH_SIZE,
  SWATCH_GAP,
  ITEM_GAP,
  ROW_GAP,
  LEGEND_GAP,
  RAMP_LENGTH,
  RAMP_THICKNESS,
} from './legend.js';

export type { FrameRequest, BlockFrame } from './frame.js';
export { computeFrame, axisInsets, TITLE_GAP, CAPTION_GAP, DEFAULT_MIN_WIDTH } from './frame.js';

export type { LabelPlacement, LabelPlacementOptions } from './labels.js';
export {
  placeDirectLabels,
  labelColor,
  contains,
  overlaps,
  LABEL_PADDING,
  LABEL_OFFSET,
} from './labels.js';

export type { HitIndexOptions } from './hit.js';
export {
  buildHitIndex,
  growToMinimum,
  clampIntoBounds,
  focusOrderOf,
  hitBounds,
  MIN_HIT_SIZE,
} from './hit.js';

export type { FacetPanel, FacetPlan, FacetPlanOptions } from './facet.js';
export {
  planFacets,
  facetSubtable,
  unsharedScaleRequested,
  FACET_GAP,
  FACET_TITLE_HEIGHT,
  MAX_FACET_PANELS,
} from './facet.js';

export type { ErrorSceneOptions } from './error-card.js';
export { buildErrorScene } from './error-card.js';

export {
  buildTextureDefs,
  toneShift,
  TEXTURE_TILE,
  TEXTURE_STRIPE,
  TEXTURE_ANGLES,
} from './texture.js';

export { CORE_LAYOUT_VERSION } from './version.js';
