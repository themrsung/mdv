/**
 * The theme context and colour-scheme following (SPEC 11.7, 22.1, 22.2).
 *
 * The trap this file guards is a real one: a provider that resolves a theme for
 * its own chrome and does not publish it, so `<MdvProvider theme="dark">` tints
 * the wrapper and leaves every chart on the light palette. The assertions are
 * therefore always in pairs — what the hook reports, *and* what the blocks
 * actually drew.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getBuiltinTheme } from '@mdv/themes';
import type { Theme } from '@mdv/core';
import { MdvDocument, MdvProvider, useMdvTheme } from '../src/index.js';
import { GOOD } from './fixtures.js';

function Probe(): React.ReactElement {
  const theme = useMdvTheme();
  return <span data-theme-name={theme.name} data-theme-scheme={theme.scheme} />;
}

function inProvider(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <MdvProvider unstyled renderPolicy="eager" {...props}>
      <Probe />
      <MdvDocument source={GOOD} />
    </MdvProvider>,
  );
}

/** The surface colour a theme paints behind a chart, as it appears in markup. */
function surfaceOf(theme: Theme): string {
  return `fill="${theme.tokens.surface}"`;
}

describe('useMdvTheme', () => {
  it('reports the light built-in by default', () => {
    const html = inProvider({});
    expect(html).toContain('data-theme-name="default"');
    expect(html).toContain('data-theme-scheme="light"');
    expect(html).toContain(surfaceOf(getBuiltinTheme('default')));
  });

  it('works with no provider at all', () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain('data-theme-name="default"');
  });
});

describe('colour-scheme following (SPEC 11.7)', () => {
  it('follows the host when the theme is auto', () => {
    const dark = inProvider({ theme: 'auto', prefersDark: true });
    expect(dark).toContain('data-theme-scheme="dark"');
    expect(dark).toContain('data-theme="dark"');
    expect(dark).toContain(surfaceOf(getBuiltinTheme('dark')));

    const light = inProvider({ theme: 'auto', prefersDark: false });
    expect(light).toContain('data-theme-scheme="light"');
    expect(light).toContain('data-theme="light"');
  });

  it('follows the host when no theme is named at all', () => {
    expect(inProvider({ prefersDark: true })).toContain('data-theme-scheme="dark"');
  });

  it('lets an explicit name overrule the host', () => {
    const html = inProvider({ theme: 'default', prefersDark: true });
    expect(html).toContain('data-theme-name="default"');
    expect(html).toContain(surfaceOf(getBuiltinTheme('default')));
  });

  it('lets config.colorScheme overrule the host', () => {
    const html = inProvider({ config: { colorScheme: 'dark' }, prefersDark: false });
    expect(html).toContain('data-theme-scheme="dark"');
  });
});

describe('a named theme reaches the blocks, not just the chrome', () => {
  it('paints the chart with the theme the hook reports', () => {
    const html = inProvider({ theme: 'dark' });
    expect(html).toContain('data-theme-name="dark"');
    expect(html).toContain(surfaceOf(getBuiltinTheme('dark')));
    expect(html).not.toContain(surfaceOf(getBuiltinTheme('default')));
  });

  it('accepts a fully resolved Theme object', () => {
    const theme = getBuiltinTheme('high-contrast');
    const html = inProvider({ theme });
    expect(html).toContain('data-theme-name="high-contrast"');
  });

  it('lets a per-block override win over the provider (SPEC 5.5 level 6)', () => {
    const html = renderToStaticMarkup(
      <MdvProvider unstyled renderPolicy="eager" theme="default">
        <MdvDocument source={'```mdv bar\ntheme: dark\nx: a\ny: b\n---\na,b\nQ1,1\n```\n'} />
      </MdvProvider>,
    );
    expect(html).toContain(surfaceOf(getBuiltinTheme('dark')));
  });
});

describe('nesting', () => {
  it('overrides locally', () => {
    const html = renderToStaticMarkup(
      <MdvProvider unstyled theme="default">
        <Probe />
        <MdvProvider unstyled theme="dark">
          <Probe />
        </MdvProvider>
      </MdvProvider>,
    );
    const names = [...html.matchAll(/data-theme-name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['default', 'dark']);
  });
});
