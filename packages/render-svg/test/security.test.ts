/**
 * Output sanitisation, end to end (SPEC 13.3, 13.5).
 *
 * Every string in these scenes is the kind of thing that arrives in a real
 * document: a category value, a series name, a title, an image URL. MDV treats
 * documents as untrusted input (SPEC 13), so the test is not "does the escaper
 * work" — that is `format.test.ts` — but "can a document reach the output with
 * markup intact through any node kind".
 *
 * The bar: the serialised string must contain **no** unescaped `<` other than
 * the ones this backend opened itself, and no `javascript:` anywhere.
 */

import { describe, expect, it } from 'vitest';
import { toSvgString } from '../src/index.js';
import { allowedAttributes, isAllowedAttribute } from '../src/allowlist.js';
import { serialiseVNode } from '../src/string.js';
import { el } from '../src/vnode.js';
import { FONT, a11y, root, scene } from './fixtures.js';

/** A payload that is live markup in every context that fails to escape it. */
const XSS = '<script>alert("xss")</script>';
const BREAKOUT = '"><script>alert(1)</script><text x="';

/** Tags this backend is allowed to open. Anything else is injected markup. */
const OWN_TAGS =
  /<\/?(?:svg|g|title|desc|defs|rect|line|path|circle|text|image|use|style|clipPath|pattern|linearGradient|radialGradient|symbol|stop)[\s/>]/g;

/** Assert that `svg` contains no element the backend did not open itself. */
function expectNoInjectedMarkup(svg: string): void {
  const stripped = svg.replace(OWN_TAGS, '');
  expect(stripped).not.toContain('<');
  expect(svg.toLowerCase()).not.toContain('javascript:');
  expect(svg.toLowerCase()).not.toContain('onload=');
  expect(svg.toLowerCase()).not.toContain('onerror=');
  expect(svg).not.toContain('<script');
}

describe('hostile text content cannot become markup', () => {
  it('escapes a script tag in a text node', () => {
    const svg = toSvgString(
      scene({
        root: root([
          {
            kind: 'text',
            x: 0,
            y: 0,
            text: XSS,
            font: FONT,
            fill: { kind: 'solid', color: '#000' },
            anchor: 'start',
            baseline: 'alphabetic',
          },
        ]),
      }),
    );
    expect(svg).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expectNoInjectedMarkup(svg);
  });

  it('escapes an attribute break-out attempt in a text node', () => {
    const svg = toSvgString(
      scene({
        root: root([
          {
            kind: 'text',
            x: 0,
            y: 0,
            text: BREAKOUT,
            font: FONT,
            fill: { kind: 'solid', color: '#000' },
            anchor: 'start',
            baseline: 'alphabetic',
          },
        ]),
      }),
    );
    expectNoInjectedMarkup(svg);
  });

  it('escapes the accessible name and description', () => {
    const svg = toSvgString(scene({ a11y: a11y({ name: XSS, desc: BREAKOUT }) }));
    expect(svg).toContain('<title id="mdv-0-title">&lt;script&gt;');
    expectNoInjectedMarkup(svg);
  });

  it('escapes a hostile series name in a hit region readout', () => {
    const svg = toSvgString(
      scene({
        hitIndex: [
          {
            id: 'r0',
            x: 0,
            y: 0,
            w: 24,
            h: 24,
            anchor: { x: 12, y: 12 },
            datumIndex: 0,
            readout: [{ label: XSS, value: BREAKOUT }],
          },
        ],
      }),
    );
    expectNoInjectedMarkup(svg);
  });

  it('escapes a hostile font family, which reaches an attribute value', () => {
    const svg = toSvgString(
      scene({
        root: root([
          {
            kind: 'text',
            x: 0,
            y: 0,
            text: 'ok',
            font: { family: '"><script>alert(1)</script>', size: 12 },
            fill: { kind: 'solid', color: '#000' },
            anchor: 'start',
            baseline: 'alphabetic',
          },
        ]),
      }),
    );
    expectNoInjectedMarkup(svg);
  });

  it('escapes a hostile colour string, which reaches a fill attribute', () => {
    const svg = toSvgString(
      scene({
        root: root([
          { kind: 'rect', x: 0, y: 0, w: 1, h: 1, fill: { kind: 'solid', color: BREAKOUT } },
        ]),
      }),
    );
    expectNoInjectedMarkup(svg);
  });

  it('escapes hostile image alt text in both the title and the aria-label', () => {
    const svg = toSvgString(
      scene({
        root: root([
          { kind: 'image', x: 0, y: 0, w: 8, h: 8, href: 'https://example.com/a.png', alt: XSS },
        ]),
      }),
    );
    expectNoInjectedMarkup(svg);
  });

  it('escapes a hostile a11y table label reaching the group label', () => {
    const svg = toSvgString(
      scene({ root: root([], { role: 'graphics-object', label: BREAKOUT }) }),
    );
    expectNoInjectedMarkup(svg);
  });
});

