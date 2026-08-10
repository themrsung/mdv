/**
 * The `markdown.markdownItPlugins` integration (SPEC 29.2).
 *
 * VS Code supplies the markdown-it instance, so the tests supply a stand-in with
 * the same shape. What matters here is not markdown-it's behaviour but ours: a
 * fence that is ours becomes a figure, a fence that is not is left alone, and no
 * input makes the renderer throw — a throw from a renderer rule blanks the whole
 * Markdown preview.
 */

import { describe, expect, it } from 'vitest';

import { createMarkdownItExtension, type MarkdownItLike } from '../src/markdownit.js';
import { DEFAULT_SETTINGS, ONE_CHART, TWO_CHARTS } from './fixtures.js';

type Rule = NonNullable<MarkdownItLike['renderer']['rules'][string]>;

interface Token {
  info: string;
  content: string;
  map: readonly [number, number] | null;
}

/** A markdown-it stand-in that records what the extension did to it. */
function fakeMarkdownIt(): {
  md: MarkdownItLike;
  coreRules: { name: string; run: (state: { src: string; env: unknown }) => void }[];
  fallbacks: number;
  render(token: Token, env: unknown): string;
} {
  const harness = {
    coreRules: [] as { name: string; run: (state: { src: string; env: unknown }) => void }[],
    fallbacks: 0,
    md: undefined as unknown as MarkdownItLike,
    render(token: Token, env: unknown): string {
      const rule = harness.md.renderer.rules['fence'];
      if (rule === undefined) throw new Error('fence rule was not installed');
      return rule([token], 0, {}, env, {
        renderToken: () => '<pre>default</pre>',
      });
    },
  };

  const defaultFence: Rule = () => {
    harness.fallbacks += 1;
    return '<pre>default</pre>';
  };

  harness.md = {
    core: {
      ruler: {
        push(name, rule): void {
          harness.coreRules.push({ name, run: rule });
        },
      },
    },
    renderer: { rules: { fence: defaultFence } },
    utils: { escapeHtml: (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;') },
  };
  return harness;
}

/** Feed a document through the core rule, the way markdown-it would. */
function withSource(harness: ReturnType<typeof fakeMarkdownIt>, source: string): unknown {
  const env: Record<string, unknown> = {};
  for (const rule of harness.coreRules) rule.run({ src: source, env });
  return env;
}

function extend(harness: ReturnType<typeof fakeMarkdownIt>): void {
  const extendMarkdownIt = createMarkdownItExtension(
    () => DEFAULT_SETTINGS,
    () => 'light',
  );
  expect(extendMarkdownIt(harness.md)).toBe(harness.md);
}

/** The token markdown-it would produce for the nth fence of `source`. */
function fenceToken(source: string, nth: number): Token {
  const lines = source.split('\n');
  const opens: number[] = [];
  let inside = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.startsWith('```') === true) {
      if (!inside) opens.push(i);
      inside = !inside;
    }
  }
  const start = opens[nth];
  if (start === undefined) throw new Error(`no fence #${String(nth)}`);
  let end = start + 1;
  while (end < lines.length && lines[end]?.startsWith('```') !== true) end += 1;
  return {
    info: (lines[start] ?? '').slice(3),
    content: `${lines.slice(start + 1, end).join('\n')}\n`,
    map: [start, end + 1],
  };
}

