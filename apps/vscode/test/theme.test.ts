/**
 * Theme selection (SPEC 29.3 "theme follows the editor" and SPEC 5.5 level 2).
 */

import { describe, expect, it } from 'vitest';

import { builtinTheme, themeNameFor } from '../src/pipeline/index.js';
import { schemeOf, themeForBlock } from '../src/pipeline/theme.js';
import { ThemeFiles } from '../src/pipeline/themefile.js';
import type { BlockThemeContext } from '../src/pipeline/theme.js';
import type { ThemeFileRead, ThemeFileReader } from '../src/pipeline/themefile.js';

/** The document every relative `theme:` below resolves against. */
const DOC = 'file:///w/doc.md';

/** A theme file whose only claim is one token, so no palette can fail on it. */
const okYaml = "tokens:\n  surface: '#010203'\n";

/**
 * A reader over a `Map`, answering immediately. The real seam answers `pending`
 * first (see the `pending` test); most cases here are about what happens after.
 */
function readerFor(files: Record<string, string>): ThemeFileReader {
  return {
    read(uri: string): ThemeFileRead {
      const text = files[uri];
      return text === undefined
        ? { status: 'error', message: `no such file: ${uri}` }
        : { status: 'ok', text };
    },
  };
}

function context(files: ThemeFiles, allowExternal = true): BlockThemeContext {
  return { files, baseUri: DOC, allowExternal };
}

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
    expect(themeForBlock(preview, undefined)).toEqual({ theme: preview, problems: [], key: '' });
    expect(themeForBlock(preview, '')).toEqual({ theme: preview, problems: [], key: '' });
  });

  it('lets a block override with a built-in name', () => {
    const { theme, problems, key } = themeForBlock(preview, 'dark');
    expect(theme.scheme).toBe('dark');
    expect(problems).toEqual([]);
    expect(key).toBe('dark');
  });

  it('degrades to the preview theme when no host can load a file', () => {
    const { theme, problems } = themeForBlock(preview, './corporate.yaml');
    expect(theme).toBe(preview);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('MDV1502');
    expect(problems[0]?.message).toContain('./corporate.yaml');
  });

  it('gives blocks that named different files different memo keys', () => {
    const a = themeForBlock(preview, './a.yaml').key;
    const b = themeForBlock(preview, './b.yaml').key;
    expect(a).not.toBe(b);
    expect(a).not.toBe(themeForBlock(preview, 'dark').key);
  });

  it('loads a file through the host and reports nothing when it parses', () => {
    const files = new ThemeFiles(readerFor({ 'file:///w/brand.yaml': okYaml }));
    const { theme, problems } = themeForBlock(preview, './brand.yaml', context(files));
    expect(problems).toEqual([]);
    expect(theme.tokens.surface).toBe('#010203');
    expect(theme).not.toBe(preview);
  });

  it('draws the preview theme for one frame while the read is in flight', () => {
    let landed = false;
    const files = new ThemeFiles({
      read: (): ThemeFileRead => (landed ? { status: 'ok', text: okYaml } : { status: 'pending' }),
    });

    const first = themeForBlock(preview, './brand.yaml', context(files));
    expect(first.theme).toBe(preview);
    // `pending` is a wait, not a failure: nothing may reach the Problems panel.
    expect(first.problems).toEqual([]);

    landed = true;
    expect(themeForBlock(preview, './brand.yaml', context(files)).theme.tokens.surface).toBe(
      '#010203',
    );
  });

  it('keys the load by scheme, so light and dark resolutions coexist', () => {
    const files = new ThemeFiles(readerFor({ 'file:///w/brand.yaml': okYaml }));
    const light = themeForBlock(preview, './brand.yaml', context(files));
    const dark = themeForBlock(builtinTheme('dark'), './brand.yaml', context(files));
    expect(light.key).not.toBe(dark.key);
    expect(light.theme.scheme).toBe('light');
    expect(dark.theme.scheme).toBe('dark');
  });

  it('changes the memo key when the file changes underneath', () => {
    const files = new ThemeFiles(readerFor({ 'file:///w/brand.yaml': okYaml }));
    const before = themeForBlock(preview, './brand.yaml', context(files)).key;
    files.invalidate('file:///w/brand.yaml');
    expect(themeForBlock(preview, './brand.yaml', context(files)).key).not.toBe(before);
  });

  it('reports MDV1502 and draws on the preview theme when the file is unreadable', () => {
    const files = new ThemeFiles(readerFor({}));
    const { theme, problems } = themeForBlock(preview, './missing.yaml', context(files));
    expect(theme).toBe(preview);
    expect(problems.map((problem) => problem.code)).toEqual(['MDV1502']);
    expect(problems[0]?.detail).toContain('no such file');
  });

  it('refuses an http(s) theme file as external data unless allowed', () => {
    const files = new ThemeFiles(readerFor({}));
    const { problems } = themeForBlock(preview, 'https://example.com/t.json', {
      ...context(files),
      allowExternal: false,
    });
    expect(problems.map((problem) => problem.code)).toEqual(['MDV4002']);
  });

  it('rejects a path that is not a theme file before touching the filesystem', () => {
    let reads = 0;
    const files = new ThemeFiles({
      read: (): ThemeFileRead => {
        reads += 1;
        return { status: 'error', message: 'unreachable' };
      },
    });
    const { problems } = themeForBlock(preview, './corporate.toml', context(files));
    expect(reads).toBe(0);
    expect(problems.map((problem) => problem.code)).toEqual(['MDV1502']);
  });
});
