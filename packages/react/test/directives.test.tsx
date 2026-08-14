/**
 * MDV directives on screen (SPEC 9.1, 9.2).
 *
 * The seven block directives and the six inline ones, checked through the whole
 * pipeline rather than against the renderer in isolation: the numbering pre-pass
 * and the dataset registry are half of what these elements say, and a directive
 * that renders correctly from a hand-built node but not from a parsed document
 * is not rendering correctly.
 *
 * Two rules run underneath most of what follows:
 *
 *   - Nothing that is not a `style` attribute (SPEC 13.5) — the stylesheet reads
 *     `data-mdv-*` and custom properties, never an inline `style`, because a CSP
 *     without `'unsafe-inline'` would drop it.
 *   - Colour is never the only signal (SPEC 16.2) — a callout carries its word,
 *     a delta its arrow *and* its sign, a badge its icon.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MdvDocument, MdvProvider } from '../src/index.js';

function render(source: string): string {
  return renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={source} />
    </MdvProvider>,
  );
}

/** A document whose front matter carries a dataset the inline readers can hit. */
function withData(body: string): string {
  return [
    '```mdv dataset id=sales',
    '---',
    'region | units | revenue',
    'APAC   |  1204 |  482000',
    'EMEA   |   980 |  414000',
    '```',
    '',
    body,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Block directives (SPEC 9.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A screen has no pages, so the marker's whole job is to survive as *intent*:
 * addressable by a host stylesheet, mapped to CSS fragmentation when printed,
 * and invisible otherwise.
 */
describe(':::mdv-page (SPEC 28.4)', () => {
  it('emits an empty marker for the marker form', () => {
    const html = render(':::mdv-page{break=before}\n:::\n\nAfter\n');
    expect(html).toContain('<div class="mdv-page-break" data-mdv-break="before"></div>');
    expect(html).toContain('<p>After</p>');
  });

  it('renders the wrapped content inside the marker', () => {
    const html = render(':::mdv-page{break=avoid}\n### Pricing\n\nBody\n:::\n');
    expect(html).toContain('data-mdv-break="avoid"');
    expect(html).toContain('<h3>Pricing</h3>');
    expect(html).toContain('<p>Body</p>');
    // Inside, not after: the wrapper is what `break-inside: avoid` applies to.
    expect(html).not.toContain('</div><h3>');
  });

  it('carries geometry through as data attributes', () => {
    const html = render(':::mdv-page{orientation=landscape size=A3}\n:::\n');
    expect(html).toContain('data-mdv-orientation="landscape"');
    expect(html).toContain('data-mdv-size="A3"');
  });

  it('ignores an unrecognised value rather than failing (SPEC 15.2)', () => {
    const html = render(':::mdv-page{break=sideways orientation=diagonal}\n\nKept\n:::\n');
    expect(html).toContain('class="mdv-page-break"');
    expect(html).not.toContain('data-mdv-break');
    expect(html).not.toContain('data-mdv-orientation');
    // The content is not collateral damage.
    expect(html).toContain('<p>Kept</p>');
  });

  it('has no visuals of its own', () => {
    const html = render(':::mdv-page{break=after}\n:::\n');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<hr');
  });
});

describe(':::mdv-figure (SPEC 9.1)', () => {
  it('numbers the caption and anchors the figure', () => {
    const html = render(':::mdv-figure{id=fig-a caption="Revenue by region"}\nBody\n:::\n');
    expect(html).toContain('<figure class="mdv-figure" id="fig-a">');
    expect(html).toContain('<figcaption class="mdv-figure-caption">');
    expect(html).toContain('<strong>Figure 1. </strong>Revenue by region');
  });

  it('counts up in document order', () => {
    const html = render(
      ':::mdv-figure{id=a caption="One"}\nx\n:::\n\n:::mdv-figure{id=b caption="Two"}\ny\n:::\n',
    );
    expect(html).toContain('<strong>Figure 1. </strong>One');
    expect(html).toContain('<strong>Figure 2. </strong>Two');
  });

  it('takes a number even with no caption, so both renderers agree', () => {
    // `flow.ts` increments before it looks for a caption; a figure that prints
    // no label on screen must still not shift the numbers of the ones after it.
    const html = render(
      ':::mdv-figure{id=quiet}\nx\n:::\n\n:::mdv-figure{id=loud caption="Second"}\ny\n:::\n',
    );
    expect(html).not.toContain('Figure 1.');
    expect(html).toContain('<strong>Figure 2. </strong>Second');
  });

  it('renames the counter with `label`', () => {
    const html = render(':::mdv-figure{id=e caption="Mass" label=Exhibit}\nx\n:::\n');
    expect(html).toContain('<strong>Exhibit 1. </strong>Mass');
  });
});

describe(':::mdv-callout (SPEC 9.1, 16.2)', () => {
  it('carries the kind as data and as a word, never as colour alone', () => {
    const html = render(':::mdv-callout{type=warning}\nMind the gap\n:::\n');
    expect(html).toContain('<aside class="mdv-callout" data-mdv-callout="warning">');
    expect(html).toContain('<span class="mdv-callout-icon" aria-hidden="true">!</span>');
    expect(html).toContain('Warning');
    expect(html).toContain('<p>Mind the gap</p>');
  });

  it('announces the kind before the title when the author wrote one', () => {
    const html = render(':::mdv-callout{type=danger title="Careful"}\nBody\n:::\n');
    // The icon is a shape; the word behind it is what a screen reader says, and
    // it has to come *before* the author's title to read as a label for it.
    expect(html).toContain('<span class="mdv-visually-hidden">Danger: </span>Careful</p>');
    expect(html).not.toContain('>Danger</p>');
  });

  it('falls back to a note for an unknown kind (SPEC 15.2)', () => {
    const html = render(':::mdv-callout{type=sideways}\nBody\n:::\n');
    expect(html).toContain('data-mdv-callout="note"');
    expect(html).toContain('<p>Body</p>');
  });

  it('gives every kind its own glyph', () => {
    const marks = ['note', 'tip', 'warning', 'danger'].map((kind) => {
      const html = render(`:::mdv-callout{type=${kind}}\nx\n:::\n`);
      return /<span class="mdv-callout-icon" aria-hidden="true">(.*?)<\/span>/.exec(html)?.[1];
    });
    expect(new Set(marks).size).toBe(4);
  });
});

describe(':::mdv-tabs (SPEC 9.1, 12.4)', () => {
  const DOC = [
    ':::mdv-tabs',
    '',
    ':::mdv-tab{title="One"}',
    'first',
    ':::',
    '',
    ':::mdv-tab{title="Two" default}',
    'second',
    ':::',
    '',
    ':::',
    '',
  ].join('\n');

  it('builds an APG tablist with one tab stop', () => {
    const html = render(DOC);
    expect(html).toContain('role="tablist"');
    // Roving tabindex: the strip is one stop, not one per tab (SPEC 12.4).
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2);
    expect((html.match(/tabindex="0"/g) ?? []).length).toBe(2); // selected tab + panel
    expect(html).toContain('tabindex="-1"');
  });

  it('honours `default` for the initially selected panel', () => {
    const html = render(DOC);
    expect(html).toContain('tabindex="0">Two</button>');
    expect(html).toContain('tabindex="-1">One</button>');
    expect(html).toContain('<p>second</p>');
    // Only the selected panel is mounted, so a hidden chart measures zero.
    expect(html).not.toContain('<p>first</p>');
  });

  it('pairs the panel with its tab in both directions', () => {
    const html = render(DOC);
    const panel = /<div role="tabpanel" id="([^"]+)"[^>]*aria-labelledby="([^"]+)"/.exec(html);
    expect(panel).not.toBeNull();
    const panelId = panel?.[1] ?? '';
    const tabId = panel?.[2] ?? '';
    // `aria-labelledby` has to name a tab that actually exists in the markup,
    // and that tab has to point back: an arrow press lands nowhere otherwise.
    expect(new RegExp(`<button[^>]*id="${tabId}"[^>]*aria-controls="${panelId}"`).test(html)).toBe(
      true,
    );
  });

  it('titles a tab from its label when there is no `title` attribute', () => {
    const html = render(':::mdv-tabs\n\n:::mdv-tab[Labelled]\nx\n:::\n\n:::\n');
    expect(html).toContain('>Labelled</button>');
  });

  it('numbers a tab that gave no name at all', () => {
    const html = render(':::mdv-tabs\n\n:::mdv-tab\nx\n:::\n\n:::\n');
    expect(html).toContain('>Tab 1</button>');
  });

  it('keeps stray content whole, after the widget', () => {
    // Not inside the strip, where it would cut the `tablist` into pieces that
    // are no longer a tablist — and not stripped of its own element either.
    const html = render(
      ':::mdv-tabs\n\n:::mdv-tab{title="One"}\nx\n:::\n\n- stray one\n- stray two\n\n:::\n',
    );
    expect(html).toContain('<ul><li><p>stray one</p></li><li><p>stray two</p></li></ul></div>');
    expect(html).not.toContain('<li><p>stray one</p></li></div>');
  });

  it('renders a lone `mdv-tab` as a section, not a strip of one', () => {
    const html = render(':::mdv-tab{title="Alone"}\nbody\n:::\n');
    expect(html).toContain('<section class="mdv-tab-panel">');
    expect(html).toContain('<p class="mdv-tab-title">Alone</p>');
    expect(html).not.toContain('role="tablist"');
  });
});

describe(':::mdv-details (SPEC 9.1)', () => {
  it('is the platform disclosure, with the summary the author wrote', () => {
    const html = render(':::mdv-details{summary="More"}\nhidden\n:::\n');
    expect(html).toContain('<details class="mdv-details">');
    expect(html).toContain('<summary class="mdv-details-summary">More</summary>');
    expect(html).toContain('<p>hidden</p>');
    expect(html).not.toContain('open');
  });

  it('opens on `open`, and stays shut on `open=false`', () => {
    expect(render(':::mdv-details{summary=S open}\nx\n:::\n')).toContain('open=""');
    expect(render(':::mdv-details{summary=S open=false}\nx\n:::\n')).not.toContain('open=""');
  });

  it('omits the summary rather than inventing one', () => {
    const html = render(':::mdv-details\nx\n:::\n');
    expect(html).toContain('<details class="mdv-details">');
    expect(html).not.toContain('<summary');
  });
});

describe(':::mdv-grid and :::mdv-columns (SPEC 9.1, 13.5)', () => {
  it('states the column count as data, so the stylesheet holds the rule', () => {
    const html = render(':::mdv-grid{cols=3}\nx\n:::\n');
    expect(html).toContain('<div class="mdv-grid" data-mdv-cols="3">');
    expect(html).not.toContain('style=');
  });

  it('defaults to two, and clamps to what the stylesheet can draw', () => {
    expect(render(':::mdv-grid\nx\n:::\n')).toContain('data-mdv-cols="2"');
    expect(render(':::mdv-grid{cols=99}\nx\n:::\n')).toContain('data-mdv-cols="6"');
    expect(render(':::mdv-columns\nx\n:::\n')).toContain('data-mdv-count="2"');
  });

  it('carries alignment and breakpoint through as attributes', () => {
    const html = render(':::mdv-grid{cols=2 align=center breakpoint=640}\nx\n:::\n');
    expect(html).toContain('data-mdv-align="center"');
    expect(html).toContain('data-mdv-breakpoint="640"');
  });

  it('drops an alignment it has no rule for (SPEC 15.2)', () => {
    expect(render(':::mdv-grid{align=diagonal}\nx\n:::\n')).not.toContain('data-mdv-align');
  });

  it('sets the gap as a custom property, never an inline style (SPEC 13.5)', () => {
    // The property is set through the CSSOM after mount; the server sends no
    // `style` attribute at all, which is what makes the markup CSP-safe.
    const html = render(':::mdv-columns{count=3 gap=12}\nx\n:::\n');
    expect(html).toContain('data-mdv-count="3"');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('12');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Inline directives (SPEC 9.2)
// ─────────────────────────────────────────────────────────────────────────────

describe(':mdv-ref (SPEC 9.2, 28.7)', () => {
  it('links to a figure by the name the pre-pass gave it', () => {
    const html = render(
      ':::mdv-figure{id=fig-a caption="Revenue"}\nx\n:::\n\nSee :mdv-ref[fig-a].\n',
    );
    expect(html).toContain('<a class="mdv-ref" href="#fig-a">Figure 1</a>');
  });

  it('links to a heading by its slug', () => {
    const html = render('## Results\n\nBack to :mdv-ref[results].\n');
    expect(html).toContain('<a class="mdv-ref" href="#results">§Results</a>');
  });

  it('prints the not-found form for a name nothing answers to', () => {
    const html = render('See :mdv-ref[nope].\n');
    expect(html).toContain('<span class="mdv-ref" data-mdv-unresolved="true">[nope?]</span>');
    expect(html).not.toContain('<a class="mdv-ref"');
  });

  it('reads forward as well as back', () => {
    // The pre-pass walks the whole document before the render begins, so a
    // reference above its target is not a promise the page cannot keep.
    const html = render('See :mdv-ref[fig-a].\n\n:::mdv-figure{id=fig-a caption="C"}\nx\n:::\n');
    expect(html).toContain('href="#fig-a">Figure 1</a>');
  });
});

describe(':mdv-value (SPEC 9.2, 6.4)', () => {
  it('reads the number out of the document dataset', () => {
    const html = render(withData('Total :mdv-value[@sales.revenue.sum].\n'));
    expect(html).toContain('<span class="mdv-value">896,000</span>');
  });

  it('formats it where the author asked', () => {
    const html = render(withData('Total :mdv-value[@sales.revenue.sum]{format="$~s"}.\n'));
    expect(html).toContain('<span class="mdv-value">$896k</span>');
  });

  it('runs the same reducers as the chart', () => {
    const html = render(
      withData('M :mdv-value[@sales.units.mean] X :mdv-value[@sales.units.max].\n'),
    );
    expect(html).toContain('>1,092</span>');
    expect(html).toContain('>1,204</span>');
  });

  it('shows the source text for a reference to nothing, never a blank or a zero', () => {
    const html = render(withData('Total :mdv-value[@nope.x.sum].\n'));
    expect(html).toContain('data-mdv-unresolved="true">@nope.x.sum</span>');
    // A missing number that renders as `0` is a claim the document cannot make.
    expect(html).not.toContain('>0</span>');
  });
});

describe(':mdv-metric, :mdv-delta and :mdv-badge (SPEC 9.2, 16.2)', () => {
  it('formats a literal number as written', () => {
    expect(render('N :mdv-metric[1284000]{format="$~s"}.\n')).toContain(
      '<span class="mdv-metric">$1.28M</span>',
    );
  });

  it('leaves a label that is not a number alone', () => {
    // `NaN` is not a document; an author saying something is not an error.
    expect(render('N :mdv-metric[n/a].\n')).toContain('<span class="mdv-metric">n/a</span>');
    expect(render('N :mdv-metric[n/a].\n')).not.toContain('NaN');
  });

  it('gives a delta a tone, an arrow and a sign', () => {
    const html = render('D :mdv-delta[0.082]{good=up}.\n');
    expect(html).toContain('<span class="mdv-delta" data-mdv-tone="good">');
    expect(html).toContain('<span class="mdv-delta-arrow" aria-hidden="true">▲</span>');
    // Three signals, and in that order of importance: the sign is in the text,
    // so a screen reader and a monochrome print both get it.
    expect(html).toContain('+8.2%');
  });

  it('reads the direction the author called good', () => {
    // A fall is good news for a metric whose good direction is down, and the
    // tile beside it classifies the same number through the same rule.
    const down = render('D :mdv-delta[-0.04]{good=down}.\n');
    expect(down).toContain('data-mdv-tone="good"');
    expect(down).toContain('▼');
    expect(render('D :mdv-delta[-0.04]{good=up}.\n')).toContain('data-mdv-tone="critical"');
  });

  it('calls a delta of zero no news, and draws it no arrow', () => {
    const html = render('D :mdv-delta[0]{good=up}.\n');
    expect(html).toContain('data-mdv-tone="neutral"');
    expect(html).not.toContain('mdv-delta-arrow');
  });

  it('carries a badge as an icon and a word', () => {
    const html = render('S :mdv-badge[Beta]{type=note}.\n');
    expect(html).toContain('<span class="mdv-badge" data-mdv-badge="note">');
    expect(html).toContain('<span class="mdv-badge-icon" aria-hidden="true">i</span>Beta');
  });
});

describe(':mdv-spark (SPEC 9.2, 8.12)', () => {
  it('draws the series the chart would draw', () => {
    const html = render('T :mdv-spark[12,15,13,19,24].\n');
    expect(html).toContain('viewBox="0 0 48 12"');
    expect(html).toContain('<polyline points="0.5,11.5 12.25,8.75 24,10.58 35.75,5.08 47.5,0.5">');
  });

  it('is a picture with the numbers behind it as its name', () => {
    const html = render('T :mdv-spark[1,2].\n');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="sparkline: 1, 2"');
    expect(html).toContain('focusable="false"');
  });

  it('draws bars inside the box rather than clipped in half by it', () => {
    const html = render('T :mdv-spark[5,1,5]{type=bar}.\n');
    const rects = [...html.matchAll(/<rect x="([\d.]+)"[^>]*width="([\d.]+)"/g)];
    expect(rects.length).toBe(3);
    for (const [, x, width] of rects) {
      expect(Number(x)).toBeGreaterThanOrEqual(0.5);
      expect(Number(x) + Number(width)).toBeLessThanOrEqual(47.5);
    }
  });

  it('prints the label rather than an empty box when there is no series', () => {
    expect(render('T :mdv-spark[nope].\n')).toContain('<span class="mdv-spark">nope</span>');
  });
});

describe('unknown directives (SPEC 15.2)', () => {
  it('renders a block directive as ordinary content', () => {
    const html = render(':::mdv-chrome{x=1}\nKept\n:::\n');
    expect(html).toContain('<p>Kept</p>');
    expect(html).not.toContain('mdv-chrome');
  });

  it('renders an inline directive as its label', () => {
    const html = render('A :mdv-nope[kept] one.\n');
    expect(html).toContain('A kept one.');
  });
});