describe('createMarkdownItExtension', () => {
  it('installs one core rule and keeps the host’s fence rule as the fallback', () => {
    const harness = fakeMarkdownIt();
    extend(harness);

    expect(harness.coreRules.map((r) => r.name)).toEqual(['mdv_capture_source']);
    expect(typeof harness.md.renderer.rules['fence']).toBe('function');
  });

  it('leaves a fence that is not ours to the host', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const env = withSource(harness, '```ts\nconst x = 1;\n```\n');

    const html = harness.render({ info: 'ts', content: 'const x = 1;\n', map: [0, 3] }, env);
    expect(html).toBe('<pre>default</pre>');
    expect(harness.fallbacks).toBe(1);
  });

  it('does not mistake a fence whose info merely starts with the letters mdv', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const html = harness.render({ info: 'mdvish', content: 'x\n', map: [0, 3] }, {});
    expect(html).toBe('<pre>default</pre>');
  });

  it('renders our fence as a labelled figure', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const env = withSource(harness, ONE_CHART);

    const html = harness.render(fenceToken(ONE_CHART, 0), env);
    expect(html).toContain('<div class="mdv-block" data-mdv-type="bar"');
    expect(html).toContain('role="figure"');
    expect(html).toContain('aria-label="Revenue by quarter"');
    expect(html).toContain('<svg');
    expect(html).not.toContain('<script');
    expect(harness.fallbacks).toBe(0);
  });

  it('gives a fence the whole document, so `@dataset` and front matter apply', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const env = withSource(harness, TWO_CHARTS);

    // The bar chart is the second fence and carries no data of its own: it can
    // only draw if the plugin ran the *document*, not the token.
    const html = harness.render(fenceToken(TWO_CHARTS, 1), env);
    expect(html).toContain('aria-label="Revenue by quarter"');
    expect(html).toContain('<svg');
  });

  it('falls back for a fence that draws nothing, such as a dataset', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const env = withSource(harness, TWO_CHARTS);

    const html = harness.render(fenceToken(TWO_CHARTS, 0), env);
    expect(html).toBe('<pre>default</pre>');
  });

  it('still draws when the host renders a token with no source and no map', () => {
    const harness = fakeMarkdownIt();
    extend(harness);

    const token = fenceToken(ONE_CHART, 0);
    const html = harness.render({ ...token, map: null }, undefined);
    expect(html).toContain('<svg');
    expect(html).toContain('data-mdv-type="bar"');
  });

  it('reconstructs a fence whose body contains a run of backticks', () => {
    const harness = fakeMarkdownIt();
    extend(harness);

    const token: Token = {
      info: 'mdv bar',
      content: 'title: "```"\nx: quarter\ny: revenue\n---\nquarter | revenue\nQ1 | 1240\n',
      map: null,
    };
    const html = harness.render(token, undefined);
    expect(html).toContain('<svg');
  });

  it('escapes the label rather than letting a title close the attribute', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const source = ONE_CHART.replace(
      'title: Revenue by quarter',
      'title: \'A & B" onload="alert(1)\'',
    );
    const env = withSource(harness, source);

    const html = harness.render(fenceToken(source, 0), env);
    const openTag = html.slice(0, html.indexOf('>') + 1);

    // The quote in the title must not be able to close `aria-label` and start
    // an attribute of its own, even though this harness's `escapeHtml` — like a
    // hypothetical thrifty host's — only handles `&` and `<`.
    expect(openTag).toContain('&quot; onload=&quot;');
    // The escaped text still reads `onload=&quot;`; what must not exist is an
    // attribute, i.e. `onload=` followed by a real quote.
    expect(openTag).not.toMatch(/\sonload="/);
    // class, data-mdv-type, role, aria-label — four attributes, eight quotes.
    expect(openTag.match(/"/g)).toHaveLength(8);
  });

  it('falls back instead of throwing when the settings reader throws', () => {
    const harness = fakeMarkdownIt();
    const extendMarkdownIt = createMarkdownItExtension(
      () => {
        throw new Error('settings unavailable');
      },
      () => 'light',
    );
    extendMarkdownIt(harness.md);
    const env = withSource(harness, ONE_CHART);

    expect(() => harness.render(fenceToken(ONE_CHART, 0), env)).not.toThrow();
    expect(harness.render(fenceToken(ONE_CHART, 0), env)).toBe('<pre>default</pre>');
  });

  it('survives a host that has no fence rule of its own', () => {
    const harness = fakeMarkdownIt();
    delete harness.md.renderer.rules['fence'];
    extend(harness);

    const html = harness.render({ info: 'ts', content: 'x\n', map: [0, 3] }, {});
    expect(html).toBe('<pre>default</pre>'); // self.renderToken, from the harness
  });

  it('renders the same document twice identically', () => {
    const harness = fakeMarkdownIt();
    extend(harness);
    const env = withSource(harness, TWO_CHARTS);

    const once = harness.render(fenceToken(TWO_CHARTS, 1), env);
    const twice = harness.render(fenceToken(TWO_CHARTS, 1), env);
    expect(twice).toBe(once);
  });
});
