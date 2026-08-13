/**
 * `ohlc` and `ohlcv`/`candlestick` (SPEC 8.10, 8.11), asserted numerically.
 *
 * The fixture is four sessions whose numbers are chosen so that every pixel this
 * suite names is a whole one:
 *
 *   - the price extent is exactly `[80, 120]`, which `nice` leaves alone because
 *     its own step is 5, so over a 200 px frame one price unit is 5 px;
 *   - the frame is **420** px wide rather than the harness's 400, because a band
 *     scale divides the width by `n − padding + 2·padding` = 4.2 and only a
 *     multiple of 4.2 gives a round step. At 420 the step is 100, the band 80,
 *     and the four centres land on 60, 160, 260, 360.
 *
 * What the suite leans on:
 *
 *   - a candle says two things at once — the body is open-to-close and the wick
 *     is low-to-high — so a test that only measured the body would pass on a
 *     chart that had thrown the high away;
 *   - direction is read from a period against **itself**, never against its
 *     neighbour, and it selects a status color rather than a series slot;
 *   - volume is a *panel*, not a second encoding: `ohlc` leaves it undrawn until
 *     it is asked for and `ohlcv` always shows it (SPEC 8.11.2).
 */

import { describe, expect, it } from 'vitest';
import type { OhlcMark, Table } from '@mdv/core';
import { ohlcChart, ohlcvChart } from '../src/ohlc.js';
import {
  EMPTY_TABLE,
  attrsOf,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const FIELDS = [
  ['day', 'category'],
  ['open', 'number'],
  ['high', 'number'],
  ['low', 'number'],
  ['close', 'number'],
  ['volume', 'number'],
] as const;

/**
 * Four sessions: up, down, up, up.
 *
 * Tuesday closes level with Wednesday's open and *above* Monday's open, and is
 * still a down day, because it closed below the open on its own row.
 */
function prices(): Table {
  return makeTable(FIELDS, [
    ['Mon', 100, 110, 90, 105, 1000],
    ['Tue', 105, 112, 100, 100, 1500],
    ['Wed', 100, 120, 95, 115, 2000],
    ['Thu', 115, 118, 80, 118, 4000],
  ]);
}

const X = { x: { field: 'day' } } as const;

/** See the file header: 420 makes the band arithmetic land on whole pixels. */
const PRICE_FRAME = { x: 0, y: 0, width: 420, height: 200 };

/** The status colors this theme hands to a rising and a falling period. */
const UP = '#0ca30c';
const DOWN = '#d03b3b';

function priceRun(
  options: Parameters<typeof runChart>[2] = {},
): ReturnType<typeof runChart<OhlcMark>> {
  return runChart<OhlcMark>(ohlcChart, prices(), {
    encoding: X,
    frame: PRICE_FRAME,
    ...options,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The periods
// ─────────────────────────────────────────────────────────────────────────────

describe('a period is four numbers (SPEC 8.10)', () => {
  it('emits one mark per row carrying open, high, low and close', () => {
    const run = priceRun();
    expect(run.encoded.marks.map((mark) => [mark.open, mark.high, mark.low, mark.close])).toEqual([
      [100, 110, 90, 105],
      [105, 112, 100, 100],
      [100, 120, 95, 115],
      [115, 118, 80, 118],
    ]);
    expect(run.encoded.marks.every((mark) => mark.mark === 'ohlc')).toBe(true);
  });

  it('reads direction from the row itself, not from the row before it', () => {
    // Tuesday closes at 100, above Monday's *open* of 100 and level with
    // Wednesday's, and is a down day all the same.
    expect(priceRun().encoded.marks.map((mark) => mark.direction)).toEqual([
      'up',
      'down',
      'up',
      'up',
    ]);
  });

  it('gives direction a status color and no series slot (SPEC 11.3.1)', () => {
    expect(priceRun().encoded.series).toEqual([]);
    expect(priceRun().encoded.marks.map((mark) => mark.seriesId)).toEqual(['', '', '', '']);
  });

  it('labels each period from the column the reader sees on the axis', () => {
    expect(priceRun().encoded.marks.map((mark) => mark.label)).toEqual([
      'Mon',
      'Tue',
      'Wed',
      'Thu',
    ]);
  });

  it('finds the five price columns by name, with only x encoded', () => {
    const run = priceRun();
    expect(codesOf(run)).toEqual([]);
    expect(run.encoded.boundColumns?.map((column) => column.name)).toEqual([
      'day',
      'open',
      'high',
      'low',
      'close',
      'volume',
    ]);
  });

  it('takes the period column from a `date` attribute when x is unbound', () => {
    const run = runChart<OhlcMark>(ohlcChart, prices(), {
      attrs: attrsOf({ date: 'day' }),
      frame: PRICE_FRAME,
    });
    expect(codesOf(run)).toEqual([]);
    expect(run.encoded.marks.map((mark) => mark.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu']);
  });

  it('accepts columns named by the author when the conventions do not apply', () => {
    const table = makeTable(
      [
        ['session', 'category'],
        ['o', 'number'],
        ['h', 'number'],
        ['l', 'number'],
        ['c', 'number'],
      ],
      [['Mon', 100, 110, 90, 105]],
    );
    const run = runChart<OhlcMark>(ohlcChart, table, {
      encoding: { x: { field: 'session' } },
      attrs: attrsOf({ open: 'o', high: 'h', low: 'l', close: 'c' }),
    });
    expect(codesOf(run)).toEqual([]);
    expect(run.encoded.marks.map((mark) => [mark.open, mark.close])).toEqual([[100, 105]]);
  });

  it('normalises a bar whose high was written below its low', () => {
    // A transcription error, not a shape: the wick still spans both readings
    // rather than collapsing onto whichever number was typed first.
    const table = makeTable(FIELDS, [['Mon', 100, 90, 110, 105, 1000]]);
    const run = runChart<OhlcMark>(ohlcChart, table, { encoding: X });
    expect(run.encoded.marks.map((mark) => [mark.low, mark.high])).toEqual([[90, 110]]);
  });

  it('drops a period with a missing price and counts what it dropped', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 100, 110, 90, 105, 1000],
      ['Tue', null, 112, 100, 100, 1500],
    ]);
    const run = runChart<OhlcMark>(ohlcChart, table, { encoding: X });
    expect(run.encoded.marks.map((mark) => mark.label)).toEqual(['Mon']);
    expect(run.encoded.droppedRows).toBe(1);
  });

  it('does not force the price scale through zero', () => {
    // A stock that trades at 100 does not become more honest by drawing 80
    // units of empty space beneath it.
    expect(priceRun().encoded.scales.y?.domain).toEqual([80, 120]);
  });

  it('puts the periods under the plot and the prices beside it', () => {
    const run = priceRun();
    expect(run.encoded.axes?.map((axis) => [axis.channel, axis.position])).toEqual([
      ['x', 'bottom'],
      ['y', 'left'],
    ]);
    // Gridlines belong to the price ladder; the period axis gets the baseline.
    expect(run.encoded.axes?.map((axis) => axis.grid === true)).toEqual([false, true]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

describe('the candle geometry (SPEC 8.10)', () => {
  it('draws the wick from low to high at the band centre', () => {
    const wicks = nodesOfKind(priceRun().laid.nodes, 'line');
    expect(wicks.map((node) => [node.x1, node.y1, node.x2, node.y2])).toEqual([
      [60, 50, 60, 150],
      [160, 40, 160, 100],
      [260, 0, 260, 125],
      [360, 10, 360, 200],
    ]);
    expect(wicks.every((node) => node.cls === 'mdv-mark mdv-mark-wick')).toBe(true);
  });

  it('draws the body from open to close, centred on the same band', () => {
    const bodies = nodesOfKind(priceRun().laid.nodes, 'rect');
    expect(bodies.map((node) => [node.x, node.y, node.w, node.h])).toEqual([
      [48, 75, 24, 25],
      [148, 75, 24, 25],
      [248, 25, 24, 75],
      [348, 10, 24, 15],
    ]);
  });

  it('fills the body with the direction color and names it in the class', () => {
    const bodies = nodesOfKind(priceRun().laid.nodes, 'rect');
    expect(bodies.map((node) => node.fill)).toEqual([
      { kind: 'solid', color: UP },
      { kind: 'solid', color: DOWN },
      { kind: 'solid', color: UP },
      { kind: 'solid', color: UP },
    ]);
    expect(bodies.map((node) => node.cls)).toEqual([
      'mdv-mark mdv-mark-candle mdv-mark-up',
      'mdv-mark mdv-mark-candle mdv-mark-down',
      'mdv-mark mdv-mark-candle mdv-mark-up',
      'mdv-mark mdv-mark-candle mdv-mark-up',
    ]);
  });

  it('strokes the wick in the same color as the body it belongs to', () => {
    const wicks = nodesOfKind(priceRun().laid.nodes, 'line');
    expect(wicks.map((node) => node.stroke?.paint)).toEqual([
      { kind: 'solid', color: UP },
      { kind: 'solid', color: DOWN },
      { kind: 'solid', color: UP },
      { kind: 'solid', color: UP },
    ]);
  });

  it('still draws a doji: a period that closed where it opened is 1 px tall', () => {
    const table = makeTable(FIELDS, [['Mon', 100, 110, 90, 100, 1000]]);
    const run = runChart<OhlcMark>(ohlcChart, table, { encoding: X, frame: PRICE_FRAME });
    expect(run.encoded.marks.map((mark) => mark.direction)).toEqual(['flat']);
    expect(nodesOfKind(run.laid.nodes, 'rect').map((node) => node.h)).toEqual([1]);
  });

  it('hollows only the up candles, so fill carries direction without color', () => {
    const bodies = nodesOfKind(priceRun({ attrs: attrsOf({ hollow: true }) }).laid.nodes, 'rect');
    expect(bodies.map((node) => node.fill)).toEqual([
      { kind: 'solid', color: '#ffffff' },
      { kind: 'solid', color: DOWN },
      { kind: 'solid', color: '#ffffff' },
      { kind: 'solid', color: '#ffffff' },
    ]);
    // The outline still carries the color, so a hollow up candle is not blank.
    expect(bodies.map((node) => node.stroke?.paint)).toEqual([
      { kind: 'solid', color: UP },
      { kind: 'solid', color: DOWN },
      { kind: 'solid', color: UP },
      { kind: 'solid', color: UP },
    ]);
  });

  it('draws an OHLC bar as one path with an open tick and a close tick', () => {
    const run = priceRun({ attrs: attrsOf({ style: 'bar' }) });
    const bars = nodesOfKind(run.laid.nodes, 'path');
    expect(bars).toHaveLength(4);
    expect(bars.map((node) => node.cls)).toEqual([
      'mdv-mark mdv-mark-ohlc mdv-mark-up',
      'mdv-mark mdv-mark-ohlc mdv-mark-down',
      'mdv-mark mdv-mark-ohlc mdv-mark-up',
      'mdv-mark mdv-mark-ohlc mdv-mark-up',
    ]);
    // High-low, then a tick left for the open and a tick right for the close.
    expect(bars.map((node) => node.d.length)).toEqual([6, 6, 6, 6]);
    expect(nodesOfKind(run.laid.nodes, 'rect')).toEqual([]);
  });

  it('drops the open tick for `hlc`, which is the whole difference', () => {
    const bars = nodesOfKind(priceRun({ attrs: attrsOf({ style: 'hlc' }) }).laid.nodes, 'path');
    expect(bars.map((node) => node.d.length)).toEqual([4, 4, 4, 4]);
  });

  it('honours a narrower body and caps a wider one', () => {
    const narrow = nodesOfKind(priceRun({ attrs: attrsOf({ bodyWidth: 10 }) }).laid.nodes, 'rect');
    expect(narrow.map((node) => node.w)).toEqual([10, 10, 10, 10]);
    // A candle wider than 24 px stops reading as a candle and starts reading as
    // a bar chart, so the cap applies to the author's number too.
    const wide = nodesOfKind(priceRun({ attrs: attrsOf({ bodyWidth: 100 }) }).laid.nodes, 'rect');
    expect(wide.map((node) => node.w)).toEqual([24, 24, 24, 24]);
  });

  it('takes the author’s up and down colors when they are given', () => {
    const run = priceRun({ attrs: attrsOf({ upColor: '#001100', downColor: '#110000' }) });
    expect(nodesOfKind(run.laid.nodes, 'rect').map((node) => node.fill)).toEqual([
      { kind: 'solid', color: '#001100' },
      { kind: 'solid', color: '#110000' },
      { kind: 'solid', color: '#001100' },
      { kind: 'solid', color: '#001100' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The hover target
// ─────────────────────────────────────────────────────────────────────────────

describe('the crosshair target spans the stack (SPEC 8.11.2)', () => {
  it('gives each period one hit region a full band wide', () => {
    const hits = priceRun().laid.hits;
    expect(hits.map((hit) => [hit.x, hit.y, hit.w, hit.h])).toEqual([
      [20, 0, 80, 200],
      [120, 0, 80, 200],
      [220, 0, 80, 200],
      [320, 0, 80, 200],
    ]);
    expect(hits.map((hit) => hit.group)).toEqual(['Mon', 'Tue', 'Wed', 'Thu']);
    expect(hits.map((hit) => hit.datumIndex)).toEqual([0, 1, 2, 3]);
  });

  it('anchors the readout at the high, where the mark actually is', () => {
    expect(priceRun().laid.hits.map((hit) => hit.anchor)).toEqual([
      { x: 60, y: 50 },
      { x: 160, y: 40 },
      { x: 260, y: 0 },
      { x: 360, y: 10 },
    ]);
  });

  it('quotes all four prices, with the close emphasised', () => {
    const first = priceRun().laid.hits[0];
    expect(first?.readout.map((row) => [row.label, row.value])).toEqual([
      ['Open', '100'],
      ['High', '110'],
      ['Low', '90'],
      ['Close', '105'],
      ['Volume', '1k'],
    ]);
    expect(first?.readout.map((row) => row.emphasis === true)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it('points the region at the body it belongs to', () => {
    const run = priceRun();
    const bodies = nodesOfKind(run.laid.nodes, 'rect');
    expect(run.laid.hits.map((hit) => hit.markNodeId)).toEqual(bodies.map((node) => node.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Volume
// ─────────────────────────────────────────────────────────────────────────────

describe('volume is a panel, not a channel (SPEC 8.11.2)', () => {
  it('leaves volume undrawn on `ohlc`, even when the column is right there', () => {
    const run = priceRun();
    expect(run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel'))).toEqual([]);
    // It is still read: the readout quotes it, so the column stays bound.
    expect(run.encoded.boundColumns?.map((column) => column.name)).toContain('volume');
  });

  it('always prepends the panel on `ohlcv`', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), {
      encoding: X,
      frame: PRICE_FRAME,
    });
    const bars = run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel-bar'));
    expect(bars).toHaveLength(4);
    // 50 px of panel below a 142 px price rect, with an 8 px gutter between
    // them: the tallest bar fills the panel and the rest are proportions of it.
    expect(nodesOfKind(bars, 'rect').map((node) => [node.x, node.y, node.w, node.h])).toEqual([
      [48, 187.5, 24, 12.5],
      [148, 181.25, 24, 18.75],
      [248, 175, 24, 25],
      [348, 150, 24, 50],
    ]);
  });

  it('labels the panel with the column it is showing', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), { encoding: X, frame: PRICE_FRAME });
    expect(
      nodesOfKind(run.laid.nodes, 'text')
        .filter((node) => node.cls === 'mdv-panel-label')
        .map((node) => [node.text, node.x, node.y]),
    ).toEqual([['Volume', 2, 152]]);
  });

  it('colors the bars by direction, so the panel reads with the candles', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), { encoding: X, frame: PRICE_FRAME });
    const bars = nodesOfKind(
      run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel-bar')),
      'rect',
    );
    expect(bars.map((node) => node.fill)).toEqual([
      { kind: 'solid', color: UP, opacity: 0.65 },
      { kind: 'solid', color: DOWN, opacity: 0.65 },
      { kind: 'solid', color: UP, opacity: 0.65 },
      { kind: 'solid', color: UP, opacity: 0.65 },
    ]);
  });

  it('takes one fill for the whole panel when the author names a color', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), {
      encoding: X,
      frame: PRICE_FRAME,
      attrs: attrsOf({ volumeColor: '#123456' }),
    });
    const bars = nodesOfKind(
      run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel-bar')),
      'rect',
    );
    expect(bars.map((node) => node.fill)).toEqual([
      { kind: 'solid', color: '#123456', opacity: 0.65 },
      { kind: 'solid', color: '#123456', opacity: 0.65 },
      { kind: 'solid', color: '#123456', opacity: 0.65 },
      { kind: 'solid', color: '#123456', opacity: 0.65 },
    ]);
  });

  it('draws the panel on `ohlc` when the author asks for it', () => {
    const run = priceRun({ attrs: attrsOf({ panels: [{ type: 'volume' }] }) });
    expect(run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel-bar'))).toHaveLength(4);
  });

  it('does not stack the panel twice when `ohlcv` is also asked for it', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), {
      encoding: X,
      frame: PRICE_FRAME,
      attrs: attrsOf({ panels: [{ type: 'volume' }] }),
    });
    expect(run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel-bar'))).toHaveLength(4);
  });

  it('reports a missing volume column, because `ohlcv` promised one', () => {
    const table = makeTable(
      [
        ['day', 'category'],
        ['open', 'number'],
        ['high', 'number'],
        ['low', 'number'],
        ['close', 'number'],
      ],
      [['Mon', 100, 110, 90, 105]],
    );
    expect(codesOf(runChart(ohlcvChart, table, { encoding: X }))).toEqual(['MDV3000']);
  });

  it('adds volume to the readout only when a period has one', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), { encoding: X, frame: PRICE_FRAME });
    expect(run.laid.hits.map((hit) => hit.readout.at(-1)?.value)).toEqual([
      '1k',
      '1.5k',
      '2k',
      '4k',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Overlays and panels
// ─────────────────────────────────────────────────────────────────────────────

describe('overlays sit over the price (SPEC 8.11.1)', () => {
  it('draws a moving average as one line, broken where it has no value', () => {
    const run = priceRun({ attrs: attrsOf({ overlay: [{ type: 'sma', period: 2 }] }) });
    const lines = nodesOfKind(run.laid.nodes, 'path').filter((node) =>
      node.cls?.includes('mdv-overlay-line'),
    );
    // Three points, not four: the first period has no two-period average, and a
    // line drawn from period one would be an invention.
    expect(lines.map((node) => node.d.length)).toEqual([3]);
  });

  it('draws a Bollinger band as an area and its mid as a line', () => {
    const run = priceRun({ attrs: attrsOf({ overlay: [{ type: 'bollinger', period: 2 }] }) });
    const overlays = nodesOfKind(run.laid.nodes, 'path').filter((node) =>
      node.cls?.includes('mdv-overlay'),
    );
    expect(overlays.some((node) => node.cls?.includes('mdv-overlay-band'))).toBe(true);
    expect(overlays.some((node) => node.cls?.includes('mdv-overlay-line'))).toBe(true);
  });

  it('gives an overlay no series slot: it is a reading, not a series', () => {
    const run = priceRun({ attrs: attrsOf({ overlay: [{ type: 'sma', period: 2 }] }) });
    expect(run.encoded.series).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('widens the price scale to hold a reference line', () => {
    const run = priceRun({ attrs: attrsOf({ overlay: [{ type: 'line', value: 140 }] }) });
    expect(run.encoded.scales.y?.domain).toEqual([80, 140]);
  });
});

describe('an indicator panel stacks below the price (SPEC 8.11.2)', () => {
  it('draws RSI with its bands, labelled with the period it used', () => {
    const run = priceRun({ attrs: attrsOf({ panels: [{ type: 'rsi', period: 2 }] }) });
    expect(
      nodesOfKind(run.laid.nodes, 'text')
        .filter((node) => node.cls === 'mdv-panel-label')
        .map((node) => node.text),
    ).toEqual(['RSI 2']);
    expect(run.laid.nodes.filter((node) => node.cls?.includes('mdv-panel-guide'))).toHaveLength(2);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('keeps the price panel when a panel would leave it too short', () => {
    // 60 px is the floor for the price rect; three tall panels would take the
    // chart below it, so the panels are dropped rather than the prices.
    const run = priceRun({
      attrs: attrsOf({
        panels: [
          { type: 'rsi', height: 90 },
          { type: 'rsi', height: 90 },
        ],
      }),
    });
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(4);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What a reader gets who cannot see it
// ─────────────────────────────────────────────────────────────────────────────

describe('the description and the table (SPEC 12.2, 15.1)', () => {
  it('says what it is, how much of it there is, and where it went', () => {
    expect(priceRun().description).toBe(
      'Candlestick chart. Close by day, 4 periods. Prices range from 80 to 120. Up 18.0% from Mon to Thu.',
    );
  });

  it('names the volume variant for what it is', () => {
    const run = runChart<OhlcMark>(ohlcvChart, prices(), { encoding: X, frame: PRICE_FRAME });
    expect(run.description?.startsWith('Candlestick chart with volume.')).toBe(true);
  });

  it('reports a fall as a fall', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 100, 110, 90, 105, 1000],
      ['Tue', 105, 112, 100, 90, 1500],
    ]);
    const run = runChart<OhlcMark>(ohlcChart, table, { encoding: X });
    expect(run.description).toContain('Down 10.0% from Mon to Tue.');
  });

  it('lays every column it read into the table, in reading order', () => {
    const run = priceRun();
    expect(run.encoded.a11yTable?.columns.map((column) => column.name)).toEqual([
      'Day',
      'Open',
      'High',
      'Low',
      'Close',
      'Volume',
    ]);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Mon', '100', '110', '90', '105', '1,000'],
      ['Tue', '105', '112', '100', '100', '1,500'],
      ['Wed', '100', '120', '95', '115', '2,000'],
      ['Thu', '115', '118', '80', '118', '4,000'],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degenerate input
// ─────────────────────────────────────────────────────────────────────────────

describe('degenerate input (SPEC 15.2)', () => {
  it('asks for the columns it needs and draws nothing', () => {
    const run = runChart(ohlcChart, EMPTY_TABLE);
    expect([...new Set(codesOf(run))]).toEqual(['MDV3000']);
    expect(run.laid.nodes).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('says so plainly when the columns are all there but the rows are not', () => {
    const run = runChart<OhlcMark>(ohlcChart, noRows(FIELDS), { encoding: X });
    expect(codesOf(run)).toEqual([]);
    expect(run.encoded.marks).toEqual([]);
    expect(run.laid.nodes).toEqual([]);
    expect(run.description).toBe('Candlestick chart. No data.');
  });

  it('names the column it could not find', () => {
    const run = runChart(ohlcChart, prices(), {
      encoding: X,
      attrs: attrsOf({ close: 'settlement' }),
    });
    expect(codesOf(run)).toEqual(['MDV3000']);
    expect(run.diagnostics[0]?.message).toContain('settlement');
  });

  it('refuses a price column that is not a price', () => {
    const table = makeTable(
      [
        ['day', 'category'],
        ['open', 'number'],
        ['high', 'number'],
        ['low', 'number'],
        ['close', 'category'],
      ],
      [['Mon', 100, 110, 90, 'higher']],
    );
    expect(codesOf(runChart(ohlcChart, table, { encoding: X }))).toEqual(['MDV3001']);
  });

  it('survives a table where every price is null', () => {
    const table = makeTable(FIELDS, [
      ['Mon', null, null, null, null, null],
      ['Tue', null, null, null, null, null],
    ]);
    const run = runChart<OhlcMark>(ohlcChart, table, { encoding: X, frame: PRICE_FRAME });
    expect(run.encoded.marks).toEqual([]);
    expect(run.encoded.droppedRows).toBe(2);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});
