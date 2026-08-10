/**
 * The attribute cascade (SPEC 5.5) and the encoding lift (SPEC 7.1).
 *
 * These two functions decide what every chart in the preview is actually asked
 * to draw, and both have a precedence order that is easy to get subtly wrong and
 * impossible to notice by looking at one rendered document.
 */

import { describe, expect, it } from 'vitest';

import type { AttrMap, MdvBlock } from '@mdv/parser';

import {
  cascadeAttrs,
  encodingFromAttrs,
  isChannelName,
  mergeAttrs,
} from '../src/pipeline/cascade.js';

/** The parts of an `MdvBlock` the cascade reads. */
function block(attrs: AttrMap): MdvBlock {
  return { blockType: 'bar', attrs, raw: { header: '', data: '' } } as unknown as MdvBlock;
}

describe('mergeAttrs', () => {
  it('merges mappings deeply and replaces sequences wholesale', () => {
    const merged = mergeAttrs(
      { axis: { x: { title: 'Quarter', zero: true } }, y: ['revenue', 'profit'] },
      { axis: { x: { zero: false }, y: { title: 'USD' } }, y: ['revenue'] },
    );

    expect(merged).toEqual({
      axis: { x: { title: 'Quarter', zero: false }, y: { title: 'USD' } },
      // SPEC 5.5: a sequence replaces, it does not merge element-wise.
      y: ['revenue'],
    });
  });

  it('keeps inherited keys in place and appends new ones', () => {
    const merged = mergeAttrs({ a: 1, b: 2 }, { b: 3, a: 4, c: 5 });
    expect(Object.keys(merged)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate either input', () => {
    const under: AttrMap = { axis: { x: { zero: true } } };
    const over: AttrMap = { axis: { x: { zero: false } } };
    mergeAttrs(under, over);
    expect(under).toEqual({ axis: { x: { zero: true } } });
    expect(over).toEqual({ axis: { x: { zero: false } } });
  });

  it('treats an explicit undefined as "not set"', () => {
    // `AttrMap` cannot express this, but a YAML mapping with a valueless key
    // can produce it at runtime, and the overriding layer must not blank the
    // inherited one.
    const over = { a: undefined } as unknown as AttrMap;
    expect(mergeAttrs({ a: 1 }, over)).toEqual({ a: 1 });
  });
});

describe('cascadeAttrs', () => {
  it('applies the levels in SPEC 5.5 order, block attributes last', () => {
    const attrs = cascadeAttrs(block({ height: 400 }), {
      typeDefaults: { height: 200, legend: 'auto' } as AttrMap,
      documentDefaults: { height: 300, stack: 'normal' },
      configDefaults: { legend: 'right' },
    });

    expect(attrs).toMatchObject({
      height: 400, // block wins over document, which won over the type default
      legend: 'right', // reader configuration beat the type default
      stack: 'normal', // only the document set it
    });
  });

  it('works with no defaults at all', () => {
    expect(cascadeAttrs(block({ x: 'quarter' }), {})).toEqual({ x: 'quarter' });
  });
});

describe('encodingFromAttrs', () => {
  const columns = new Set(['quarter', 'revenue', 'profit']);

  it('reads a bare string as a field when the table has that column', () => {
    const encoding = encodingFromAttrs({ x: 'quarter' } as never, columns);
    expect(encoding.x).toEqual({ field: 'quarter' });
  });

  it('reads a bare string as a constant when the table does not', () => {
    const encoding = encodingFromAttrs({ color: '#f00' } as never, columns);
    expect(encoding.color).toEqual({ value: '#f00' });
  });

  it('expands a list into one channel per field (wide form, SPEC 7.1.1)', () => {
    const encoding = encodingFromAttrs({ y: ['revenue', 'profit'] } as never, columns);
    expect(encoding.y).toEqual([{ field: 'revenue' }, { field: 'profit' }]);
  });

  it('passes an object channel through, including scale shorthand', () => {
    const encoding = encodingFromAttrs(
      {
        y: { field: 'revenue', title: 'USD', aggregate: 'sum', scale: 'log', axis: false },
      } as never,
      columns,
    );
    expect(encoding.y).toEqual({
      field: 'revenue',
      title: 'USD',
      aggregate: 'sum',
      scale: { type: 'log' },
      axis: false,
    });
  });

  it('drops a channel object that binds neither a field nor a value', () => {
    const encoding = encodingFromAttrs({ y: { title: 'USD' } } as never, columns);
    expect(encoding.y).toBeUndefined();
  });

  it('puts the type defaults under the author, never over', () => {
    const encoding = encodingFromAttrs({ x: 'quarter' } as never, columns, {
      x: { field: 'ignored' },
      y: { field: 'revenue' },
    });
    expect(encoding.x).toEqual({ field: 'quarter' });
    expect(encoding.y).toEqual({ field: 'revenue' });
  });

  it('emits channels in one canonical order whatever the author wrote', () => {
    const authored = encodingFromAttrs(
      { color: 'profit', y: 'revenue', x: 'quarter' } as never,
      columns,
    );
    const reordered = encodingFromAttrs(
      { x: 'quarter', color: 'profit', y: 'revenue' } as never,
      columns,
    );
    // Object key order is observable through JSON, and SPEC 24.3 rule 5 says two
    // runs must not differ because of it.
    expect(JSON.stringify(authored)).toBe(JSON.stringify(reordered));
    expect(Object.keys(authored)).toEqual(['x', 'y', 'color']);
  });

  it('ignores attributes that are not channels', () => {
    const encoding = encodingFromAttrs({ title: 'Revenue', height: 240 } as never, columns);
    expect(encoding).toEqual({});
    expect(isChannelName('title')).toBe(false);
    expect(isChannelName('color')).toBe(true);
  });
});
