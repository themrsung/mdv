/**
 * Per-render facts about the editing surface that every block view needs and
 * none of them should have to be handed by its parent.
 *
 * Kept deliberately small: it is derived state, recomputed from the engine
 * snapshot, never a second source of truth.
 */

import { createContext, useContext } from 'react';
import type { CellRect } from '../../engine/index.js';
import type { PendingImage } from '../input/images.js';

/** Where a drag would land if it were dropped now. */
export interface DropTarget {
  /** Insert after this block, or at the very top when `null`. */
  readonly afterBlockId: string | null;
}

/** Facts shared with every block view. */
export interface SurfaceInfo {
  /**
   * Remount counters. Bumped for a block whose DOM the browser rewrote behind
   * React's back (an IME commit, a non-cancelable input); used as a `key` so
   * React discards the foreign subtree instead of patching it.
   */
  readonly generations: ReadonlyMap<string, number>;
  /** Blocks the selection touches, for the cross-block highlight fallback. */
  readonly selectedBlocks: ReadonlySet<string>;
  /** The atomic block held by a node selection, if any. */
  readonly nodeSelection: string | null;
  /** The rectangular cell selection, if any. */
  readonly cellSelection: { readonly tableId: string; readonly rect: CellRect } | null;
  /** Block containing the caret, for showing handles only where they are wanted. */
  readonly activeBlockId: string | null;
  /** Images still decoding, rendered as placeholders in document order. */
  readonly pending: readonly PendingImage[];
  /** Live drop indicator during a drag. */
  readonly dropTarget: DropTarget | null;
  /** True while an input method owns some subtree; suppresses reactive work. */
  readonly composing: boolean;
}

export const EMPTY_SURFACE: SurfaceInfo = {
  generations: new Map(),
  selectedBlocks: new Set(),
  nodeSelection: null,
  cellSelection: null,
  activeBlockId: null,
  pending: [],
  dropTarget: null,
  composing: false,
};

export const SurfaceContext = createContext<SurfaceInfo>(EMPTY_SURFACE);

/** Read the surface facts. */
export function useSurface(): SurfaceInfo {
  return useContext(SurfaceContext);
}
