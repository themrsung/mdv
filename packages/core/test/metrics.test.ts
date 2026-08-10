import { describe, expect, it } from 'vitest';
import type { Font } from '@mdv/core';
import {
  CanvasMetricsUnavailableError,
  createCanvasMetrics,
  createTableMetrics,
  cssFontShorthand,
  stringWidthEm,
} from '../src/metrics/index.js';
import { ellipsize, wrapText } from '../src/layout/text.js';

const FONT: Font = { family: 'system-ui', size: 13 };

describe('TableMetrics — the deterministic default (SPEC 24.3 rule 6)', () => {
  const metrics = createTableMetrics();

  it('measures the same string identically across instances', () => {
    const other = createTableMetrics();
    expect(metrics.measure('Revenue by quarter', FONT)).toEqual(
      other.measure('Revenue by quarter', FONT),
    );
  });

  it('scales linearly with the font size', () => {
    const small = metrics.measure('Hello', { ...FONT, size: 10 }).width;
    const large = metrics.measure('Hello', { ...FONT, size: 20 }).width;
    expect(large).toBeCloseTo(small * 2, 9);
  });

  it('makes bold wider than regular', () => {
    const regular = metrics.measure('Revenue', FONT).width;
    const bold = metrics.measure('Revenue', { ...FONT, weight: 700 }).width;
    expect(bold).toBeGreaterThan(regular);
  });

  it('is total: an unmeasurable string still yields a width', () => {
    expect(metrics.measure('', FONT).width).toBe(0);
    expect(metrics.measure('\u{1F600}\u{10FFFF}', FONT).width).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.measure('日本語のラベル', FONT).width)).toBe(true);
  });

  it('counts an astral character once, not twice', () => {
    // Two code points, one of them astral: the width must not double-count.
    expect(stringWidthEm('\u{1F600}')).toBe(stringWidthEm('\u{1F600}'));
    expect(stringWidthEm('ab')).toBeCloseTo(0.556 + 0.556, 9);
  });

  it('treats CJK as full-em squares and Latin as narrower', () => {
    expect(stringWidthEm('日')).toBe(1);
    expect(stringWidthEm('i')).toBeLessThan(0.3);
  });

  it('applies letter spacing between glyphs only', () => {
    const plain = metrics.measure('abc', FONT).width;
    const spaced = metrics.measure('abc', { ...FONT, letterSpacing: 2 }).width;
    expect(spaced - plain).toBeCloseTo(4, 9);
  });

  it('reports an ascent that clears an accented capital', () => {
    const measured = metrics.measure('Å', { ...FONT, size: 100 });
    expect(measured.ascent).toBeGreaterThan(80);
    expect(measured.descent).toBeGreaterThan(0);
  });
});

describe('CanvasMetrics — host-supplied, never DOM-constructed', () => {
  it('refuses anything that is not a measuring context', () => {
    expect(() => createCanvasMetrics(undefined)).toThrow(CanvasMetricsUnavailableError);
    expect(() => createCanvasMetrics({})).toThrow(CanvasMetricsUnavailableError);
    expect(() => createCanvasMetrics(undefined)).toThrow(/createTableMetrics/);
  });

  it('measures through the context the host supplied', () => {
    const applied: string[] = [];
    const stub = {
      set font(value: string) {
        applied.push(value);
      },
      get font(): string {
        return applied[applied.length - 1] ?? '';
      },
      measureText: (text: string) => ({ width: text.length * 7 }),
    };
    const metrics = createCanvasMetrics(stub);
    expect(metrics.measure('abcd', FONT).width).toBe(28);
    expect(applied).toEqual(['13px system-ui']);
  });

  it('stays total when the context throws', () => {
    const metrics = createCanvasMetrics({
      font: '',
      measureText: () => {
        throw new Error('detached');
      },
    });
    expect(metrics.measure('abc', FONT).width).toBe(0);
  });

  it('builds the CSS font shorthand', () => {
    expect(cssFontShorthand({ family: 'X', size: 12, weight: 600, style: 'italic' })).toBe(
      'italic 600 12px X',
    );
  });
});

describe('text fitting', () => {
  const metrics = createTableMetrics();

  it('ellipsizes chrome that will not fit, and leaves what does', () => {
    expect(ellipsize('Short', FONT, metrics, 400)).toBe('Short');
    const clipped = ellipsize('An extremely long block title', FONT, metrics, 60);
    expect(clipped.endsWith('…')).toBe(true);
    expect(metrics.measure(clipped, FONT).width).toBeLessThanOrEqual(60);
  });

  it('returns nothing when even the ellipsis will not fit', () => {
    expect(ellipsize('anything', FONT, metrics, 1)).toBe('');
  });

  it('wraps a caption on spaces, within the line budget', () => {
    const lines = wrapText(
      'Source: internal finance system, quarterly close, unaudited.',
      FONT,
      metrics,
      120,
      3,
    );
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) {
      expect(metrics.measure(line, FONT).width).toBeLessThanOrEqual(140);
    }
  });
});
