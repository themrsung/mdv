/**
 * The error card (SPEC 14.1 principle 2).
 *
 * > Failures are visible, not silent — an error card with the code, the message
 * > and the raw data, **never an empty frame**.
 *
 * So the tests are mostly about what the card refuses to omit. It is the last
 * thing standing between a broken block and a blank rectangle, and it has to
 * work in exactly the cases where everything else has already failed: no
 * diagnostics, a megabyte of raw source, raw source that is itself an attack.
 */

import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '@mdv/core';
import { errorCardString, errorCardVNode } from '../src/index.js';

const RANGE = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 4, line: 1, column: 5 },
};

function diag(code: string, message: string): Diagnostic {
  return { code, severity: 'error', message, range: RANGE, source: 'parse' };
}

const RAW = 'type: bar\ndata: |\n  q,rev\n  Q1,1200';

describe('the card always shows the code, the message and the raw data', () => {
  it('names every diagnostic, code first', () => {
    const svg = errorCardString(
      [diag('MDV3010', 'Unknown chart type "barr"'), diag('MDV2001', 'Column "rev" not found')],
      RAW,
    );
    expect(svg).toContain('MDV3010 · Unknown chart type &quot;barr&quot;');
    expect(svg).toContain('MDV2001 · Column &quot;rev&quot; not found');
  });

  it('reproduces the raw source line by line', () => {
    const svg = errorCardString([diag('MDV3010', 'Unknown chart type')], RAW);
    for (const line of ['type: bar', 'data: |', '  q,rev', '  Q1,1200']) {
      expect(svg).toContain(`>${line}</text>`);
    }
  });

  it('preserves the leading whitespace that made the block wrong', () => {
    // Indentation is frequently the bug. `xml:space="preserve"` is what stops
    // the renderer collapsing the evidence.
    const svg = errorCardString([diag('MDV3010', 'x')], '  indented');
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain('>  indented</text>');
  });

  it('renders a card even with no diagnostics at all, and says so', () => {
    // An empty diagnostic list is itself a bug upstream; the card must not
    // become the empty frame principle 2 forbids.
    const svg = errorCardString([], RAW);
    expect(svg).toContain('No diagnostic was recorded for this failure');
    expect(svg).toContain('This block could not be rendered');
    expect(svg).toContain('Block error: unknown');
  });

  it('renders a card for an empty document', () => {
    const svg = errorCardString([diag('MDV1001', 'Empty block')], '');
    expect(svg).toContain('MDV1001 · Empty block');
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('titles itself with the first code, so the tab and the a11y name carry it', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], RAW);
    expect(svg).toContain('<title id="mdv-error-title">Block error: MDV3010</title>');
    expect(svg).toContain('aria-labelledby="mdv-error-title"');
  });
});

describe('truncation is stated, never silent', () => {
  it('keeps the first twelve lines and counts the rest', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const svg = errorCardString([diag('MDV3010', 'x')], raw);
    expect(svg).toContain('>line 11</text>');
    expect(svg).not.toContain('>line 12</text>');
    expect(svg).toContain('… 18 more lines');
  });

  it('marks a truncated line with an ellipsis rather than cutting it silently', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], 'y'.repeat(200));
    const line = /<text[^>]*>(y+…?)<\/text>/.exec(svg)?.[1] ?? '';
    expect(line).toHaveLength(96);
    expect(line.endsWith('…')).toBe(true);
  });

  it('normalises CRLF so a Windows document does not render as one long line', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], 'a\r\nb\rc');
    expect(svg).toContain('>a</text>');
    expect(svg).toContain('>b</text>');
    expect(svg).toContain('>c</text>');
  });

  it('expands tabs, which would otherwise collapse in the output', () => {
    expect(errorCardString([diag('MDV3010', 'x')], '\tx')).toContain('>  x</text>');
  });
});

describe('the raw source is the most hostile string in the pipeline', () => {
  const XSS = '<script>alert("xss")</script>';

  it('escapes markup in the raw source', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], XSS);
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes markup in the message and the code', () => {
    const svg = errorCardString([diag('"><script>', XSS)], 'ok');
    expect(svg).not.toContain('<script');
    expect(svg.replace(/<\/?(?:svg|title|rect|text|line)[\s/>]/g, '')).not.toContain('<');
  });

  it('escapes a colour handed in by the caller, which reaches an attribute', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], 'ok', {
      colors: { critical: '" onload="alert(1)' },
    });
    expect(svg).not.toContain('onload="');
    expect(svg).toContain('&quot; onload=&quot;alert(1)');
  });
});

describe('the card is deterministic and self-describing', () => {
  it('renders byte-identically every time', () => {
    const once = errorCardString([diag('MDV3010', 'x')], RAW);
    for (let i = 0; i < 10; i += 1) {
      expect(errorCardString([diag('MDV3010', 'x')], RAW)).toBe(once);
    }
  });

  it('grows its height with the content instead of clipping it', () => {
    const short = errorCardVNode([diag('MDV3010', 'x')], 'a');
    const long = errorCardVNode([diag('MDV3010', 'x')], 'a\nb\nc\nd');
    const heightOf = (n: typeof short): number =>
      Number(n.attrs.find(([k]) => k === 'height')?.[1] ?? '0');
    expect(heightOf(long)).toBeGreaterThan(heightOf(short));
    expect(heightOf(short)).toBeGreaterThan(0);
  });

  it('honours width, precision and id prefix', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], 'a', {
      width: 481.5,
      precision: 0,
      idPrefix: 'card',
    });
    expect(svg).toContain('width="482"');
    expect(svg).toContain('id="card-title"');
  });

  it('carries the root class so the scoped stylesheet applies (SPEC 22.4)', () => {
    expect(errorCardString([diag('MDV3010', 'x')], 'a')).toContain(
      'class="mdv-root mdv-error-card"',
    );
  });

  it('is a standalone document: xmlns, viewBox and role', () => {
    const svg = errorCardString([diag('MDV3010', 'x')], 'a');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toMatch(/viewBox="0 0 640 \d+"/);
    expect(svg).toContain('role="img"');
  });
});
