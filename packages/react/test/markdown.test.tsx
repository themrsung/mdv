/**
 * Markdown rendering, component overrides, and output sanitisation (SPEC 13.3).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ReactNode } from 'react';
import { parse } from '@mdv/parser';
import { MdvDocument, MdvProvider, renderMarkdown, type MdastNode } from '../src/index.js';

function render(source: string, components?: Record<string, unknown>): string {
  return renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={source} {...(components ? { components } : {})} />
    </MdvProvider>,
  );
}

describe('CommonMark and GFM', () => {
  it('renders headings, paragraphs and inline marks', () => {
    const html = render('# One\n\n## Two\n\nA *b* **c** `d` ~~e~~.\n');
    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<h2>Two</h2>');
    expect(html).toContain('<em>b</em>');
    expect(html).toContain('<strong>c</strong>');
    expect(html).toContain('<code>d</code>');
    expect(html).toContain('<del>e</del>');
  });

  it('renders lists, including GFM task items', () => {
    const html = render('- a\n- b\n\n1. one\n\n- [x] done\n- [ ] not\n');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled=""');
  });

  it('renders blockquotes, rules and fenced code', () => {
    const html = render('> quoted\n\n---\n\n```js\nconst a = 1;\n```\n');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<hr/>');
    expect(html).toContain('<pre><code class="language-js">');
    expect(html).toContain('const a = 1;');
  });

  it('renders a GFM table with column scopes and alignment classes', () => {
    const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |\n');
    expect(html).toContain('<thead>');
    expect(html).toContain('<th class="mdv-align-left" scope="col">a</th>');
    expect(html).toContain('<th class="mdv-align-right" scope="col">b</th>');
    expect(html).toContain('<td class="mdv-align-left">1</td>');
  });

  it('does not render front matter as content', () => {
    const html = render('---\ntitle: T\n---\n\nBody\n');
    expect(html).toContain('<p>Body</p>');
    expect(html).not.toContain('title: T');
  });
});

describe('links and images (SPEC 13.3)', () => {
  it('marks external links noopener noreferrer', () => {
    const html = render('[x](https://example.com/)');
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('leaves a same-document fragment alone', () => {
    const html = render('[x](#anchor)');
    expect(html).toContain('href="#anchor"');
    expect(html).not.toContain('noopener');
  });

  it('strips javascript: and keeps the label', () => {
    const html = render('[click](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click');
  });

  it('strips vbscript:', () => {
    expect(render('[a](vbscript:msgbox)')).not.toContain('vbscript');
  });

  it('cannot be tricked into a javascript: URL with an embedded NUL', () => {
    // The parser replaces NUL with U+FFFD (SPEC 3.2) before the URL is ever
    // formed, so what reaches `sanitiseUrl` has no scheme a browser will
    // honour. What matters is that nothing executable survives, in either
    // spelling, and that no raw NUL reaches the markup.
    const html = render('[a](java\u0000script:alert(1))');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toContain('\u0000');
  });

  it('renders an image, and degrades a refused one to its alt text', () => {
    expect(render('![alt](https://example.com/a.png)')).toContain('alt="alt"');
    const refused = render('![alt](javascript:alert(1))');
    expect(refused).not.toContain('<img');
    expect(refused).toContain('alt');
  });
});

describe('raw HTML (SPEC 13.4)', () => {
  it('is inert: escaped text, never inserted', () => {
    const html = render('<script>alert(1)</script>\n\nAfter\n');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('After');
  });

  it('stays inert even when the parser was told to keep the nodes', () => {
    const html = renderToStaticMarkup(
      <MdvProvider renderPolicy="eager" unstyled config={{ security: { allowHtml: true } }}>
        <MdvDocument source={'<b onclick="x()">bold</b>\n'} />
      </MdvProvider>,
    );
    // The literal text `onclick` is *in* the output, because the whole tag is
    // shown as text. What must not exist is a `<b>` element with a handler on
    // it: no element, no attribute, no live event.
    expect(html).not.toContain('<b ');
    expect(html).not.toContain('onclick="x()"');
    expect(html).toContain('&lt;b onclick=&quot;x()&quot;&gt;bold&lt;/b&gt;');
  });
});

describe('component overrides (SPEC 22.1)', () => {
  it('replaces the element for a tag', () => {
    const Heading = ({ children }: { children?: ReactNode }): ReactNode =>
      createElement('h2', { className: 'custom' }, children);
    const html = render('## Two\n', { h2: Heading });
    expect(html).toContain('<h2 class="custom">Two</h2>');
  });

  it('replaces links, so a router can take them over', () => {
    const Link = (props: { href?: string; children?: ReactNode }): ReactNode =>
      createElement('a', { 'data-router': '', href: props.href }, props.children);
    const html = render('[x](https://example.com/)', { a: Link });
    expect(html).toContain('data-router=""');
  });

  it('leaves untouched tags alone', () => {
    const html = render('# One\n\n## Two\n', { h2: 'section' });
    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<section>Two</section>');
  });
});

describe('renderMarkdown directly', () => {
  it('renders children of an unknown node rather than swallowing them', () => {
    const node: MdastNode = {
      type: 'somePluginContainer',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'inside' }] }],
    };
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        renderMarkdown({ components: {}, renderBlock: () => null, renderError: () => null }, [
          node,
        ]),
      ),
    );
    expect(html).toContain('<p>inside</p>');
  });

  it('clamps a heading depth rather than emitting <h9>', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        renderMarkdown({ components: {}, renderBlock: () => null, renderError: () => null }, [
          { type: 'heading', depth: 9, children: [{ type: 'text', value: 'deep' }] },
        ]),
      ),
    );
    expect(html).toContain('<h6>deep</h6>');
  });

  it('substitutes a visual block through the host callback', () => {
    const doc = parse('```mdv bar\nx: a\n---\na\n1\n```\n');
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        renderMarkdown(
          {
            components: {},
            renderBlock: (_node, key) => createElement('span', { key }, 'BLOCK'),
            renderError: () => null,
          },
          doc.children as unknown as MdastNode[],
        ),
      ),
    );
    expect(html).toBe('<div><span>BLOCK</span></div>');
  });
});
