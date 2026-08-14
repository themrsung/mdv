/**
 * {@link MdvProvider} and the runtime context (SPEC 22.1).
 *
 * The provider supplies four things every descendant needs and none of which
 * should be rebuilt per block: the configuration, the resolved theme, the chart
 * registry, and the stage memos.
 *
 * **The memos are owned by the provider, not by the module.** SPEC 17.3
 * invariant 4 requires two documents to render concurrently without
 * interference, so there is no module-level cache anywhere in this package; a
 * component rendered outside any provider builds its own private runtime.
 */

import {
  createContext,
  createElement,
  Fragment,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ChartTypeRegistry, ColorScheme, MdvConfig, TextMetrics, Theme } from '@mdv/core';
import { createChartRegistry } from '@mdv/core';
import { createTableMetrics } from '@mdv/core/metrics/index.js';
import { getBuiltinTheme, isBuiltinThemeName, resolveColorScheme, resolveTheme } from '@mdv/themes';
import { createCaches, type Caches } from './internal/pipeline.js';
import { DEFAULT_WIDTH } from './internal/size.js';
import { stylesheet } from './stylesheet.js';

// ─────────────────────────────────────────────────────────────────────────────
// prefers-color-scheme
// ─────────────────────────────────────────────────────────────────────────────

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Nothing to unsubscribe from. Hoisted so the identity is stable. */
const NOOP = (): void => undefined;

function subscribeToScheme(onChange: () => void): () => void {
  // No `matchMedia` (Node, an old webview, a test runner) ⇒ the value is a
  // constant and there is nothing to listen to.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return NOOP;
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function readScheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * `prefers-color-scheme: dark`, as a subscription.
 *
 * `useSyncExternalStore` rather than an effect, and with an explicit server
 * snapshot: React renders the *server* value during hydration and swaps to the
 * client value immediately afterwards, so a reader in dark mode never produces a
 * hydration mismatch — it produces one extra render, which is the documented
 * cost of a value the server could not have known (SPEC 22.3).
 */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribeToScheme, readScheme, () => false);
}

// ─────────────────────────────────────────────────────────────────────────────
// The runtime
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the components share. Read through {@link useMdvRuntime}. */
export interface MdvRuntime {
  config: MdvConfig;
  /** The document-level theme, already resolved against the scheme in force. */
  theme: Theme;
  colorScheme: ColorScheme;
  registry: ChartTypeRegistry;
  /** The text-measurement provider. Deterministic by default (SPEC 24.3 rule 6). */
  metrics: TextMetrics;
  caches: Caches;
  /** The host's `prefers-color-scheme`, already sampled. */
  prefersDark: boolean;
  /** `'eager'` disables below-the-fold virtualisation, for printing (SPEC 22.3). */
  renderPolicy: 'lazy' | 'eager';
  /** Width used before the container has been measured, and on the server. */
  fallbackWidth: number;
  /** `true` when the consumer supplies its own CSS (SPEC 22.4). */
  unstyled: boolean;
}

const RuntimeContext = createContext<MdvRuntime | undefined>(undefined);

