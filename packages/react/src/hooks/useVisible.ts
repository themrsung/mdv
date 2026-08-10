/**
 * Below-the-fold virtualisation (SPEC 22.3).
 *
 * > Blocks below the fold render a **correctly-sized placeholder** and mount on
 * > `IntersectionObserver` (`rootMargin: '200px'`). Off-screen blocks do not lay
 * > out. `renderPolicy: 'eager'` disables this for printing.
 *
 * ### Why this is a `useSyncExternalStore` and not a `useState`
 *
 * The same section requires that server markup and hydration markup match. Those
 * two requirements pull in opposite directions: the server has no viewport, so it
 * must render every block, while a fresh client mount should render placeholders
 * and skip the layout entirely.
 *
 * `useSyncExternalStore` is the one API that resolves this without a mismatch.
 * React uses `getServerSnapshot` for the server render *and* for the hydration
 * render, then re-renders with the client snapshot — so:
 *
 * - **SSR + hydration:** every block renders, markup matches, and off-screen
 *   blocks fall back to placeholders one render later.
 * - **A client-only mount:** the client snapshot is used from the first render,
 *   so an off-screen block never lays out at all.
 *
 * Doing this with `useState(true)` plus an effect would produce the first
 * behaviour and never the second; `useState(false)` would produce the second and
 * a hydration mismatch.
 */

import { useCallback, useMemo, useRef, useSyncExternalStore, type RefObject } from 'react';

/** Options for {@link useVisible}. */
export interface VisibleOptions {
  /** `false` pins visibility to `true` — `renderPolicy: 'eager'`, and printing. */
  enabled: boolean;
  /** How far outside the viewport counts as "approaching". @defaultValue '200px' */
  rootMargin?: string;
}

/** The mutable half of one block's visibility. */
interface VisibilityStore {
  visible: boolean;
  listeners: Set<() => void>;
}

/**
 * Whether a block is on screen, or close enough to be worth laying out.
 *
 * @param ref - the block's container
 * @returns `true` when the block should render its scene
 */
export function useVisible(ref: RefObject<Element | null>, options: VisibleOptions): boolean {
  const rootMargin = options.rootMargin ?? '200px';
  const enabled = options.enabled;

  // One store per hook instance. Never module-level (SPEC 17.3 invariant 4).
  const store = useRef<VisibilityStore | undefined>(undefined);
  if (store.current === undefined) {
    store.current = { visible: !enabled, listeners: new Set() };
  }
  const state = store.current;

  // An environment with no `IntersectionObserver` can never learn that a block
  // is off screen, so it must not start off screen. The snapshot answers `true`
  // outright in that case rather than the stored value — no render-phase
  // mutation, which `StrictMode`'s double render would run twice.
  const observable = useMemo(
    () => enabled && typeof IntersectionObserver !== 'undefined',
    [enabled],
  );

  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      state.listeners.add(onChange);

      const element = ref.current;
      if (!observable || element === null) {
        return () => state.listeners.delete(onChange);
      }

      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (entry === undefined) return;
          if (entry.isIntersecting === state.visible) return;
          state.visible = entry.isIntersecting;
          for (const listener of state.listeners) listener();
        },
        { rootMargin },
      );
      observer.observe(element);

      return () => {
        observer.disconnect();
        state.listeners.delete(onChange);
      };
    },
    [ref, observable, rootMargin, state],
  );

  const getSnapshot = useCallback(() => (observable ? state.visible : true), [observable, state]);
  // The server has no viewport: everything renders, which is what SSR and
  // printing both need, and it is the markup hydration will be handed.
  const getServerSnapshot = useCallback(() => true, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
