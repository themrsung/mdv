/**
 * The floor every type has to clear, swept across all of them at once.
 *
 * Each type's own suite checks what it draws; this file checks what none of them
 * may ever do. A chart that meets a hostile table with `NaN` in a `d` attribute
 * takes the whole document down in some backends and silently paints nothing in
 * others, and the inputs that provoke it — an empty table, one row, a column of
 * nulls, a frame one pixel wide — are the ordinary states of a document being
 * typed rather than exotic ones.
 *
 * The rule, therefore: for every Level 1 type, over every degenerate table, in
 * every degenerate frame, *nothing non-finite reaches the scene graph and
 * nothing throws*.
 */

import { describe, expect, it } from 'vitest';
import type { ChartType, Encoding, Rect, Table } from '@mdv/core';
import { level1ChartTypes } from '../src/index.js';
import { EMPTY_TABLE, attrsOf, makeTable, nonFiniteNumbers, runChart } from './harness.js';

/**
 * Every channel any Level 1 type reads, bound at once.
 *
 * Binding a channel a type does not declare is harmless — unknown channels are
 * core's to report — and it means one encoding drives all nine types, so no type
 * quietly escapes the sweep by being handed nothing to draw.
 */
const EVERY_CHANNEL: Encoding = {
  x: { field: 'key' },
  y: { field: 'value' },
  category: { field: 'key' },
  value: { field: 'value' },
  size: { field: 'value' },
  series: { field: 'key' },
};

const KEY_VALUE = [
  ['key', 'category'],
  ['value', 'number'],
] as const;

/** Tables that have provoked NaN geometry in one implementation or another. */
const TABLES: readonly (readonly [string, Table])[] = [
  ['no columns at all', EMPTY_TABLE],
  ['columns but no rows', makeTable(KEY_VALUE, [])],
  ['exactly one row', makeTable(KEY_VALUE, [['only', 42]])],
  ['one row at zero', makeTable(KEY_VALUE, [['only', 0]])],
  [
    'every value null',
    makeTable(KEY_VALUE, [
      ['a', null],
      ['b', null],
    ]),
  ],
  [
    'every key null',
    makeTable(KEY_VALUE, [
      [null, 1],
      [null, 2],
    ]),
  ],
  [
    'a constant column',
    makeTable(KEY_VALUE, [
      ['a', 7],
      ['b', 7],
      ['c', 7],
    ]),
  ],
  [
    'all zeroes',
    makeTable(KEY_VALUE, [
      ['a', 0],
      ['b', 0],
    ]),
  ],
  [
    'negatives only',
    makeTable(KEY_VALUE, [
      ['a', -5],
      ['b', -9],
    ]),
  ],
  [
    'straddling zero',
    makeTable(KEY_VALUE, [
      ['a', -5],
      ['b', 0],
      ['c', 5],
    ]),
  ],
  [
    'duplicate keys',
    makeTable(KEY_VALUE, [
      ['a', 1],
      ['a', 2],
      ['a', 3],
    ]),
  ],
  [
    'a single huge value',
    makeTable(KEY_VALUE, [
      ['a', 1e308],
      ['b', 1],
    ]),
  ],
  [
    'a single tiny value',
    makeTable(KEY_VALUE, [
      ['a', 5e-324],
      ['b', 1],
    ]),
  ],
  [
    'values spanning many orders',
    makeTable(KEY_VALUE, [
      ['a', 1e-9],
      ['b', 1e9],
    ]),
  ],
  [
    'an empty-string key',
    makeTable(KEY_VALUE, [
      ['', 1],
      ['b', 2],
    ]),
  ],
];

