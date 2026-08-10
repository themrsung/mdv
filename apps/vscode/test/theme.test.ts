/**
 * Theme selection (SPEC 29.3 "theme follows the editor" and SPEC 5.5 level 2).
 */

import { describe, expect, it } from 'vitest';

import { builtinTheme, themeNameFor } from '../src/pipeline/index.js';
import { schemeOf, themeForBlock } from '../src/pipeline/theme.js';

describe('themeNameFor', () => {
  it('follows the editor when the setting is auto', () => {
    expect(themeNameFor('auto', 'light')).toBe('default');
    expect(themeNameFor('auto', 'dark')).toBe('dark');
    expect(themeNameFor('auto', 'high-contrast')).toBe('high-contrast');
  });

  it('honours an explicit setting whatever the editor is wearing', () => {
    expect(themeNameFor('light', 'dark')).toBe('default');
    expect(themeNameFor('dark', 'light')).toBe('dark');
    expect(themeNameFor('high-contrast', 'light')).toBe('high-contrast');
  });
});

describe('builtinTheme', () => {
  it('loads each of the four built-ins with a usable palette', () => {
    for (const name of ['default', 'dark', 'high-contrast', 'print'] as const) {
      const theme = builtinTheme(name);
      expect(theme.categorical.length).toBeGreaterThan(0);
      expect(theme.tokens.surface).toMatch(/^#|^rgb|^hsl/);
      expect(schemeOf(theme)).toBe(theme.scheme);
    }
  });

  it('paints the dark theme in the dark scheme', () => {
    expect(builtinTheme('dark').scheme).toBe('dark');
    expect(builtinTheme('default').scheme).toBe('light');
  });
});

describe('themeForBlock', () => {
  const preview = builtinTheme('default');

  it('keeps the preview theme when the block names none', () => {
    expect(themeForBlock(preview, undefined)).toEqual({ theme: preview, unknown: undefined });
    expect(themeForBlock(preview, '')).toEqual({ theme: preview, unknown: undefined });
  });

  it('lets a block override with a built-in name', () => {
    const { theme, unknown } = themeForBlock(preview, 'dark');
    expect(theme.scheme).toBe('dark');
    expect(unknown).toBeUndefined();
  });

  it('degrades to the preview theme and names what it could not load', () => {
    const { theme, unknown } = themeForBlock(preview, './corporate.yaml');
    expect(theme).toBe(preview);
    expect(unknown).toBe('./corporate.yaml');
  });
});
