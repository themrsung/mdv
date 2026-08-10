/**
 * The serialisation primitives: number formatting (SPEC 23.1, 24.3) and output
 * sanitisation (SPEC 13.3).
 *
 * These four functions are the entire escaping surface of the package, so they
 * are tested directly and hard. Everything else in the backend inherits whatever
 * guarantees hold here.
 */

import { describe, expect, it } from 'vitest';
import { escapeXml, formatNumber, isSafeId, sanitiseClasses, sanitiseUrl } from '../src/format.js';

describe('formatNumber (SPEC 23.1: 3 decimals, -0 normalised to 0)', () => {
  it('rounds to the requested precision and strips trailing zeros', () => {
    expect(formatNumber(1.23456, 3)).toBe('1.235');
    expect(formatNumber(1.5, 3)).toBe('1.5');
    expect(formatNumber(2, 3)).toBe('2');
    expect(formatNumber(0.1 + 0.2, 3)).toBe('0.3');
  });

  it('normalises every spelling of negative zero to "0"', () => {
    expect(formatNumber(-0, 3)).toBe('0');
    expect(formatNumber(-0.0001, 3)).toBe('0');
    expect(formatNumber(-0.0004999, 3)).toBe('0');
    // The value that makes a naive `toFixed` emit "-0.000".
    expect(formatNumber(-1e-9, 3)).toBe('0');
  });

  it('rounds half to even, so a scene full of .5s does not drift upward', () => {
    // Half-up would give 1, 2, 3, 4 — a systematic bias of +0.5 per value.
    expect(formatNumber(0.5, 0)).toBe('0');
    expect(formatNumber(1.5, 0)).toBe('2');
    expect(formatNumber(2.5, 0)).toBe('2');
    expect(formatNumber(3.5, 0)).toBe('4');
    expect(formatNumber(0.0025, 3)).toBe('0.002');
    expect(formatNumber(0.0035, 3)).toBe('0.004');
  });

  it('is symmetric about zero', () => {
    for (const v of [1.2345, 0.5, 2.5, 100.0005, 1 / 3]) {
      const pos = formatNumber(v, 3);
      const neg = formatNumber(-v, 3);
      expect(neg === '0' ? pos : `-${pos}`).toBe(neg);
    }
  });

  it('clamps precision into [0, 12] rather than throwing', () => {
    expect(formatNumber(1.5, -4)).toBe('2');
    expect(formatNumber(1.23456789012345, 99)).toBe(formatNumber(1.23456789012345, 12));
  });

  it('throws for a non-finite coordinate instead of emitting a plausible 0', () => {
    // A NaN coordinate is an engine bug upstream, never document content: a
    // silently-zeroed one produces a chart that looks fine and is wrong.
    expect(() => formatNumber(Number.NaN, 3)).toThrow(TypeError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY, 3)).toThrow(/Non-finite/);
    expect(() => formatNumber(Number.NEGATIVE_INFINITY, 3)).toThrow(/Non-finite/);
  });

  it('is a pure function of its arguments', () => {
    const a = formatNumber(12.3456, 3);
    const b = formatNumber(12.3456, 3);
    expect(a).toBe(b);
  });
});

