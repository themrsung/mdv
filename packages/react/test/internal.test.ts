/**
 * The DOM-free machinery: content hashing, the attribute cascade, sizing.
 */

import { describe, expect, it } from 'vitest';
import type { BlockAttrs } from '@mdv/core';
import { encodingFromAttrs } from '@mdv/core';
import { contentHash, hashString } from '../src/internal/hash.js';
import { BUILTIN_DEFAULTS, cascade, mergeAttrs, splitAttrs } from '../src/internal/cascade.js';
import { DEFAULT_HEIGHT, resolveBlockSize } from '../src/internal/size.js';

describe('contentHash (SPEC 24.2)', () => {
  it('is deterministic', () => {
    expect(contentHash('a', { b: 1 })).toBe(contentHash('a', { b: 1 }));
  });

  it('is 64 bits of hex', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('distinguishes types', () => {
    expect(contentHash(1)).not.toBe(contentHash('1'));
    expect(contentHash(true)).not.toBe(contentHash('true'));
    expect(contentHash(null)).not.toBe(contentHash(undefined));
    expect(contentHash([1, 2])).not.toBe(contentHash('1,2'));
  });

  it('distinguishes -0 from 0 (SPEC 24.3 rule 4)', () => {
    expect(contentHash(-0)).not.toBe(contentHash(0));
  });

  it('respects key order, because field order is load-bearing (rule 5)', () => {
    expect(contentHash({ a: 1, b: 2 })).not.toBe(contentHash({ b: 2, a: 1 }));
  });

  it('cannot be fooled by concatenation', () => {
    expect(contentHash('ab', 'c')).not.toBe(contentHash('a', 'bc'));
    expect(contentHash(['a', 'b'])).not.toBe(contentHash(['ab']));
  });

  it('handles dates by instant', () => {
    expect(contentHash(new Date(0))).toBe(contentHash(new Date(0)));
    expect(contentHash(new Date(0))).not.toBe(contentHash(new Date(1)));
  });

  it('hashes nested structures', () => {
    expect(contentHash({ a: { b: [1, { c: 2 }] } })).toBe(contentHash({ a: { b: [1, { c: 2 }] } }));
    expect(contentHash({ a: { b: [1, { c: 2 }] } })).not.toBe(
      contentHash({ a: { b: [1, { c: 3 }] } }),
    );
  });

  it('spreads over a long string', () => {
    // Not a distribution test — just a guard that the 64-bit arithmetic has not
    // collapsed to a constant on inputs longer than a word.
    const keys = new Set(Array.from({ length: 512 }, (_, i) => hashString(`row ${String(i)}`)));
    expect(keys.size).toBe(512);
  });
});

describe('the attribute cascade (SPEC 5.5)', () => {
  it('merges mappings deeply', () => {
    expect(mergeAttrs({ axis: { y: { grid: true } } }, { axis: { x: { title: 'T' } } })).toEqual({
      axis: { y: { grid: true }, x: { title: 'T' } },
    });
  });

  it('replaces sequences wholly', () => {
    expect(mergeAttrs({ y: ['a', 'b'] }, { y: ['c'] })).toEqual({ y: ['c'] });
  });

  it('replaces scalars', () => {
    expect(mergeAttrs({ height: 300 }, { height: 200 })).toEqual({ height: 200 });
  });

  it('keeps the lower layer’s key order', () => {
    const merged = mergeAttrs({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(Object.keys(merged)).toEqual(['a', 'b', 'c']);
  });

  it('applies the layers lowest-precedence-first', () => {
    const merged = cascade(
      BUILTIN_DEFAULTS,
      { height: 320 }, // document defaults
      { height: 400 }, // embedder configuration — outranks the document
      { height: 200 }, // the block itself — outranks both
    );
    expect(merged['height']).toBe(200);
    expect(merged['width']).toBe('100%');
  });

  it('lets the embedder enforce a house style over the document', () => {
    expect(cascade({}, { palette: 'a' }, { palette: 'b' })['palette']).toBe('b');
  });
});

describe('splitting attributes from channels (SPEC 7.1)', () => {
  it('normalises the bare form', () => {
    const { encoding } = splitAttrs({ x: 'quarter', y: 'revenue' });
    expect(encoding.x).toEqual({ field: 'quarter' });
    expect(encoding.y).toEqual({ field: 'revenue' });
  });

  it('keeps a wide-form list', () => {
    const { encoding } = splitAttrs({ y: ['a', 'b'] });
    expect(encoding.y).toEqual([{ field: 'a' }, { field: 'b' }]);
  });

  it('keeps the object form, and only the keys Channel declares', () => {
    const { encoding } = splitAttrs({
      y: { field: 'revenue', title: 'Revenue', format: '$,.0f', nonsense: 1 },
    });
    expect(encoding.y).toEqual({ field: 'revenue', title: 'Revenue', format: '$,.0f' });
  });

  it('leaves block attributes alone', () => {
    const { attrs, encoding } = splitAttrs({ title: 'T', height: 200, stack: 'normal' });
    expect(attrs.title).toBe('T');
    expect(attrs.height).toBe(200);
    expect(attrs['stack']).toBe('normal');
    expect(Object.keys(encoding)).toHaveLength(0);
  });

  it('collects x- extensions and never interprets them (SPEC 15.1)', () => {
    const { attrs } = splitAttrs({ 'x-plugin': { a: 1 } });
    expect(attrs.extensions).toEqual({ 'x-plugin': { a: 1 } });
    expect(attrs['x-plugin']).toBeUndefined();
  });

  it('does not mistake `x-foo` for the `x` channel', () => {
    const { encoding } = splitAttrs({ 'x-foo': 'bar' });
    expect(encoding.x).toBeUndefined();
  });

  it('keeps `row` and `column` in both places — faceting reads the attribute', () => {
    const { attrs, encoding } = splitAttrs({ row: 'region', column: 'year' });
    expect(attrs.row).toBe('region');
    expect(attrs.column).toBe('year');
    expect(encoding.row).toEqual({ field: 'region' });
    expect(encoding.column).toEqual({ field: 'year' });
  });

  it('treats `tooltip: false` as the attribute and `tooltip: [..]` as the channel', () => {
    const off = splitAttrs({ tooltip: false });
    expect(off.attrs.tooltip).toBe(false);
    expect(off.encoding.tooltip).toBeUndefined();

    const fields = splitAttrs({ tooltip: ['a', 'b'] });
    expect(fields.encoding.tooltip).toEqual([{ field: 'a' }, { field: 'b' }]);
  });

  it('reads a bare number or boolean on a channel as a constant', () => {
    const { encoding } = splitAttrs({ size: 12 });
    expect(encoding.size).toEqual({ value: 12 });
  });

  it('lifts a channel without moving it — the attribute survives too', () => {
    const { attrs, encoding } = splitAttrs({ x: 'quarter', y: 'revenue' });
    expect(attrs['x']).toBe('quarter');
    expect(attrs['y']).toBe('revenue');
    expect(encoding.x).toEqual({ field: 'quarter' });
  });

  it('keeps a literal `value` on attrs, which is where `metric` reads it (SPEC 8.13)', () => {
    const { attrs, encoding } = splitAttrs({
      label: 'Monthly recurring revenue',
      value: 1284000,
      format: '$~s',
    });
    expect(attrs['value']).toBe(1284000);
    expect(attrs['label']).toBe('Monthly recurring revenue');
    // The constant form is still a channel, but it binds no field: a chart type
    // that only looked at `encoding` would see nothing to read.
    expect(encoding.value).toEqual({ value: 1284000 });
  });

  it('splits the way `@mdv/core` cascades — same keys on attrs', () => {
    const merged = { title: 'T', x: 'quarter', y: ['a', 'b'], stack: 'normal' } as const;
    const { attrs } = splitAttrs({ ...merged });
    const core = encodingFromAttrs({ ...merged } as never, new Set(['quarter', 'a', 'b']));
    expect(Object.keys(attrs).sort()).toEqual(Object.keys(merged).sort());
    expect(Object.keys(core).sort()).toEqual(['x', 'y']);
  });
});

describe('resolveBlockSize (SPEC 8.1)', () => {
  const attrs = (extra: Record<string, unknown> = {}): BlockAttrs => extra as BlockAttrs;

  it('fills the container and defaults the height to 300', () => {
    expect(resolveBlockSize({ attrs: attrs(), containerWidth: 640 })).toEqual({
      width: 640,
      height: DEFAULT_HEIGHT,
    });
  });

  it('falls back to a deterministic width before measurement', () => {
    expect(resolveBlockSize({ attrs: attrs(), containerWidth: undefined }).width).toBe(800);
    expect(
      resolveBlockSize({ attrs: attrs(), containerWidth: undefined, fallbackWidth: 1000 }).width,
    ).toBe(1000);
  });

  it('honours an explicit width in every unit', () => {
    expect(resolveBlockSize({ attrs: attrs({ width: 320 }), containerWidth: 640 }).width).toBe(320);
    expect(resolveBlockSize({ attrs: attrs({ width: '320px' }), containerWidth: 640 }).width).toBe(
      320,
    );
    expect(resolveBlockSize({ attrs: attrs({ width: '50%' }), containerWidth: 640 }).width).toBe(
      320,
    );
    expect(resolveBlockSize({ attrs: attrs({ width: '20rem' }), containerWidth: 640 }).width).toBe(
      320,
    );
  });

  it('lets `aspect` override the height while the width is fluid', () => {
    expect(resolveBlockSize({ attrs: attrs({ aspect: 2 }), containerWidth: 600 })).toEqual({
      width: 600,
      height: 300,
    });
    // A fixed width means the author has already chosen a box; `height` wins.
    expect(
      resolveBlockSize({
        attrs: attrs({ aspect: 2, width: 600, height: 100 }),
        containerWidth: 900,
      }),
    ).toEqual({ width: 600, height: 100 });
  });

  it('lets a component prop outrank the attribute', () => {
    expect(
      resolveBlockSize({ attrs: attrs({ height: 400 }), containerWidth: 640, heightOverride: 280 }),
    ).toEqual({ width: 640, height: 280 });
  });

  it('falls back rather than producing NaN for a malformed dimension', () => {
    const size = resolveBlockSize({ attrs: attrs({ height: 'wide' }), containerWidth: 640 });
    expect(size.height).toBe(DEFAULT_HEIGHT);
    expect(Number.isFinite(size.width)).toBe(true);
  });

  it('snaps to whole pixels, so sub-pixel jitter is not a new cache key', () => {
    expect(resolveBlockSize({ attrs: attrs(), containerWidth: 640.0001 }).width).toBe(640);
    expect(resolveBlockSize({ attrs: attrs(), containerWidth: 639.6 }).width).toBe(640);
  });
});
