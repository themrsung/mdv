/**
 * `@mdv/react` — React components and hooks (SPEC 22).
 *
 * React 18+, function components, **`StrictMode`-clean**: every effect is
 * idempotent and no work happens in render. The DOM is React-owned — charts come
 * through `@mdv/render-svg`'s `toReactElements` path and reconcile normally.
 *
 * ```tsx
 * <MdvProvider theme="auto" config={{ security: { allowExternal: false } }}>
 *   <MdvDocument source={markdown} onDiagnostics={setDiagnostics} />
 * </MdvProvider>
 * ```
 *
 * ### What is where
 *
 * | Concern | Module |
 * |---|---|
 * | provider, theme context, colour-scheme following | `context.tsx` |
 * | document walk, Markdown → JSX, block substitution | `document.tsx`, `markdown.tsx` |
 * | one block: measure, virtualise, lay out, contain | `blockview.tsx` |
 * | scene → JSX and the SPEC 12.4 interaction layer | `chart.tsx` |
 * | the SPEC 12.3 table view | `tableview.tsx` |
 * | the SPEC 14 error card and the per-block boundary | `errorcard.tsx` |
 * | the content-hash memos of SPEC 24.2 | `internal/pipeline.ts` |
 *
 * ### Server rendering
 *
 * `renderToString` works with no DOM: with no `src:` in the document the whole
 * path is synchronous — `parse`, the composed resolve, `layoutBlock` and
 * `toReactElements` — and measurement is the deterministic `TableMetrics`, so
 * the server and the browser lay out identically and hydration attaches
 * interaction only (SPEC 22.3). Pass `renderPolicy="eager"` for printing.
 *
 * **`React` is a peer dependency**, and this package never imports `react-dom`:
 * the host owns rendering, so the same build serves the browser, `renderToString`
 * and React Native's renderer.
 */

// ── Components (SPEC 22.1) ───────────────────────────────────────────────────
export { MdvProvider, useMdvRuntime, useMdvTheme, usePrefersDark } from './context.js';
export type { MdvProviderProps, MdvRuntime } from './context.js';

export { MdvDocument } from './document.js';
export type { MdvDocumentProps } from './document.js';

export { MdvBlock } from './block.js';
export type { MdvBlockProps } from './block.js';

export { MdvBlockView } from './blockview.js';
export type { MdvBlockViewProps } from './blockview.js';

export { MdvChart } from './chart.js';
export type { MdvChartProps } from './chart.js';

export { MdvTableView } from './tableview.js';
export type { MdvTableViewProps } from './tableview.js';

export { MdvErrorBoundary, MdvErrorCard, diagnosticFromError } from './errorcard.js';
export type { MdvErrorBoundaryProps, MdvErrorCardProps } from './errorcard.js';

// ── Hooks (SPEC 22.2) ────────────────────────────────────────────────────────
export { useMdv } from './hooks/useMdv.js';
export type { MdvStatus, UseMdvResult, UseMdvOptions } from './hooks/useMdv.js';

export { useMdvScene, useMdvSceneResult } from './hooks/useMdvScene.js';
export type { SceneOptions, SceneResult } from './hooks/useMdvScene.js';

export { useElementSize } from './hooks/useElementSize.js';
export type { ElementSize, ElementSizeOptions } from './hooks/useElementSize.js';

export { useVisible } from './hooks/useVisible.js';
export type { VisibleOptions } from './hooks/useVisible.js';

// ── Markdown rendering ───────────────────────────────────────────────────────
export { renderMarkdown, renderNode } from './markdown.js';
export type { ComponentOverrides, MarkdownContext, MdastNode } from './markdown.js';

// ── Styling (SPEC 22.4) ──────────────────────────────────────────────────────
export { CLASS_NAMES, REACT_CLASS_NAMES, reactStylesheet, stylesheet } from './stylesheet.js';

// ── The composed resolve (see `internal/compose.ts` for why it lives here) ───
export { compose, composeSync, needsFetch } from './internal/compose.js';
export type { ComposeOptions } from './internal/compose.js';

// ── Memoisation (SPEC 24.2), exported for hosts that manage their own ────────
export {
  blockKey,
  createCaches,
  diagnosticsOf,
  layoutCached,
  parseCached,
  resolveCached,
  resolveCachedSync,
  tableKey,
} from './internal/pipeline.js';
export type {
  CacheOptions,
  Caches,
  LayoutOutcome,
  LayoutSettings,
  PipelineStats,
} from './internal/pipeline.js';

export { contentHash, hashString } from './internal/hash.js';
export { BUILTIN_DEFAULTS, cascade, mergeAttrs, splitAttrs } from './internal/cascade.js';
export type { SplitAttrs } from './internal/cascade.js';
export { DEFAULT_HEIGHT, DEFAULT_WIDTH, resolveBlockSize } from './internal/size.js';
export type { SizeRequest } from './internal/size.js';
export { tableFromRows } from './internal/rows.js';
export type { Row, RowsResult } from './internal/rows.js';

// ── Re-exports a consumer would otherwise need a second import for ───────────
export type {
  Diagnostic,
  MdvConfig,
  ResolvedBlock,
  ResolvedDocument,
  Scene,
  Size,
  Theme,
  Value,
} from '@mdv/core';
