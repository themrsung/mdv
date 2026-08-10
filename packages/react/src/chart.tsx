/**
 * The chart surface: a `Scene` as React-owned JSX, plus the interaction layer.
 *
 * SPEC 22.3:
 *
 * > The DOM is **React-owned**: `@mdv/render-svg` exposes a
 * > `toReactElements(scene)` path in addition to its imperative DOM path, so
 * > charts are ordinary JSX and reconcile normally.
 * > … Hydration attaches interaction only; markup MUST match, which the
 * > deterministic id scheme guarantees.
 *
 * So the `<svg>` and everything under it is React's, built from the scene and
 * diffed like any other tree, and the *behaviour* — hover readout, crosshair,
 * arrow-key traversal, the polite live region, the focus ring — is attached
 * imperatively in an effect after mount.
 *
 * The keyboard layer itself is `@mdv/render-svg`'s `attachInteraction`, not a
 * re-implementation. SPEC 12.4 requires that
 *
 * > The focused mark shows the **same readout as hover**
 *
 * and that package guarantees it by having exactly one `show(region)` function
 * that both paths call. A second implementation living here would be a second
 * chance for the two to drift, which is the failure the requirement names.
 * What this file adds is the part that only exists in React: the table view of
 * SPEC 12.3 as a real element, and the <kbd>T</kbd> shortcut wired to it.
 */

import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import type { Scene } from '@mdv/core';
import { attachInteraction, toReactElements } from '@mdv/render-svg';
import { MdvTableView } from './tableview.js';
import { applyShortcut, classifyKey, isTypingTarget } from './internal/keyboard.js';
import { REACT_CLASS_NAMES as CLS } from './stylesheet.js';

/**
 * SVG presentation attributes React does not know in their camelCase spelling.
 *
 * `@mdv/render-svg`'s `reactPropName` camelCases every hyphenated attribute,
 * which is right for the ones React has in its table (`stroke-width` →
 * `strokeWidth`) and wrong for the ones it does not: React drops an unrecognised
 * camelCase prop with a warning, so `font-variant-numeric: tabular-nums` would
 * silently disappear from the React path while surviving in the SVG string —
 * two backends, two renderings, which SPEC 20 exists to prevent.
 *
 * React passes any prop whose name contains a hyphen straight through, so
 * spelling these back out is both safe and complete.
 *
 * Worked around here rather than fixed there because `@mdv/render-svg` is
 * another package; see this package's summary.
 */
const HYPHENATE: Readonly<Record<string, string>> = Object.freeze({
  fontVariantNumeric: 'font-variant-numeric',
  fontFeatureSettings: 'font-feature-settings',
});

/**
 * React's `createElement`, adapted to `@mdv/render-svg`'s factory shape.
 *
 * The renderer puts `key` inside the props object because it has no React to
 * import; `createElement` reads it out of the config exactly as the classic API
 * always has, so no key ever reaches the DOM as an attribute.
 */
function create(type: string, props: Record<string, unknown>, ...children: unknown[]): unknown {
  let fixed = props;
  for (const camel of Object.keys(HYPHENATE)) {
    if (!(camel in props)) continue;
    if (fixed === props) fixed = { ...props };
    const hyphenated = HYPHENATE[camel];
    if (hyphenated === undefined) continue;
    fixed[hyphenated] = fixed[camel];
    delete fixed[camel];
  }
  return createElement(type, fixed as never, ...(children as never[]));
}

/** Props for {@link MdvChart}. */
export interface MdvChartProps {
  scene: Scene;
  /**
   * Attach the hover/keyboard layer after mount. `false` for a static render.
   *
   * The *markup* is identical either way — the hit overlay is part of the scene
   * — so turning this off does not change what the server emitted, and
   * hydration still matches (SPEC 22.3).
   */
  interactive?: boolean;
  /** The reader selected a mark: click, <kbd>Enter</kbd> or <kbd>Space</kbd>. */
  onSelect?: (regionId: string) => void;
  /** A mark took pointer or keyboard focus. */
  onActivate?: (regionId: string) => void;
  /** Rendered after the chart. Defaults to the scene's own table view. */
  showTableView?: boolean;
  /**
   * Namespace for the generated element ids.
   *
   * Defaults to `Scene.meta.blockId`, which is unique within a document but not
   * across two documents on one page — `aria-labelledby` would then point at
   * whichever `<title>` came first. Give each document its own prefix when a page
   * holds more than one (SPEC 13.3, 24.3 rule 7).
   */
  idPrefix?: string;
  className?: string;
}