describe('escapeXml (SPEC 13.3)', () => {
  it('escapes all five predefined entities regardless of context', () => {
    expect(escapeXml('&')).toBe('&amp;');
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('"')).toBe('&quot;');
    expect(escapeXml("'")).toBe('&apos;');
  });

  it('neutralises a script tag and an attribute break-out', () => {
    expect(escapeXml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeXml('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
    expect(escapeXml("' onmouseover='x")).toBe('&apos; onmouseover=&apos;x');
  });

  it('escapes the ampersand first, so an entity cannot be reconstructed', () => {
    // Naive sequential replacement turns this back into a live `<`.
    expect(escapeXml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('strips the C0 controls XML 1.0 forbids but keeps tab, LF and CR', () => {
    expect(escapeXml('a\u0000b\u0008c\u001fd')).toBe('abcd');
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('leaves ordinary text, astral planes and RTL alone', () => {
    expect(escapeXml('Revenue (US$), Q1–Q4')).toBe('Revenue (US$), Q1–Q4');
    expect(escapeXml('📈 مرحبا')).toBe('📈 مرحبا');
  });

  it('is idempotent in the sense that re-escaping is visible, not lossy', () => {
    const once = escapeXml('<a>');
    expect(escapeXml(once)).toBe('&amp;lt;a&amp;gt;');
  });
});

describe('isSafeId (SPEC 13.3: ids are generated, never content-derived)', () => {
  it('accepts generated ids', () => {
    expect(isSafeId('mdv-0')).toBe(true);
    expect(isSafeId('mdv-0-title')).toBe(true);
    expect(isSafeId('a')).toBe(true);
  });

  it('rejects anything that could break a reference or escape a selector', () => {
    for (const bad of [
      '',
      '0-leading-digit',
      '-dash',
      'has space',
      'quote"',
      "apos'",
      'a<b',
      'π',
    ]) {
      expect(isSafeId(bad)).toBe(false);
    }
  });
});

describe('sanitiseClasses (SPEC 22.4)', () => {
  it('keeps safe tokens in order and drops duplicates', () => {
    expect(sanitiseClasses('mdv-mark mdv-bar mdv-mark')).toBe('mdv-mark mdv-bar');
  });

  it('drops tokens that could not be an mdv-* class', () => {
    expect(sanitiseClasses('mdv-bar "evil" a<b 0bad')).toBe('mdv-bar');
  });

  it('collapses arbitrary whitespace and survives an empty list', () => {
    expect(sanitiseClasses('  a\t\tb\n c ')).toBe('a b c');
    expect(sanitiseClasses('')).toBe('');
    expect(sanitiseClasses('   ')).toBe('');
  });
});

describe('sanitiseUrl (SPEC 13.3 / MDV4010)', () => {
  it('allows http, https and mailto', () => {
    expect(sanitiseUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(sanitiseUrl('http://example.com')).toBe('http://example.com');
    expect(sanitiseUrl('mailto:a@example.com')).toBe('mailto:a@example.com');
  });

  it('allows same-document fragments and relative references', () => {
    expect(sanitiseUrl('#mdv-0-clip')).toBe('#mdv-0-clip');
    expect(sanitiseUrl('./chart.png')).toBe('./chart.png');
    expect(sanitiseUrl('/assets/chart.png')).toBe('/assets/chart.png');
    expect(sanitiseUrl('chart.png')).toBe('chart.png');
  });

  it('strips javascript:, vbscript: and non-image data: URLs', () => {
    expect(sanitiseUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitiseUrl('JaVaScRiPt:alert(1)')).toBeUndefined();
    expect(sanitiseUrl('vbscript:msgbox(1)')).toBeUndefined();
    expect(sanitiseUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(sanitiseUrl('file:///etc/passwd')).toBeUndefined();
  });

  it('sees through whitespace and control characters in the scheme', () => {
    // Browsers strip these before resolving, so the test must too, or
    // `java\nscript:` walks straight through the allowlist.
    expect(sanitiseUrl('java\nscript:alert(1)')).toBeUndefined();
    expect(sanitiseUrl('java\tscript:alert(1)')).toBeUndefined();
    expect(sanitiseUrl('  javascript:alert(1)')).toBeUndefined();
    expect(sanitiseUrl('java\u0000script:alert(1)')).toBeUndefined();
    expect(sanitiseUrl('\u0001javascript:alert(1)')).toBeUndefined();
  });

  it('allows data:image/* because CSP img-src permits it', () => {
    expect(sanitiseUrl('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR');
    expect(sanitiseUrl('data:image/svg+xml;base64,PHN2')).toBe('data:image/svg+xml;base64,PHN2');
  });

  it('rejects an empty or whitespace-only reference', () => {
    expect(sanitiseUrl('')).toBeUndefined();
    expect(sanitiseUrl('   ')).toBeUndefined();
  });
});
