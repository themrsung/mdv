/**
 * Colour-scheme selection (SPEC 11.7).
 *
 * Light/dark follows, in precedence order: the block's `theme`, the document's
 * `theme`, the embedder's setting, then `prefers-color-scheme`.
 *
 * Resolution happens **once, at resolve**, and the answer is baked into the
 * scene: backends receive absolute colours, never a media query (SPEC 20). That
 * is what lets the SVG string, the PDF and the screen agree, and it is why this
 * function takes `prefersDark` as an argument rather than reading `matchMedia`
 * itself — SPEC 17.3 invariant 1 keeps the host out of the pipeline.
 */

import type { ColorScheme, ColorSchemePreference } from '@mdv/core';

/** The inputs to scheme selection, in precedence order (SPEC 11.7). */
export interface ColorSchemeInputs {
  /** The block's own `theme`/`colorScheme`. Highest precedence. */
  block?: ColorSchemePreference | undefined;
  /** The document's front-matter setting. */
  document?: ColorSchemePreference | undefined;
  /** The embedder's configuration (`MdvConfig.colorScheme`). */
  embedder?: ColorSchemePreference | undefined;
  /**
   * The host's `prefers-color-scheme`, sampled by the caller. `undefined` means
   * the host has no opinion (a CLI, a build) and light wins.
   */
  prefersDark?: boolean | undefined;
}

/**
 * Resolve the colour scheme in force.
 *
 * `'auto'` at any level defers to the next level down, which is what makes
 * `colorScheme: 'auto'` on a document composable with an embedder that has a
 * hard preference.
 */
export function resolveColorScheme(inputs: ColorSchemeInputs): ColorScheme {
  for (const level of [inputs.block, inputs.document, inputs.embedder]) {
    if (level === 'light' || level === 'dark') return level;
  }
  return inputs.prefersDark === true ? 'dark' : 'light';
}

/** The built-in theme name a bare scheme maps to. */
export function themeNameForScheme(scheme: ColorScheme): 'default' | 'dark' {
  return scheme === 'dark' ? 'dark' : 'default';
}