describe('URLs are restricted to safe schemes (MDV4010)', () => {
  const image = (href: string): string =>
    toSvgString(scene({ root: root([{ kind: 'image', x: 0, y: 0, w: 8, h: 8, href, alt: 'a' }]) }));

  it('drops a javascript: image reference but keeps the node and its alt text', () => {
    const svg = image('javascript:alert(1)');
    expect(svg).not.toContain('href');
    // SPEC 14.1 principle 2: the drawing stays structurally intact.
    expect(svg).toContain('<image');
    expect(svg).toContain('aria-label="a"');
    expectNoInjectedMarkup(svg);
  });

  it('drops data:text/html but keeps data:image', () => {
    expect(image('data:text/html,<script>alert(1)</script>')).not.toContain('href');
    expect(image('data:image/png;base64,iVBOR')).toContain('href="data:image/png;base64,iVBOR"');
  });

  it('drops a scheme hidden behind a newline', () => {
    expect(image('java\nscript:alert(1)')).not.toContain('href');
  });
});

describe('ids are generated, never content-derived (SPEC 13.3)', () => {
  it('refuses to emit an unsafe node id rather than mangling it', () => {
    const svg = toSvgString(
      scene({ root: root([{ kind: 'rect', id: 'a" onload="x', x: 0, y: 0, w: 1, h: 1 }]) }),
    );
    expect(svg).not.toContain('onload');
    expect(svg).toContain('<rect x="0"');
    expectNoInjectedMarkup(svg);
  });

  it('drops a use whose symbol reference is unusable rather than emitting a dangling href', () => {
    const svg = toSvgString(scene({ root: root([{ kind: 'use', ref: 'a b' }]) }));
    expect(svg).not.toContain('<use');
  });

  it('drops class tokens that are not plausible mdv-* names', () => {
    const svg = toSvgString(
      scene({ root: root([{ kind: 'rect', cls: 'mdv-bar "evil', x: 0, y: 0, w: 1, h: 1 }]) }),
    );
    expect(svg).toContain('class="mdv-bar"');
    expectNoInjectedMarkup(svg);
  });
});

describe('the attribute allowlist is enforced at the emitter (SPEC 13.3)', () => {
  it('throws rather than silently dropping an attribute off the list', () => {
    expect(() => serialiseVNode(el('rect', [['onload', 'alert(1)']]))).toThrow(/allowlist/);
    expect(() => serialiseVNode(el('rect', [['style', 'color:red']]))).toThrow(/allowlist/);
    expect(() => serialiseVNode(el('image', [['xlink:href', 'x']]))).toThrow(/allowlist/);
  });

  it('contains no event handler, style, filter or xlink attribute', () => {
    for (const name of allowedAttributes()) {
      expect(name.startsWith('on')).toBe(false);
      expect(name.startsWith('xlink:')).toBe(false);
    }
    expect(isAllowedAttribute('style')).toBe(false);
    expect(isAllowedAttribute('filter')).toBe(false);
    expect(isAllowedAttribute('onclick')).toBe(false);
  });

  it('is stably ordered, so an audit diff is readable', () => {
    expect(allowedAttributes()).toStrictEqual([...allowedAttributes()]);
  });
});

describe('CSP (SPEC 13.5): default-src none, no unsafe-inline', () => {
  it('emits no <script> and no inline event handler under any option', () => {
    for (const options of [undefined, { inlineStyles: true }, { classes: false }]) {
      expectNoInjectedMarkup(toSvgString(scene(), options));
    }
  });

  it('makes no external reference beyond the SVG namespace declaration', () => {
    const svg = toSvgString(scene());
    const urls = svg.match(/https?:\/\/[^"']+/g) ?? [];
    expect(urls).toStrictEqual(['http://www.w3.org/2000/svg']);
  });
});
