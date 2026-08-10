/**
 * Scales, domains, ticks and formatting (SPEC 7.2, 7.3).
 *
 * Scales are **built in stage 5 and read in stage 6**: the axis generator, the
 * gridline generator and a chart type's own mark geometry all call the same
 * frozen instance, which is what keeps a tick and a bar edge on the same pixel
 * (see the registry contract).
 */

export {
  tickIncrement,
  tickStep,
  ticks,
  niceDomain,
  tickPrecision,
  padDegenerate,
} from './ticks.js';

export type { NumberConventions, NumberFormatSpec, CivilTime, FormatContext } from './format.js';
export {
  numberConventions,
  parseNumberFormat,
  formatNumberSpec,
  formatNumber,
  tickNumberFormatter,
  DEFAULT_NUMBER_SPEC,
  zoneOffsetMinutes,
  toCivil,
  fromCivil,
  formatDate,
  isDatePattern,
  formatValue,
} from './format.js';

export type { TimeInterval } from './time-ticks.js';
export {
  TIME_LADDER,
  chooseInterval,
  floorTime,
  stepTime,
  timeTicks,
  niceTimeDomain,
  defaultTimeFormat,
} from './time-ticks.js';

export type { ContinuousScaleOptions, DomainOptions } from './continuous.js';
export { createContinuousScale, computeContinuousDomain, logTicks } from './continuous.js';

export type { TimeScaleOptions } from './time.js';
export { createTimeScale, computeTimeDomain } from './time.js';

export type { BandGeometry, BandGeometryRequest, BandScaleOptions } from './band.js';
export { bandCenter, bandGeometry, createBandScale } from './band.js';

export type { OrdinalScaleOptions } from './ordinal.js';
export { createOrdinalScale, distinctInOrder } from './ordinal.js';

export type {
  Rgba,
  SequentialScaleOptions,
  DivergingScaleOptions,
  QuantizeScaleOptions,
  QuantileScaleOptions,
  ThresholdScaleOptions,
} from './color.js';
export {
  parseColor,
  toHex,
  mixColors,
  relativeLuminance,
  sampleRamp,
  createSequentialScale,
  createDivergingScale,
  createQuantizeScale,
  createQuantileScale,
  createThresholdScale,
  quantileSorted,
} from './color.js';

export type { PositionalScaleRequest } from './build.js';
export { buildPositionalScale, defaultScaleType, asBundleScale } from './build.js';

export type { Rerangeable } from './rerange.js';
export { attachRerange, isRerangeable, rerangeScale } from './rerange.js';