/** Props for {@link MdvProvider}. */
export interface MdvProviderProps {
  /** A built-in name, a resolved theme, or `'auto'` to follow the host scheme. */
  theme?: string | Theme | 'auto';
  /** Configuration shared by every descendant document and block. */
  config?: MdvConfig;
  /**
   * The chart types available to descendants. **Defaults to none.**
   *
   * ```tsx
   * import { MdvProvider } from '@mdv/react/auto';        // all twenty types
   *
   * import { MdvProvider } from '@mdv/react';             // or pick your own
   * import { createChartRegistry } from '@mdv/core';
   * import { barChart, lineChart } from '@mdv/charts';
   * <MdvProvider registry={createChartRegistry([barChart, lineChart])} />
   * ```
   *
   * The empty default is what makes SPEC 24.1's first bundle row — core, this
   * binding and *three* chart types — a number a consumer can reach. A default
   * of `builtinChartTypes` would name all twenty from a module every consumer
   * loads, so no bundler could drop any of them and SPEC 17.2's "tree-shakeable
   * per type" would be true of `@mdv/charts` and false of every React app: 50 KB
   * gzipped of pie geometry and sankey layout in a bundle that draws bars.
   *
   * Nothing is silently missing, because an unregistered type is already a
   * specified outcome: it degrades to a table with `MDV1500`, which names the
   * type and lists what *is* registered (SPEC 15.2). Extend the registry to add
   * a plugin type (SPEC 26.2).
   */
  registry?: ChartTypeRegistry;
  /**
   * Text measurement. Defaults to the bundled width table, which is what makes
   * server and client agree to the pixel (SPEC 22.3, 24.3 rule 6).
   */
  metrics?: TextMetrics;
  /**
   * The stage memos (SPEC 24.2). Defaults to a fresh set owned by this provider.
   *
   * Supply one to share the parse/resolve/layout memos across providers — a
   * server rendering many requests from a small set of documents, or an editor
   * holding one document open in two panes. Never share a set between two
   * *concurrent* renders of different configurations: the keys account for the
   * configuration, but the LRU capacity does not.
   */
  caches?: Caches;
  /** Overrides `config.render.renderPolicy`. */
  renderPolicy?: 'lazy' | 'eager';
  /** Layout width before the container is measured, and on the server. @defaultValue 800 */
  width?: number;
  /**
   * Do not emit the stylesheet; the consumer supplies its own (SPEC 22.4).
   * Class names stay the same, so a custom sheet can target them.
   */
  unstyled?: boolean;
  /**
   * CSP nonce for the emitted `<style>` element.
   *
   * Required under SPEC 13.5's `style-src 'self' 'nonce-…'`. Without one, pass
   * `unstyled` and link {@link stylesheet} as an external file instead.
   */
  styleNonce?: string;
  /**
   * Override the host's `prefers-color-scheme`.
   *
   * For tests and for a host that already knows the answer (a VS Code webview
   * knows its own theme without a media query).
   */
  prefersDark?: boolean;
  children?: ReactNode;
}

/** `true` for an object that is already a fully resolved {@link Theme}. */
function isTheme(value: unknown): value is Theme {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tokens' in value &&
    'categorical' in value &&
    'marks' in value
  );
}

/**
 * Resolve the provider's `theme` prop against the scheme in force.
 *
 * `'auto'`, and the absence of the prop, both mean "follow the host": the scheme
 * decides, and the scheme has already been resolved through `@mdv/themes` so
 * that an embedder's hard preference outranks the media query (SPEC 11.7).
 */
function resolveProviderTheme(
  theme: string | Theme | 'auto' | undefined,
  config: MdvConfig | undefined,
  prefersDark: boolean,
): { theme: Theme; colorScheme: ColorScheme } {
  if (isTheme(theme)) return { theme, colorScheme: theme.scheme };

  const named = typeof theme === 'string' && theme !== 'auto' ? theme : undefined;
  const colorScheme = resolveColorScheme({
    // A named theme states its own scheme; `auto` defers to the next level down.
    document: named === 'dark' ? 'dark' : named === undefined ? undefined : 'light',
    embedder: config?.colorScheme,
    prefersDark,
  });

  if (named !== undefined) {
    if (isBuiltinThemeName(named)) return { theme: getBuiltinTheme(named), colorScheme };
    // An unknown name from the embedder is host programmer error: `resolveTheme`
    // throws `MdvConfigError` naming the built-ins (SPEC 21).
    return { theme: resolveTheme({ extends: named }, colorScheme), colorScheme };
  }

  const configured = config?.theme;
  if (isTheme(configured)) return { theme: configured, colorScheme: configured.scheme };
  if (typeof configured === 'string') {
    return { theme: resolveTheme({ extends: configured }, colorScheme), colorScheme };
  }
  if (configured !== undefined)
    return { theme: resolveTheme(configured, colorScheme), colorScheme };

  return { theme: getBuiltinTheme(colorScheme === 'dark' ? 'dark' : 'default'), colorScheme };
}

const EMPTY_CONFIG: MdvConfig = Object.freeze({});

/**
 * Supply the configuration, the resolved theme and the chart registry to every
 * descendant.
 *
 * One provider per app is normal; nesting overrides locally, and a nested
 * provider gets its own memos so it cannot evict its parent's.
 */
