/** The small deterministic helpers everything else is built on (SPEC 24.3). */

import { describe, expect, it } from 'vitest';

import { formatNumber, roundTo } from '../src/number.js';
import {
  PT_PER_PX,
  PdfUnitError,
  orient,
  parseLengthPt,
  resolveMargins,
  resolvePageSize,
} from '../src/units.js';
import { formatPageNumber, resolveOptions } from '../src/options.js';
import { encodableInWinAnsi, createStandardFontMetrics, toWinAnsi } from '../src/fonts.js';
import { documentId } from '../src/hash.js';
import { naturalSize, resolveLengthPx } from '../src/size.js';
import { TEST_THEME } from './fixtures.js';

describe('numbers', () => {
  it('rounds half to even, so a sum of rounded values does not drift', () => {
    expect(roundTo(0.0005, 3)).toBe(0);
    expect(roundTo(0.0015, 3)).toBe(0.002);
    expect(roundTo(2.5, 0)).toBe(2);
    expect(roundTo(3.5, 0)).toBe(4);
  });

  it('formats without an exponent or a trailing zero', () => {
    expect(formatNumber(1)).toBe('1');
    expect(formatNumber(1.5)).toBe('1.5');
    expect(formatNumber(0.00001)).toBe('0');
    expect(formatNumber(-0)).toBe('0');
  });
});

describe('units', () => {
  it('converts CSS pixels at 1px = 0.75pt', () => {
    expect(PT_PER_PX).toBe(0.75);
    expect(parseLengthPt('96px')).toBe(72);
    expect(parseLengthPt('1in')).toBe(72);
    expect(parseLengthPt('25.4mm')).toBeCloseTo(72, 6);
    // A unitless number is CSS pixels, as everywhere else in MDV.
    expect(parseLengthPt(12)).toBe(9);
  });

  it('rejects a malformed length loudly', () => {
    expect(() => parseLengthPt('wide')).toThrow(PdfUnitError);
    expect(() => resolvePageSize('A9')).toThrow(PdfUnitError);
  });

  it('resolves named page sizes and orientation', () => {
    expect(resolvePageSize('A4')).toEqual({ widthPt: 595, heightPt: 842 });
    expect(resolvePageSize('letter')).toEqual({ widthPt: 612, heightPt: 792 });
    expect(orient({ widthPt: 595, heightPt: 842 }, 'landscape')).toEqual({
      widthPt: 842,
      heightPt: 595,
    });
    expect(resolvePageSize(['10mm', '20mm']).widthPt).toBeCloseTo(28.346, 3);
  });

  it('defaults and expands margins', () => {
    const all = resolveMargins('2cm');
    expect(all.topPt).toBeCloseTo(56.693, 3);
    expect(all.leftPt).toBe(all.rightPt);
    const partial = resolveMargins({ top: '1in' });
    expect(partial.topPt).toBe(72);
    expect(partial.bottomPt).toBeGreaterThan(0);
  });
});

describe('page numbering', () => {
  it('formats decimal, roman and alpha without touching the host locale', () => {
    expect(formatPageNumber(4, 'decimal')).toBe('4');
    expect(formatPageNumber(4, 'roman')).toBe('iv');
    expect(formatPageNumber(1994, 'roman')).toBe('mcmxciv');
    expect(formatPageNumber(1, 'alpha')).toBe('a');
    expect(formatPageNumber(27, 'alpha')).toBe('aa');
  });
});

describe('options', () => {
  it('applies the SPEC 28.2 defaults', () => {
    const options = resolveOptions(undefined);
    expect(options.page).toEqual({ widthPt: 595, heightPt: 842 });
    expect(options.widows).toBe(2);
    expect(options.orphans).toBe(2);
    expect(options.bookmarks).toBe(true);
    expect(options.links).toBe(true);
    expect(options.compress).toBe(true);
    expect(options.profile).toBe('pdf-1.7');
    expect(options.toc).toBeUndefined();
  });

  it('treats an all-empty header as no header at all', () => {
    expect(resolveOptions({ header: { left: '', center: '' } }).header).toBeUndefined();
    expect(resolveOptions({ header: { left: 'x' } }).header).toEqual({
      left: 'x',
      center: '',
      right: '',
    });
  });
});

describe('WinAnsi folding (SPEC 28.6)', () => {
  it('knows what the standard faces can encode', () => {
    expect(encodableInWinAnsi(0x41)).toBe(true);
    expect(encodableInWinAnsi(0xe9)).toBe(true);
    expect(encodableInWinAnsi(0x2014)).toBe(true);
    expect(encodableInWinAnsi(0x4e2d)).toBe(false);
    expect(encodableInWinAnsi(0x9f)).toBe(false);
  });

  it('folds tabs and unmappable codepoints identically for measure and draw', () => {
    expect(toWinAnsi('a\tb')).toBe('a    b');
    expect(toWinAnsi('中文')).toBe('??');
    expect(toWinAnsi('naïve — “quoted”')).toBe('naïve — “quoted”');
  });

  it('measures the folded string, so a tab never throws', () => {
    const metrics = createStandardFontMetrics();
    const font = { family: 'monospace', size: 10 };
    expect(metrics.measure('a\tb', font).width).toBeCloseTo(
      metrics.measure('a    b', font).width,
      9,
    );
    expect(metrics.measure('中', font).width).toBeGreaterThan(0);
  });
});

describe('document id (SPEC 28.10)', () => {
  it('is 32 hex characters and depends on every part', () => {
    const a = documentId(['one', 'two']);
    expect(a).toMatch(/^[0-9A-F]{32}$/);
    expect(documentId(['one', 'two'])).toBe(a);
    expect(documentId(['onetwo'])).not.toBe(a);
    expect(documentId(['one', 'three'])).not.toBe(a);
  });
});

describe('natural block size (SPEC 5.4)', () => {
  it('fills the column and falls back to 300px tall', () => {
    expect(naturalSize({}, 480, TEST_THEME)).toEqual({ width: 480, height: 300 });
  });

  it('honours an explicit width and height', () => {
    expect(naturalSize({ width: '50%', height: 120 }, 480, TEST_THEME)).toEqual({
      width: 240,
      height: 120,
    });
  });

  it('lets `aspect` drive the height when the width is fluid', () => {
    expect(naturalSize({ aspect: 2 }, 480, TEST_THEME)).toEqual({ width: 480, height: 240 });
  });

  it('never exceeds the column', () => {
    expect(naturalSize({ width: '2000px' }, 480, TEST_THEME).width).toBe(480);
  });

  it('resolves the CSS absolute units against 96 dpi', () => {
    expect(resolveLengthPx('1in', 100, TEST_THEME)).toBe(96);
    expect(resolveLengthPx('72pt', 100, TEST_THEME)).toBe(96);
    expect(resolveLengthPx('nonsense', 100, TEST_THEME)).toBeUndefined();
  });
});
