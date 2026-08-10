/**
 * Server rendering (SPEC 22.3).
 *
 * > **Server rendering** works: `resolveSync` + `TableMetrics` + SVG-string
 * > output. Hydration attaches interaction only; markup MUST match, which the
 * > deterministic id scheme guarantees.
 *
 * The suite runs in Vitest's `node` environment, so there is no `document` and
 * no `window`. A render that reached for either would throw here rather than
 * quietly working on the developer's machine and failing on the server.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { StrictMode } from 'react';
import { MdvBlock, MdvDocument, MdvProvider, createCaches } from '../src/index.js';
import { EXTERNAL, GOOD } from './fixtures.js';

describe('there is no DOM in this environment', () => {
  it('has no document and no window', () => {
    // If this ever fails, every other assertion in this file has stopped
    // proving what it claims to prove.
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
  });
});

describe('MdvDocument on the server', () => {
  const render = (): string =>
    renderToStaticMarkup(
      <MdvProvider renderPolicy="eager" unstyled>
        <MdvDocument source={GOOD} />
      </MdvProvider>,
    );

  it('renders the markdown and the chart', () => {
    const html = render();
    expect(html).toContain('<h1>Revenue</h1>');
    expect(html).toContain('<strong>prose</strong>');
    expect(html).toContain('<svg');
    expect(html).toContain('Revenue by quarter');
  });

  it('emits the accessible name and description (SPEC 12.1, 12.2)', () => {
    const html = render();
    expect(html).toMatch(/role="img"/);
    expect(html).toMatch(/aria-labelledby="[^"]*-title [^"]*-desc"/);
    expect(html).toMatch(/<title id="[^"]*-title">Revenue by quarter<\/title>/);
    expect(html).toMatch(/<desc id="[^"]*-desc">Bar chart\./);
  });

  it('carries the document language and the resolved scheme', () => {
    const html = render();
    expect(html).toContain('lang="en"');
    expect(html).toContain('data-theme="light"');
  });

  it('is byte-identical across runs (SPEC 24.3)', () => {
    // Fresh providers each time, so nothing is shared but the source.
    expect(render()).toBe(render());
  });

  it('is byte-identical across two independent cache sets', () => {
    const withCaches = (): string =>
      renderToStaticMarkup(
        <MdvProvider renderPolicy="eager" unstyled caches={createCaches()}>
          <MdvDocument source={GOOD} />
        </MdvProvider>,
      );
    expect(withCaches()).toBe(withCaches());
  });

  it('produces hydratable markup', () => {
    // `renderToString` is the hydration entry point; it must not throw, and it
    // must agree with the static form on everything but React's own comments.
    const hydratable = renderToString(
      <MdvProvider renderPolicy="eager" unstyled>
        <MdvDocument source={GOOD} />
      </MdvProvider>,
    );
    expect(hydratable).toContain('<svg');
    expect(hydratable.replace(/<!--.*?-->/g, '')).toBe(render());
  });

  it('is StrictMode-clean on the server', () => {
    const strict = renderToStaticMarkup(
      <StrictMode>
        <MdvProvider renderPolicy="eager" unstyled>
          <MdvDocument source={GOOD} />
        </MdvProvider>
      </StrictMode>,
    );
    expect(strict).toBe(render());
  });

  it('emits the stylesheet unless asked not to', () => {
    const styled = renderToStaticMarkup(
      <MdvProvider renderPolicy="eager">
        <MdvDocument source={GOOD} />
      </MdvProvider>,
    );
    expect(styled).toContain('<style data-mdv-styles="">');
    expect(styled).toContain('.mdv-root');
    expect(render()).not.toContain('<style');
  });
});

describe('external data on the server', () => {
  it('renders a labelled placeholder rather than an empty frame (SPEC 6.4)', () => {
    const html = renderToStaticMarkup(
      <MdvProvider renderPolicy="eager" unstyled>
        <MdvDocument source={EXTERNAL} />
      </MdvProvider>,
    );
    expect(html).toContain('class="mdv-placeholder"');
    expect(html).toContain('aria-label="External — loading data"');
    expect(html).toContain('aria-busy="true"');
    // The placeholder is the right size, so hydration does not shift the page.
    expect(html).toContain('data-mdv-height="300"');
  });
});

describe('MdvBlock on the server', () => {
  it('renders a standalone chart with no provider', () => {
    const html = renderToStaticMarkup(
      <MdvBlock
        type="bar"
        attrs={{ x: 'quarter', y: 'revenue', title: 'Signups' }}
        data={[
          { quarter: 'Q1', revenue: 10 },
          { quarter: 'Q2', revenue: 20 },
        ]}
        height={280}
      />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('Signups');
    expect(html).toContain('height="280"');
  });

  it('agrees with the equivalent fenced block', () => {
    const fromProps = renderToStaticMarkup(
      <MdvBlock
        type="bar"
        attrs={{ title: 'Same', x: 'quarter', y: 'revenue', width: 800, height: 300 }}
        data={[
          { quarter: 'Q1', revenue: 1240 },
          { quarter: 'Q2', revenue: 1500 },
        ]}
      />,
    );
    const fromSource = renderToStaticMarkup(
      <MdvProvider renderPolicy="eager" unstyled>
        <MdvDocument
          source={
            '```mdv bar\ntitle: Same\nx: quarter\ny: revenue\nwidth: 800\nheight: 300\n---\n' +
            'quarter,revenue\nQ1,1240\nQ2,1500\n```\n'
          }
        />
      </MdvProvider>,
    );

    // Both must contain the same drawing. The wrappers differ (a document has a
    // root, a lone block does not), so compare the `<svg>` subtree.
    const svgOf = (html: string): string => {
      const start = html.indexOf('<svg');
      const end = html.lastIndexOf('</svg>') + '</svg>'.length;
      return html.slice(start, end);
    };
    expect(svgOf(fromProps)).toBe(svgOf(fromSource));
  });
});