export function MdvProvider(props: MdvProviderProps): ReactElement {
  const hostPrefersDark = usePrefersDark();
  const prefersDark = props.prefersDark ?? hostPrefersDark;
  const config = props.config ?? EMPTY_CONFIG;

  // The registry is stateful (it can be extended and frozen), so it is created
  // once per provider rather than per render. Empty unless one is passed — see
  // `MdvProviderProps.registry`, and `@mdv/react/auto` for the built-in set.
  const defaultRegistry = useMemo(() => createChartRegistry(), []);
  const defaultMetrics = useMemo(() => createTableMetrics(), []);
  const ownCaches = useMemo(() => createCaches(), []);
  const caches = props.caches ?? ownCaches;

  /**
   * The `theme` prop is sugar for `config.theme`, and it must be *published* as
   * such.
   *
   * `MdvDocument` re-resolves the theme from `runtime.config` when it composes,
   * because a document may set its own `theme:` and the cascade has to run
   * somewhere. If the prop stopped at `runtime.theme`, `<MdvProvider
   * theme="dark">` would tint the chrome and leave every block on the default
   * palette — the two would disagree, and only in the parts a screenshot shows.
   */
  const effectiveConfig = useMemo<MdvConfig>(() => {
    if (props.theme === undefined || props.theme === 'auto') return config;
    return { ...config, theme: props.theme };
  }, [config, props.theme]);

  const runtime = useMemo<MdvRuntime>(() => {
    const { theme, colorScheme } = resolveProviderTheme(props.theme, config, prefersDark);
    return {
      config: effectiveConfig,
      theme,
      colorScheme,
      registry: props.registry ?? defaultRegistry,
      metrics: props.metrics ?? defaultMetrics,
      caches,
      prefersDark,
      renderPolicy: props.renderPolicy ?? config.render?.renderPolicy ?? 'lazy',
      fallbackWidth: props.width ?? DEFAULT_WIDTH,
      unstyled: props.unstyled === true,
    };
  }, [
    config,
    effectiveConfig,
    prefersDark,
    props.theme,
    props.registry,
    props.metrics,
    props.renderPolicy,
    props.width,
    props.unstyled,
    defaultRegistry,
    defaultMetrics,
    caches,
  ]);

  const children: ReactNode[] = [];
  if (!runtime.unstyled) {
    children.push(
      createElement('style', {
        key: 'mdv-style',
        'data-mdv-styles': '',
        ...(props.styleNonce !== undefined ? { nonce: props.styleNonce } : {}),
        // The sheet is a constant this package authored: no document content
        // reaches it, and this is the only `dangerouslySetInnerHTML` in the
        // package (SPEC 13.3).
        dangerouslySetInnerHTML: { __html: stylesheet() },
      }),
    );
  }
  // A fragment, not a wrapper element: a provider must be transparent to the
  // surrounding layout.
  children.push(createElement(Fragment, { key: 'mdv-children' }, props.children));

  return createElement(RuntimeContext.Provider, { value: runtime }, ...children);
}

/**
 * The nearest runtime, or a private one when there is no provider.
 *
 * A standalone `<MdvBlock/>` must work with no ceremony (SPEC 22.1 shows exactly
 * that), so the fallback is real rather than a throw — but it is built with
 * `useMemo` inside the calling component, so it is still not shared state.
 *
 * @param fallbackRegistry Chart types for the private runtime, used only when
 * there is no provider above. This is how `@mdv/react/auto` seeds a lone block
 * with the built-ins without a second runtime implementation to keep in step.
 * A provider, if there is one, always wins: its registry is the document's.
 */
export function useMdvRuntime(fallbackRegistry?: ChartTypeRegistry): MdvRuntime {
  const parent = useContext(RuntimeContext);
  const prefersDark = usePrefersDark();

  const registry = useMemo(
    () => (parent === undefined ? (fallbackRegistry ?? createChartRegistry()) : undefined),
    [parent, fallbackRegistry],
  );
  const metrics = useMemo(
    () => (parent === undefined ? createTableMetrics() : undefined),
    [parent],
  );
  const caches = useMemo(() => (parent === undefined ? createCaches() : undefined), [parent]);

  return useMemo<MdvRuntime>(() => {
    if (parent !== undefined) return parent;
    const { theme, colorScheme } = resolveProviderTheme(undefined, undefined, prefersDark);
    return {
      config: EMPTY_CONFIG,
      theme,
      colorScheme,
      registry: registry ?? createChartRegistry(),
      metrics: metrics ?? createTableMetrics(),
      caches: caches ?? createCaches(),
      prefersDark,
      renderPolicy: 'lazy',
      fallbackWidth: DEFAULT_WIDTH,
      unstyled: false,
    };
  }, [parent, prefersDark, registry, metrics, caches]);
}

/** The resolved theme tokens from the nearest {@link MdvProvider} (SPEC 22.2). */
export function useMdvTheme(): Theme {
  return useMdvRuntime().theme;
}

export { RuntimeContext };
