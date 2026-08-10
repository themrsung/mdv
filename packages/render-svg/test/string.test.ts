/**
 * Scene → SVG string (SPEC 23.1, 23.3).
 *
 * The snapshots here are the golden files. They are inline rather than in
 * `__snapshots__` on purpose: a reviewer has to be able to read the expected
 * markup next to the scene that produced it, because "the attribute order
 * changed" and "the chart changed" look identical in a diff otherwise.
 */

import { describe, expect, it } from 'vitest';
import { toSvgString } from '../src/index.js';
import { buildScene, pathData } from '../src/build.js';
import { countNodes } from '../src/vnode.js';
import {
  CIRCLE,
  DEFS,
  IMAGE,
  LINE,
  PATH,
  PLAIN_RECT,
  RECT,
  ROTATED_TEXT,
  TEXT,
  USE,
  kitchenSink,
  root,
  scene,
} from './fixtures.js';

/** Render one node in an otherwise empty scene and return just the root group. */
function draw(node: Parameters<typeof root>[0][number]): string {
  const svg = toSvgString(scene({ root: root([node]) }));
  const open = svg.indexOf('<g>');
  return svg.slice(open, svg.indexOf('</g>') + 4);
}

describe('the root <svg> (SPEC 23.1)', () => {
  it('carries role, aria-labelledby, viewBox and preserveAspectRatio', () => {
    expect(toSvgString(scene())).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" class="mdv-root mdv-chart" width="320"' +
        ' height="180" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet" role="img"' +
        ' aria-labelledby="mdv-0-title mdv-0-desc" data-mdv-kind="bar">' +
        '<title id="mdv-0-title">Revenue by quarter</title>' +
        '<desc id="mdv-0-desc">A bar chart of revenue for four quarters.</desc>' +
        '<g></g></svg>',
    );
  });

  it('emits a real <title> and <desc> that aria-labelledby points at', () => {
    const svg = toSvgString(scene());
    expect(svg).toContain('<title id="mdv-0-title">');
    expect(svg).toContain('<desc id="mdv-0-desc">');
    expect(svg).toContain('aria-labelledby="mdv-0-title mdv-0-desc"');
  });

  it('labels by the title alone when there is no description', () => {
    const s = scene();
    const { desc: _drop, ...rest } = s.a11y;
    const svg = toSvgString({ ...s, a11y: rest });
    expect(svg).toContain('aria-labelledby="mdv-0-title"');
    expect(svg).not.toContain('<desc');
  });

  it('uses role="figure" when the block has a caption', () => {
    const s = scene();
    expect(toSvgString({ ...s, a11y: { ...s.a11y, role: 'figure' } })).toContain('role="figure"');
  });

  it('carries xml:lang when the document language differs from the host', () => {
    const s = scene();
    expect(toSvgString({ ...s, a11y: { ...s.a11y, lang: 'ko' } })).toContain('xml:lang="ko"');
  });

  it('namespaces every generated id with the block id', () => {
    const s = scene({ meta: { ...scene().meta, blockId: 'mdv-7' } });
    const svg = toSvgString(s);
    expect(svg).toContain('id="mdv-7-title"');
    expect(svg).not.toContain('mdv-0');
  });

  it('emits the background as a surface rect only when the scene has one', () => {
    expect(toSvgString(scene())).not.toContain('mdv-surface');
    const withBg = toSvgString(scene({ background: { kind: 'solid', color: '#fcfcfb' } }));
    expect(withBg).toContain(
      '<rect class="mdv-surface" x="0" y="0" width="320" height="180" fill="#fcfcfb" aria-hidden="true"/>',
    );
  });
});

