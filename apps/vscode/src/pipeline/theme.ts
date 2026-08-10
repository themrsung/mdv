/**
 * Theme selection for the preview (SPEC 29.3).
 *
 * "Theme follows the editor: the light/dark/high-contrast kinds map to
 * `default`/`dark`/`high-contrast`." That mapping lives here, together with the
 * per-block `theme:` override of SPEC 5.5 level 2, so the preview and the
 * diagnostics engine cannot disagree about which theme a block was judged under.
 */

import type { ColorScheme, Theme } from '@mdv/core';
import { getBuiltinTheme, isBuiltinThemeName } from '@mdv/themes';
import type { PreviewThemeSetting } from '../settings.js';

/** The four built-in theme names of `@mdv/themes`. */
export type BuiltinName = 'default' | 'dark' | 'high-contrast' | 'print';

/**
 * The editor's colour-theme kind, reduced to what MDV distinguishes.
 *
 * `vscode.ColorThemeKind` has five members (`Light`, `Dark`, `HighContrast`,
 * `HighContrastLight`); both high-contrast kinds map to the one MDV
 * high-contrast theme, which is itself scheme-aware.
 */
export type EditorKind = 'light' | 'dark' | 'high-contrast';

/** SPEC 29.3's mapping, plus the explicit settings values of SPEC 29.6. */
export function themeNameFor(setting: PreviewThemeSetting, editor: EditorKind): BuiltinName {
  switch (setting) {
    case 'light':
      return 'default';
    case 'dark':
      return 'dark';
    case 'high-contrast':
      return 'high-contrast';
    case 'auto':
      return editor === 'dark' ? 'dark' : editor === 'high-contrast' ? 'high-contrast' : 'default';
  }
}

/**
 * Resolve the theme for one block: the document/preview theme, unless the block
 * overrides it with `theme:` (cascade level 2, SPEC 5.5).
 *
 * An unknown name is *not* an error here — SPEC 15.2 says an unknown construct
 * degrades — so it falls back to the preview theme and the caller may report it.
 */
export function themeForBlock(
  previewTheme: Theme,
  blockThemeName: string | undefined,
): { theme: Theme; unknown: string | undefined } {
  if (blockThemeName === undefined || blockThemeName.length === 0) {
    return { theme: previewTheme, unknown: undefined };
  }
  if (isBuiltinThemeName(blockThemeName)) {
    return { theme: getBuiltinTheme(blockThemeName), unknown: undefined };
  }
  // A path or URL: loading it needs the filesystem/network capability, which the
  // preview does not grant by default (SPEC 29.3). Degrade, and say so.
  return { theme: previewTheme, unknown: blockThemeName };
}

/** The colour scheme a theme paints in, for `makeLayoutContext`. */
export function schemeOf(theme: Theme): ColorScheme {
  return theme.scheme;
}

/** Load a built-in theme by the name {@link themeNameFor} produced. */
export function builtinTheme(name: BuiltinName): Theme {
  return getBuiltinTheme(name);
}
