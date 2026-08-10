/**
 * View preferences: things the reader chooses that are not part of the
 * document.
 *
 * Kept apart from the engine on purpose. A document is what `write()` produces
 * and nothing else; if a setting cannot round-trip through `.mdv` it does not
 * belong in the model, and putting it here rather than smuggling it into a node
 * keeps that line visible.
 */

import { createContext, useContext } from 'react';
import type { ImageAlign } from '../blocks/image-align.js';

/** Resolved colour scheme for this render. */
export type ColorScheme = 'light' | 'dark';

export interface ViewPrefs {
  readonly scheme: ColorScheme;
  /** Preview-only image alignment, by block id. Never written to the file. */
  readonly imageAlign: ReadonlyMap<string, ImageAlign>;
  setImageAlign(blockId: string, align: ImageAlign): void;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  scheme: 'light',
  imageAlign: new Map(),
  setImageAlign: () => undefined,
};

export const ViewPrefsContext = createContext<ViewPrefs>(DEFAULT_VIEW_PREFS);

export function useViewPrefs(): ViewPrefs {
  return useContext(ViewPrefsContext);
}
