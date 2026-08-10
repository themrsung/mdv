/**
 * The pipeline seam.
 *
 * Everything outside this directory imports from here and from nowhere else in
 * `@mdv/*`. Keeping that true is what makes the in-process implementation
 * swappable for the out-of-process language server of SPEC 29.4.
 */

export { DocumentPipeline } from './pipeline.js';
export { chartRegistry, registeredTypes } from './registry.js';
export { builtinTheme, themeNameFor, type BuiltinName, type EditorKind } from './theme.js';
export type {
  BlockData,
  PipelineInputs,
  PipelineResult,
  PipelineStats,
  RenderedBlock,
} from './types.js';
