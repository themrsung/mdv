/**
 * `useMdvScene` — stages 6–7 for one block (SPEC 22.2).
 *
 * ```ts
 * const scene = useMdvScene(block, { width, height });   // memoised on content hash
 * ```
 *
 * > a re-render with the same block and size returns the same `Scene` **by
 * > identity**, so the SVG subtree reconciles to nothing.
 *
 * That identity guarantee is the whole point. `toReactElements` rebuilds the
 * element tree from a scene, and React will diff it against the previous one; if
 * the scene were a fresh object every render, every axis tick in the document
 * would be re-created on every keystroke. The memo in `internal/pipeline.ts` is
 * keyed on the block's *content*, so:
 *
 * - a resize changes only the size half of the key — no parse, no resolve;
 * - editing one block's title changes only that block's half — its siblings
 *   return their existing scenes, by identity.
 *
 * Layout never throws for document content (SPEC 21): a block that cannot be
 * drawn comes back as a scene containing its error card. The `try` here is for
 * the other thing — a host that supplied a broken `TextMetrics` or a plugin
 * registry that throws at lookup — and it degrades to `undefined` so the caller
 * can show the React error card rather than taking the document down.
 */

import { useMemo } from 'react';
import type { ChartTypeRegistry, Diagnostic, ResolvedBlock, Scene, Size } from '@mdv/core';
import { useMdvRuntime } from '../context.js';
import { layoutCached, type LayoutSettings } from '../internal/pipeline.js';

/** What {@link useMdvSceneResult} returns. */
export interface SceneResult {
  /** `undefined` only when layout itself failed — host programmer error. */
  scene: Scene | undefined;
  /** Diagnostics layout produced, replayed from the memo on a cache hit. */
  diagnostics: readonly Diagnostic[];
  /** The failure behind an `undefined` scene. */
  error: Error | undefined;
}

/** Per-call overrides for the layout context. */
export interface SceneOptions {
  registry?: ChartTypeRegistry | undefined;
  /** Forced off under `prefers-reduced-motion` (SPEC 12.5). */
  animate?: boolean | undefined;
  /** Overrides the resolved `a11y.tableView` for this block (SPEC 12.3). */
  tableView?: 'details' | 'visible' | 'hidden' | 'none' | undefined;
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);

/**
 * Lay a block out and report what happened.
 *
 * {@link useMdvScene} is the SPEC 22.2 spelling and returns the scene alone;
 * this is the same computation with the diagnostics kept, which the block
 * component needs in order to bubble them to `onDiagnostics`.
 */
export function useMdvSceneResult(
  block: ResolvedBlock,
  size: Size,
  options: SceneOptions = {},
): SceneResult {
  const runtime = useMdvRuntime();
  const registry = options.registry ?? runtime.registry;
  const config = runtime.config;

  const animate = options.animate ?? config.render?.animate ?? true;
  const tableView = options.tableView ?? config.a11y?.tableView ?? 'details';
  const texture = config.a11y?.texture ?? false;
  const generateDesc = config.a11y?.generateDesc ?? true;
  const locale = config.locale ?? 'en-US';
  const timezone = config.timezone ?? 'UTC';
  const level = config.level ?? 2;
  const buildTimeMs = config.buildTime?.getTime();

  const settings = useMemo<LayoutSettings>(
    () => ({
      // A block may override the document theme (SPEC 5.5 level 6); resolve did
      // that already and put the answer on the block.
      theme: block.theme,
      metrics: runtime.metrics,
      locale,
      timezone,
      level,
      // Not the host clock (SPEC 24.3 rule 2). Core's own default is the epoch.
      buildTime: buildTimeMs === undefined ? new Date(0) : new Date(buildTimeMs),
      colorScheme: block.theme.scheme,
      a11y: { texture, tableView, generateDesc },
      animate,
    }),
    [
      block.theme,
      runtime.metrics,
      locale,
      timezone,
      level,
      buildTimeMs,
      texture,
      tableView,
      generateDesc,
      animate,
    ],
  );

  return useMemo<SceneResult>(() => {
    // A zero-width box is a real state — the container has not been measured
    // yet. Laying out at 0 emits `MDV5001` on every mount, so the caller shows
    // its placeholder instead and asks again once the observer reports.
    if (!(size.width > 0) || !(size.height > 0)) {
      return { scene: undefined, diagnostics: NO_DIAGNOSTICS, error: undefined };
    }
    try {
      const outcome = layoutCached(runtime.caches, block, size, settings, registry);
      return { scene: outcome.scene, diagnostics: outcome.diagnostics, error: undefined };
    } catch (cause) {
      return {
        scene: undefined,
        diagnostics: NO_DIAGNOSTICS,
        error: cause instanceof Error ? cause : new Error(String(cause)),
      };
    }
  }, [runtime.caches, block, size.width, size.height, settings, registry]);
}

/**
 * Lay a block out at a given size, memoised on content hash (SPEC 22.2).
 *
 * @throws the underlying failure when layout could not run at all — host
 * programmer error, per SPEC 21's error contract. Use {@link useMdvSceneResult}
 * to handle it as data instead.
 */
export function useMdvScene(block: ResolvedBlock, size: Size, options?: SceneOptions): Scene {
  const result = useMdvSceneResult(block, size, options);
  if (result.error !== undefined) throw result.error;
  if (result.scene === undefined) {
    throw new Error(
      `Cannot lay out block ${JSON.stringify(block.id)} at ${size.width} × ${size.height}: ` +
        'the container has no size yet. Wait for `useElementSize`, or pass an explicit height.',
    );
  }
  return result.scene;
}
