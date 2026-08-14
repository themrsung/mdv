/**
 * Stage 5 — encode (SPEC 18): table + encoding → marks.
 *
 * This directory holds the parts every chart type needs and none of them should
 * re-invent: channel resolution, wide/long normalisation, series identity,
 * deterministic palette slots, axis and legend models, and readout construction.
 * A chart type supplies the geometry-free mark data; everything above is shared
 * so that two types with the same encoding produce the same axes, the same
 * legend order and the same colours.
 */

export type { Reporter, ReportOptions } from './report.js';
export { createReporter, blockReporter, attrRange } from './report.js';

export {
  columnIndex,
  column,
  columnValues,
  cell,
  asScaleInput,
  identityKey,
  asNumber,
  humanise,
  columnTitle,
  isDiscreteType,
  isTemporalType,
  isQuantitativeType,
} from './table-access.js';

export type { EncodingForm } from './normalize.js';
export {
  channelList,
  firstChannel,
  channelField,
  isWideForm,
  hasFormConflict,
  encodingForm,
  normalizeEncoding,
  channelTitle,
  tooltipFields,
} from './normalize.js';

export type { ChannelBinding, ChannelResolution } from './channels.js';
export { resolveChannels, binding, bindings, axisTitleFor } from './channels.js';

export type { PaletteAllocatorOptions, AllocatedPalette } from './palette.js';
export { createPaletteAllocator, slotCapForFamily } from './palette.js';

export type { SeriesIdentity, SeriesDescriptorOptions } from './series.js';
export {
  identitiesFromSeriesColumn,
  identitiesFromFields,
  identitiesFromColumns,
  seriesIdentities,
  buildSeriesDescriptors,
  findSeries,
  resolveSeries,
  OTHER_SERIES_ID,
} from './series.js';

export type { AxisDimension, AxisRequest } from './axis.js';
export {
  axisDimension,
  defaultAxisPosition,
  buildAxisModel,
  detectSecondAxisRequest,
  enforceOneAxisRule,
  isDualAxis,
  oneAxisDiagnostics,
} from './axis.js';

export type { LegendRequest, LegendModelOptions } from './legend.js';
export {
  normalizeLegendAttr,
  symbolForFamily,
  buildLegendModel,
  foldLegendEntries,
  DEFAULT_LEGEND_MAX_ITEMS,
  LEGEND_TOP_SERIES_LIMIT,
} from './legend.js';

export type { TooltipRequest, ReadoutInput, ReadoutContext, ReadoutOptions } from './readout.js';
export {
  normalizeTooltipAttr,
  buildReadoutRow,
  buildReadout,
  buildCrosshairReadout,
} from './readout.js';
