/**
 * `@mdv/react/auto` — the binding with every built-in chart type registered.
 *
 * ```tsx
 * import { MdvDocument, MdvProvider } from '@mdv/react/auto';
 * ```
 *
 * The same components as `@mdv/react`, drawing all twenty built-ins (SPEC 16.1)
 * instead of nothing. Import from here to get started, or when a document's
 * types are not known ahead of time — a CMS, a playground, an editor. Import
 * from `@mdv/react` and pass a registry when the bundle matters (SPEC 24.1):
 * the main entry names no chart type, so a bundler drops the ones you leave
 * out, which is what makes SPEC 17.2's per-type shaking reach a React app.
 *
 * ```tsx
 * import { MdvProvider } from '@mdv/react';
 * import { createChartRegistry } from '@mdv/core';
 * import { barChart, lineChart } from '@mdv/charts';
 *
 * <MdvProvider registry={createChartRegistry([barChart, lineChart])} />
 * ```
 *
 * Everything else is re-exported unchanged, so `/auto` is a drop-in for the
 * main entry and the two can be mixed in one app — but do not import both in
 * one *bundle* if you are counting bytes, because `/auto` names all twenty.
 */

import { createElement, type ReactElement, type ReactNode } from 'react';
import { createChartRegistry, type ChartTypeRegistry } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';
import {
  MdvProvider as BaseProvider,
  RuntimeContext,
  useMdvRuntime,
  type MdvProviderProps,
} from './context.js';
import { MdvBlock as BaseBlock, type MdvBlockProps } from './block.js';
import { MdvBlockView as BaseBlockView, type MdvBlockViewProps } from './blockview.js';
import { MdvDocument as BaseDocument, type MdvDocumentProps } from './document.js';

export * from './index.js';

/**
 * Every built-in chart type, in one shared registry (SPEC 16.1).
 *
 * Frozen, and so not the global mutable state SPEC 17.3 invariant 4 forbids:
 * one instance is safe to share across providers because no one can change it.
 * Registering a plugin type means building your own registry — start from
 * {@link builtinChartTypes} and add to it (SPEC 26.2).
 *
 * Sharing costs nothing either way: pipeline memo keys are the registered
 * names, not the registry's identity, so a per-provider copy of the same types
 * hits the same memos.
 */
export const autoRegistry: ChartTypeRegistry = /* @__PURE__ */ (() => {
  const registry = createChartRegistry(builtinChartTypes);
  registry.freeze();
  return registry;
})();

/**
 * Supply {@link autoRegistry} to a subtree that has no provider of its own.
 *
 * When there *is* a provider the hook returns it and this re-provides the same
 * object, which React treats as no change: a document's registry is the one its
 * author chose, and importing a block from `/auto` cannot widen it.
 */
function AutoRoot(props: { readonly children?: ReactNode }): ReactElement {
  const runtime = useMdvRuntime(autoRegistry);
  return createElement(RuntimeContext.Provider, { value: runtime }, props.children);
}

/**
 * The provider, with every built-in registered.
 *
 * `registry` still overrides — pass one to narrow or extend the set, exactly as
 * on the main entry.
 */
export function MdvProvider(props: MdvProviderProps): ReactElement {
  return createElement(BaseProvider, { ...props, registry: props.registry ?? autoRegistry });
}

/** The document, drawing every built-in type with or without a provider. */
export function MdvDocument(props: MdvDocumentProps): ReactElement {
  return createElement(AutoRoot, null, createElement(BaseDocument, props));
}

/** A lone block, drawing every built-in type with or without a provider. */
export function MdvBlock(props: MdvBlockProps): ReactElement {
  return createElement(AutoRoot, null, createElement(BaseBlock, props));
}

/** One resolved block, drawing every built-in type with or without a provider. */
export function MdvBlockView(props: MdvBlockViewProps): ReactElement {
  return createElement(AutoRoot, null, createElement(BaseBlockView, props));
}