/**
 * Draw one scene.
 *
 * The wrapper is a `<div>`, never a `<figure>`: the `<svg>` already carries
 * `role="img"`/`"figure"` and its `aria-labelledby` wiring from the a11y tree
 * (SPEC 12.1, 23.1), and the caption is drawn *inside* the scene, so a
 * `<figcaption>` here would announce it a second time.
 */
export function MdvChart(props: MdvChartProps): ReactElement {
  const { scene } = props;
  const interactive = props.interactive ?? true;
  const showTableView = props.showTableView ?? true;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const tableId = useId();

  const [tableOpen, setTableOpen] = useState(false);

  // Handlers live in a ref so a new closure from the parent does not tear down
  // and re-attach the whole interaction layer — which would drop the reader's
  // keyboard position mid-traversal.
  const handlers = useRef(props);
  handlers.current = props;

  const presentation = scene.a11y.table.presentation;

  /**
   * SPEC 12.4's block-level shortcuts, on the surface rather than on the `<svg>`.
   *
   * One handler, deliberately: `attachInteraction` is *not* given an
   * `onToggleTable`, because it and this would then both fire for the same `T`
   * — `preventDefault` does not stop propagation — and the table would toggle
   * twice. Putting it here instead also covers a chart with no hit regions,
   * where the imperative layer correctly declines to attach at all.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const shortcut = classifyKey(event, {
        presentation,
        tableOpen,
        typing: isTypingTarget(event.target),
      });
      if (shortcut === 'none') return;
      event.preventDefault();
      setTableOpen((open) => applyShortcut(shortcut, open));
    },
    [presentation, tableOpen],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !interactive) return undefined;

    // Attached, and fully detached again by the disposer: `StrictMode` mounts,
    // unmounts and remounts every effect, and a layer that leaked a listener or
    // a tooltip would double them.
    const detach = attach(host, scene, {
      onSelect: (id: string) => handlers.current.onSelect?.(id),
      onActivate: (id: string) => handlers.current.onActivate?.(id),
    });
    return detach;
  }, [scene, interactive]);

  const svg = toReactElements(scene, create, {
    idPrefix: props.idPrefix ?? scene.meta.blockId,
  }) as ReactElement;

  return (
    <div
      className={props.className === undefined ? CLS.surface : `${CLS.surface} ${props.className}`}
      ref={hostRef}
      data-mdv-block={scene.meta.blockId}
      onKeyDown={onKeyDown}
    >
      {svg}
      {showTableView ? (
        // Focus deliberately stays on the chart when `T` opens this: the reader
        // is mid-traversal, a second `T` must close it again, and moving focus
        // into the table would strand them there when it closed.
        <MdvTableView
          table={scene.a11y.table}
          id={tableId}
          open={tableOpen}
          onOpenChange={setTableOpen}
        />
      ) : null}
    </div>
  );
}

/**
 * Indirection over `attachInteraction`, so a missing DOM cannot crash an effect.
 *
 * `attachInteraction` is total on a real host, but the effect may run in an
 * environment where `Element` exists and `ownerDocument` does not — a synthetic
 * document in a worker, a partial test double. A failure to attach must cost the
 * reader interaction, never the document (SPEC 14.1 principle 1).
 */
function attach(
  host: Element,
  scene: Scene,
  handlers: {
    onSelect(id: string): void;
    onActivate(id: string): void;
  },
): () => void {
  try {
    return attachInteraction(host, scene, handlers);
  } catch {
    return () => undefined;
  }
}