describe('every node kind serialises (SPEC 17.3 invariant 3: backends are total)', () => {
  it('rect with per-corner radii becomes a path, square at the baseline', () => {
    // SPEC 11.4: 4 px rounded at the data end, square at the baseline. SVG's
    // rx/ry are uniform, so the per-corner form has to be an explicit path.
    expect(draw(RECT)).toBe(
      '<g><path id="mdv-0-bar-0" class="mdv-mark mdv-bar"' +
        ' d="M16 40.5L32 40.5A4 4 0 0 1 36 44.5L36 140.75L12 140.75L12 44.5A4 4 0 0 1 16 40.5Z"' +
        ' fill="#2a78d6"/></g>',
    );
  });

  it('rect without radii stays a rect, and fill opacity is separate from the colour', () => {
    expect(draw(PLAIN_RECT)).toBe(
      '<g><rect x="0" y="0" width="10" height="10" fill="#2a78d6" fill-opacity="0.5"/></g>',
    );
  });

  it('line carries its stroke and nothing else', () => {
    expect(draw(LINE)).toBe(
      '<g><line class="mdv-grid" x1="0" y1="0.5" x2="320" y2="0.5" stroke="#e1e0d9" stroke-width="1"/></g>',
    );
  });

  it('path emits structured commands directly, with round join and cap', () => {
    expect(draw(PATH)).toBe(
      '<g><path class="mdv-line" d="M0 100L40 60C60 40 80 40 100 60Q120 80 140 70A10 10 0 1 0 160 70Z"' +
        ' fill="none" stroke="#2a78d6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>',
    );
  });

  it('circle carries the 2 px surface ring', () => {
    expect(draw(CIRCLE)).toBe(
      '<g><circle cx="160" cy="90" r="4" fill="#eb6834" stroke="#fcfcfb" stroke-width="2"/></g>',
    );
  });

  it('text is real <text> with tabular figures where asked', () => {
    expect(draw(TEXT)).toBe(
      '<g><text x="8" y="16" text-anchor="middle" dominant-baseline="central"' +
        ' font-family="system-ui, -apple-system, &quot;Segoe UI&quot;, sans-serif" font-size="12"' +
        ' font-variant-numeric="tabular-nums" fill="#0b0b0b">Q1</text></g>',
    );
  });

  it('rotated text rotates about its own anchor point', () => {
    expect(draw(ROTATED_TEXT)).toContain('transform="rotate(-45 40 170)"');
    expect(draw(ROTATED_TEXT)).toContain('text-anchor="end"');
    // `alphabetic` is the SVG default: omitted rather than restated.
    expect(draw(ROTATED_TEXT)).not.toContain('dominant-baseline');
    expect(draw(ROTATED_TEXT)).toContain('font-weight="600"');
    expect(draw(ROTATED_TEXT)).toContain('font-style="italic"');
    expect(draw(ROTATED_TEXT)).toContain('letter-spacing="0.2"');
  });

  it('image keeps its alt as both a <title> and aria-label', () => {
    expect(draw(IMAGE)).toBe(
      '<g><image x="4" y="4" width="32" height="32" href="https://example.com/logo.png"' +
        ' aria-label="Logo"><title>Logo</title></image></g>',
    );
  });

  it('use references a symbol by namespaced id', () => {
    expect(draw(USE)).toBe('<g><use href="#mdv-0-dot" x="100" y="50" fill="#1baf7a"/></g>');
  });

  it('group carries transform, clip, opacity and its a11y role', () => {
    const svg = toSvgString(
      scene({
        defs: DEFS,
        root: root([
          {
            kind: 'group',
            transform: { kind: 'translate', x: 40, y: 8 },
            clip: 'plot',
            opacity: 0.9,
            role: 'graphics-object',
            label: 'Plot area',
            children: [],
          },
        ]),
      }),
    );
    expect(svg).toContain(
      '<g transform="translate(40 8)" clip-path="url(#mdv-0-plot)" opacity="0.9"' +
        ' role="graphics-object" aria-label="Plot area"></g>',
    );
  });

  it('spells each transform kind', () => {
    const t = (transform: Parameters<typeof root>[1]): string =>
      toSvgString(scene({ root: root([], transform) }));
    expect(t({ transform: { kind: 'scale', x: 2, y: 0.5 } })).toContain('transform="scale(2 0.5)"');
    expect(t({ transform: { kind: 'rotate', angle: 90 } })).toContain('transform="rotate(90)"');
    expect(t({ transform: { kind: 'rotate', angle: 90, cx: 10, cy: 20 } })).toContain(
      'transform="rotate(90 10 20)"',
    );
    expect(t({ transform: { kind: 'matrix', a: 1, b: 0, c: 0, d: 1, e: 5, f: 6 } })).toContain(
      'transform="matrix(1 0 0 1 5 6)"',
    );
  });
});