/** Frames a real layout can genuinely hand a block. */
const FRAMES: readonly (readonly [string, Rect])[] = [
  ['the ordinary frame', { x: 0, y: 0, width: 400, height: 200 }],
  ['one pixel square', { x: 0, y: 0, width: 1, height: 1 }],
  ['a letterbox', { x: 0, y: 0, width: 2000, height: 3 }],
  ['a column', { x: 0, y: 0, width: 3, height: 2000 }],
  ['no area at all', { x: 0, y: 0, width: 0, height: 0 }],
  ['negative extents', { x: 0, y: 0, width: -100, height: -50 }],
  ['an offset frame', { x: 37.5, y: -12.25, width: 400, height: 200 }],
];

function sweep(type: ChartType, table: Table, frame: Rect, attrs: Record<string, unknown> = {}) {
  return runChart(type, table, { encoding: EVERY_CHANNEL, attrs: attrsOf(attrs), frame });
}

/** The ordinary frame, kept separately so the per-test lookups stay total. */
const NORMAL: Rect = { x: 0, y: 0, width: 400, height: 200 };

describe.each(level1ChartTypes.map((type) => [type.name, type] as const))('%s', (name, type) => {
  it.each(TABLES.map(([label, table]) => [label, table] as const))(
    'emits finite geometry for %s',
    (_label, table) => {
      for (const [label, frame] of FRAMES) {
        const run = sweep(type, table, frame);
        expect(nonFiniteNumbers(run.laid), label).toEqual([]);
        expect(nonFiniteNumbers(run.encoded.marks), label).toEqual([]);
      }
    },
  );

  it('never throws for any of them', () => {
    for (const [, table] of TABLES) {
      for (const [, frame] of FRAMES) {
        expect(() => sweep(type, table, frame), name).not.toThrow();
      }
    }
  });

  it('reports rather than throws for attributes of the wrong shape (SPEC 14.1)', () => {
    const hostile = {
      stack: 42,
      curve: [],
      orientation: {},
      nullPolicy: true,
      innerRadius: 'wide',
      sort: 7,
      label: {},
      legend: 'somewhere',
      annotations: 'later',
      maxRadius: 'big',
      jitter: 'some',
      trend: 9,
      total: 'all',
      value: {},
      delta: [],
    };
    const run = sweep(
      type,
      makeTable(KEY_VALUE, [
        ['a', 1],
        ['b', 2],
      ]),
      NORMAL,
      hostile,
    );
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    for (const diagnostic of run.diagnostics) expect(diagnostic.severity).not.toBe('fatal');
  });

  it('keeps every hit region inside a sane box', () => {
    const table = makeTable(KEY_VALUE, [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    for (const [label, frame] of FRAMES) {
      for (const hit of sweep(type, table, frame).laid.hits) {
        // Core grows every region to 24 × 24; it cannot grow a NaN, and it must
        // not have to un-invert a negative one.
        expect(Number.isFinite(hit.x) && Number.isFinite(hit.y), label).toBe(true);
        expect(hit.w, label).toBeGreaterThanOrEqual(0);
        expect(hit.h, label).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('produces the same scene twice: encoding is a pure function of its input', () => {
    const table = makeTable(KEY_VALUE, [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    const first = sweep(type, table, NORMAL);
    const second = sweep(type, table, NORMAL);
    expect(JSON.stringify(second.laid)).toBe(JSON.stringify(first.laid));
  });

  it('describes itself in prose, for every one of those tables', () => {
    for (const [label, table] of TABLES) {
      const description = sweep(type, table, NORMAL).description;
      expect(typeof description, label).toBe('string');
      expect(description, label).not.toContain('NaN');
      expect(description, label).not.toContain('undefined');
      expect(description, label).not.toContain('[object Object]');
    }
  });
});

describe('the sweep itself', () => {
  it('covers all nine implemented types', () => {
    expect(level1ChartTypes).toHaveLength(9);
  });

  it('is worth running: the ordinary frame really does draw something', () => {
    const table = makeTable(KEY_VALUE, [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    for (const type of level1ChartTypes) {
      const run = sweep(type, table, NORMAL);
      expect(run.laid.nodes.length, type.name).toBeGreaterThan(0);
    }
  });
});
