/**
 * The surface a document is drawn on, end to end (SPEC 11.7).
 *
 * SPEC 11.7 orders light/dark as: the block's `theme`, the document's `theme`,
 * the embedder's setting, then `prefers-color-scheme`. Three separate places
 * used to answer that question by reading the *request* rather than the theme
 * that was actually resolved, and each one is invisible to a unit test that
 * registers no themes:
 *
 *  1. `resolveThemeSetting(undefined, 'dark', themes)` asked the plugins for
 *     `default` and got the light one, because a plugin registers its two
 *     surfaces under two names (`default` and `dark`) and the name-first
 *     fallback in `fromPlugins` returns a wrong-surface match rather than
 *     nothing. With no plugins the built-in fallback answered correctly, so the
 *     existing `resolveConfig({ colorScheme: 'dark' })` assertion passed while
 *     every real embedder — every one of which registers `@mdv/themes` — got
 *     light tokens for a dark request.
 *  2. `ResolvedConfig.colorScheme` reported the embedder's preference, so front
 *     matter's `theme: dark` produced dark tokens under a `data-theme="light"`
 *     stamp.
 *  3. `createLayoutContext` copied that document-level scheme onto every block,
 *     so a per-block `theme: dark` — the *top* of the precedence order — reached
 *     layout claiming to be light.
 *
 * So these tests all register themes the way a host does, through a plugin, and
 * assert on tokens rather than only on names: a scheme that disagrees with the
 * tokens baked into the marks is the bug being pinned.
 */

import { describe, expect, it } from 'vitest';
import type { MdvPlugin, Theme } from '../src/index.js';
import {
  FALLBACK_THEME,
  FALLBACK_THEME_DARK,
  createLayoutContext,
  parse,
  resolveConfig,
  resolveSync,
} from '../src/index.js';

/**
 * The two surfaces a themes plugin registers, named the way `@mdv/themes`'
 * `themeNameForScheme` names them, and with one token per theme changed to a
 * sentinel so "which theme answered" is a value assertion and not a name match.
 */
const LIGHT_SURFACE = '#fffffe';
const DARK_SURFACE = '#010102';

const LIGHT: Theme = Object.freeze({
  ...FALLBACK_THEME,
  name: 'default',
  tokens: Object.freeze({ ...FALLBACK_THEME.tokens, surface: LIGHT_SURFACE }),
});

const DARK: Theme = Object.freeze({
  ...FALLBACK_THEME_DARK,
  name: 'dark',
  tokens: Object.freeze({ ...FALLBACK_THEME_DARK.tokens, surface: DARK_SURFACE }),
});

const themes: MdvPlugin = { name: 'test-themes', version: '1.0.0', themes: [LIGHT, DARK] };

/** A one-block document, optionally with front matter and per-block attributes. */
function docSource(frontmatter?: string, blockAttrs?: string): string {
  const front = frontmatter === undefined ? '' : `---\n${frontmatter}\n---\n\n`;
  const attrs = blockAttrs === undefined ? '' : `${blockAttrs}\n`;
  return `${front}\`\`\`mdv bar\n${attrs}x: a\n---\na\n1\n\`\`\`\n`;
}

describe('the embedder’s colour scheme selects the surface (SPEC 11.7)', () => {
  it('answers a dark request with the plugin’s dark theme, not its light one', () => {
    const config = resolveConfig({ colorScheme: 'dark', plugins: [themes] });

    expect(config.theme.name).toBe('dark');
    expect(config.theme.scheme).toBe('dark');
    expect(config.theme.tokens.surface).toBe(DARK_SURFACE);
    expect(config.colorScheme).toBe('dark');
  });

  it('leaves the light resolution exactly as it was', () => {
    const config = resolveConfig({ plugins: [themes] });

    expect(config.theme.name).toBe('default');
    expect(config.theme.scheme).toBe('light');
    expect(config.theme.tokens.surface).toBe(LIGHT_SURFACE);
    expect(config.colorScheme).toBe('light');
  });

  it('falls back to the built-in surface when the plugin registered no dark theme', () => {
    const lightOnly: MdvPlugin = { name: 'light-only', version: '1.0.0', themes: [LIGHT] };
    const config = resolveConfig({ colorScheme: 'dark', plugins: [lightOnly] });

    // The one theme guaranteed to be the surface it claims. Answering with
    // `LIGHT` because it is called `default` would be the original bug.
    expect(config.theme.scheme).toBe('dark');
    expect(config.theme.tokens.surface).not.toBe(LIGHT_SURFACE);
  });
});

describe('a document’s own theme outranks the embedder’s scheme (SPEC 11.7)', () => {
  it('reports the resolved surface, so `data-theme` matches the baked tokens', () => {
    const doc = resolveSync(parse(docSource('theme: dark')), {
      colorScheme: 'light',
      plugins: [themes],
    });

    expect(doc.config.theme.tokens.surface).toBe(DARK_SURFACE);
    expect(doc.config.colorScheme).toBe('dark');
  });

  it('does not turn a light document dark', () => {
    const doc = resolveSync(parse(docSource()), { colorScheme: 'light', plugins: [themes] });

    expect(doc.config.theme.tokens.surface).toBe(LIGHT_SURFACE);
    expect(doc.config.colorScheme).toBe('light');
  });
});

describe('a per-block theme reaches layout as the surface it is (SPEC 11.7, 24.3)', () => {
  it('hands a dark block in a light document the dark scheme', () => {
    const doc = resolveSync(parse(docSource(undefined, 'theme: dark')), {
      colorScheme: 'light',
      plugins: [themes],
    });
    const block = doc.blocks[0];
    if (block === undefined) throw new Error('unreachable: the source has one block');

    expect(block.theme.tokens.surface).toBe(DARK_SURFACE);
    expect(createLayoutContext(doc, block).colorScheme).toBe('dark');
    // The document is still light: the override is scoped to the block.
    expect(doc.config.colorScheme).toBe('light');
  });

  it('leaves an unthemed block on the document’s surface', () => {
    const doc = resolveSync(parse(docSource()), { colorScheme: 'light', plugins: [themes] });
    const block = doc.blocks[0];
    if (block === undefined) throw new Error('unreachable: the source has one block');

    expect(createLayoutContext(doc, block).colorScheme).toBe('light');
    expect(createLayoutContext(doc, block).theme.tokens.surface).toBe(LIGHT_SURFACE);
  });
});