describe('defs (SPEC 20: gradients, clips, texture patterns)', () => {
  const svg = toSvgString(kitchenSink());

  it('hoists every def into one <defs> block with namespaced ids', () => {
    expect(svg).toContain('<defs>');
    for (const id of ['grad-l', 'grad-r', 'tex-45', 'plot', 'dot']) {
      expect(svg).toContain(`id="mdv-0-${id}"`);
    }
  });

  it('emits a linear gradient with its stops in order', () => {
    expect(svg).toContain(
      '<linearGradient id="mdv-0-grad-l" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#cde2fb"/>' +
        '<stop offset="1" stop-color="#0d366b" stop-opacity="0.9"/>' +
        '</linearGradient>',
    );
  });

  it('maps the units enum to SVG spelling', () => {
    expect(svg).toContain('gradientUnits="userSpaceOnUse"');
    // objectBoundingBox is the SVG default and is left implicit.
    expect(svg).not.toContain('gradientUnits="objectBoundingBox"');
  });

  it('emits a texture tile as a pattern (SPEC 12.6)', () => {
    expect(svg).toContain('<pattern id="mdv-0-tex-45"');
    expect(svg).toContain('patternUnits="userSpaceOnUse"');
    expect(svg).toContain('patternTransform="rotate(45)"');
  });

  it('emits a clip path from structured commands', () => {
    expect(svg).toContain(
      '<clipPath id="mdv-0-plot"><path d="M0 0L320 0L320 180L0 180Z"/></clipPath>',
    );
  });

  it('paints a pattern fill over its background colour, since SVG has no fill stack', () => {
    // A texture is inked tone-on-tone over the series colour (SPEC 12.6), so the
    // backing shape carries the colour and the tile goes on top.
    expect(svg).toContain('fill="#2a78d6"');
    expect(svg).toContain('fill="url(#mdv-0-tex-45)"');
  });

  it('references a gradient paint by url(#…)', () => {
    expect(svg).toContain('fill="url(#mdv-0-grad-l)"');
  });

  it('omits <defs> entirely when the scene has none', () => {
    expect(toSvgString(scene())).not.toContain('<defs>');
  });
});

describe('the interaction overlay (SPEC 23.1)', () => {
  const svg = toSvgString(kitchenSink());

  it('emits one transparent rect per hit region, straight from hitIndex', () => {
    expect(svg).toContain('<g class="mdv-interaction" role="list" aria-label="Data points">');
    expect(svg).toContain(
      '<rect id="mdv-0-hit-r0" class="mdv-hit" x="10" y="20" width="24" height="24"' +
        ' fill="none" pointer-events="all" role="graphics-symbol" aria-label="1,200, Revenue"' +
        ' data-mdv-region="r0" data-mdv-group="Revenue" data-mdv-series="Revenue"' +
        ' data-mdv-datum="0" data-mdv-mark="mdv-0-bar-0"/>',
    );
  });

  it('makes the chart a single tab stop when it has hit regions', () => {
    expect(svg).toContain('tabindex="0"');
    expect(toSvgString(scene())).not.toContain('tabindex');
  });

  it('drops the overlay when interaction is off, for static output', () => {
    const off = toSvgString(kitchenSink(), { interaction: false });
    expect(off).not.toContain('mdv-interaction');
    expect(off).not.toContain('tabindex');
    // The drawing itself is untouched.
    expect(off).toContain('<path id="mdv-0-bar-0"');
  });

  it('announces the same readout that hover shows, value first', () => {
    expect(svg).toContain('aria-label="900, Cost; Q2"');
  });
});

describe('determinism (SPEC 24.3 rule 4)', () => {
  it('is byte-identical across repeated renders', () => {
    const s = kitchenSink();
    const first = toSvgString(s);
    for (let i = 0; i < 20; i += 1) expect(toSvgString(kitchenSink())).toBe(first);
    expect(toSvgString(s)).toBe(first);
  });

  it('does not depend on object key order in the scene', () => {
    // Two structurally identical rects written with their fields in opposite
    // orders must serialise the same (SPEC 24.3 rule 5).
    const a = toSvgString(scene({ root: root([{ kind: 'rect', x: 1, y: 2, w: 3, h: 4 }]) }));
    const b = toSvgString(scene({ root: root([{ h: 4, w: 3, y: 2, x: 1, kind: 'rect' }]) }));
    expect(a).toBe(b);
  });

  it('rounds to 3 decimals by default and honours an explicit precision', () => {
    const s = scene({ root: root([{ kind: 'rect', x: 1.23456, y: 0, w: 1, h: 1 }]) });
    expect(toSvgString(s)).toContain('x="1.235"');
    expect(toSvgString(s, { precision: 1 })).toContain('x="1.2"');
    expect(toSvgString(s, { precision: 0 })).toContain('x="1"');
  });

  it('normalises -0 to 0 everywhere it can appear', () => {
    const s = scene({
      root: root([{ kind: 'line', x1: -0, y1: -0, x2: -0.0001, y2: 1, stroke: LINE.stroke }]),
    });
    const svg = toSvgString(s);
    expect(svg).toContain('x1="0" y1="0" x2="0" y2="1"');
    // No attribute value anywhere may begin with a negative zero. (A bare
    // `-0` substring test would trip over the `mdv-0-…` id namespace.)
    expect(svg).not.toMatch(/="-0[">\s]/);
  });

  it('emits no whitespace between elements, because it is significant in <text>', () => {
    const svg = toSvgString(kitchenSink());
    expect(svg).not.toMatch(/>\s+</);
    expect(svg).not.toContain('\n');
  });
});

describe('output options', () => {
  it('omits class tokens when classes are off', () => {
    const svg = toSvgString(kitchenSink(), { classes: false });
    expect(svg).not.toContain('class=');
  });

  it('inlines the stylesheet inside the <svg>, after the opening tag', () => {
    const svg = toSvgString(scene(), { inlineStyles: true });
    expect(svg).toMatch(/^<svg [^>]*><style>/);
    expect(svg).toContain('</style><title');
  });

  it('prepends an XML declaration for a standalone file', () => {
    expect(toSvgString(scene(), { standalone: true })).toMatch(
      /^<\?xml version="1\.0" encoding="UTF-8"\?><svg /,
    );
  });

  it('accepts an explicit id prefix and falls back to a safe one', () => {
    expect(toSvgString(scene(), { idPrefix: 'chart1' })).toContain('id="chart1-title"');
    // An unusable prefix must not produce an unusable `aria-labelledby`.
    expect(toSvgString(scene(), { idPrefix: '0 bad' })).toContain('id="mdv-title"');
  });
});

describe('pathData emits commands directly (SPEC 20: no d-string parser)', () => {
  it('spells every command type', () => {
    expect(pathData(PATH.d, 3)).toBe(
      'M0 100L40 60C60 40 80 40 100 60Q120 80 140 70A10 10 0 1 0 160 70Z',
    );
  });

  it('emits arc flags as bare 0/1, the only spelling the grammar accepts', () => {
    expect(
      pathData(
        [{ c: 'A', rx: 1, ry: 2, rotate: 30, largeArc: false, sweep: true, x: 3, y: 4 }],
        3,
      ),
    ).toBe('A1 2 30 0 1 3 4');
  });

  it('rounds coordinates at the requested precision', () => {
    expect(pathData([{ c: 'M', x: 1.23456, y: -0.00001 }], 3)).toBe('M1.235 0');
  });

  it('produces an empty string for an empty command list', () => {
    expect(pathData([], 3)).toBe('');
  });
});

describe('the virtual tree', () => {
  it('has one node per drawn element, with no stray wrappers', () => {
    // svg + title + desc + g(root) = 4 for the empty scene.
    expect(countNodes(buildScene(scene()))).toBe(4);
  });
});
