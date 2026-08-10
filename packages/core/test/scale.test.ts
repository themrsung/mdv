import { describe, expect, it } from 'vitest';
import {
  bandCenter,
  buildPositionalScale,
  computeContinuousDomain,
  createBandScale,
  createContinuousScale,
  createOrdinalScale,
  createSequentialScale,
  createTimeScale,
  formatDate,
  formatNumber,
  logTicks,
  niceDomain,
  rerangeScale,
  tickStep,
  ticks,
  timeTicks,
} from '../src/scale/index.js';
import { THEME } from './fixtures/visual.js';

describe('linear ticks (SPEC 7.3)', () => {
  it('prefers round values over an exact count', () => {
    expect(ticks(0, 100, 5)).toMatchInlineSnapshot(`
      [
        0,
        20,
        40,
        60,
        80,
        100,
      ]
    `);
    expect(ticks(0, 1, 5)).toMatchInlineSnapshot(`
      [
        0,
        0.2,
        0.4,
        0.6,
        0.8,
        1,
      ]
    `);
    expect(ticks(1240, 1893, 4)).toMatchInlineSnapshot(`
      [
        1400,
        1600,
        1800,
      ]
    `);
  });

  it('produces exact decimals, not accumulated float error', () => {
    for (const value of ticks(0, 1, 10)) {
      expect(Number(value.toFixed(10))).toBe(value);
    }
  });

  it('handles a reversed range by reversing the output', () => {
    expect(ticks(100, 0, 5)).toEqual([100, 80, 60, 40, 20, 0]);
  });

  it('returns a single tick for a degenerate domain', () => {
    expect(ticks(5, 5, 5)).toEqual([5]);
  });

  it('reports the step magnitude', () => {
    expect(tickStep(0, 100, 5)).toBe(20);
    expect(tickStep(0, 1, 10)).toBeCloseTo(0.1, 12);
  });
});

describe('nice domains (SPEC 7.2)', () => {
  it('rounds outward to a clean step', () => {
    expect(niceDomain(1240, 1893, 5)).toEqual([1200, 1900]);
    expect(niceDomain(0.03, 0.87, 5)).toEqual([0, 1]);
  });

  it('includes zero when asked, for bars and areas', () => {
    expect(computeContinuousDomain([1240, 1893], { zero: true })).toEqual([0, 2000]);
    expect(computeContinuousDomain([1240, 1893], { zero: false })).toEqual([1200, 1900]);
  });

  it('honours a pinned end and does not nice it away', () => {
    expect(computeContinuousDomain([10, 87], { explicit: [null, 100] })).toEqual([0, 100]);
    expect(computeContinuousDomain([10, 87], { explicit: [0, 100] })).toEqual([0, 100]);
  });

  it('expands a degenerate extent rather than collapsing to one pixel', () => {
    const [lo, hi] = computeContinuousDomain([42, 42], { nice: false });
    expect(lo).toBeLessThan(42);
    expect(hi).toBeGreaterThan(42);
  });

  it('keeps a log domain strictly positive', () => {
    const [lo] = computeContinuousDomain([0, 5, 500], { positive: true });
    expect(lo).toBeGreaterThan(0);
  });
});

describe('continuous scales', () => {
  it('maps the domain onto the range', () => {
    const scale = createContinuousScale({ type: 'linear', domain: [0, 100], range: [0, 200] });
    expect(scale.scale(0)).toBe(0);
    expect(scale.scale(50)).toBe(100);
    expect(scale.scale(100)).toBe(200);
  });

  it('returns undefined out of domain, and clamps when asked', () => {
    const open = createContinuousScale({ type: 'linear', domain: [0, 10], range: [0, 100] });
    expect(open.scale(20)).toBeUndefined();
    const clamped = createContinuousScale({
      type: 'linear',
      domain: [0, 10],
      range: [0, 100],
      clamp: true,
    });
    expect(clamped.scale(20)).toBe(100);
    expect(clamped.scale(-5)).toBe(0);
  });

  it('inverts', () => {
    const scale = createContinuousScale({ type: 'linear', domain: [0, 100], range: [0, 200] });
    expect(scale.invert?.(100)).toBe(50);
  });

  it('reverses the range without the caller swapping it', () => {
    const scale = createContinuousScale({
      type: 'linear',
      domain: [0, 10],
      range: [0, 100],
      reverse: true,
    });
    expect(scale.scale(0)).toBe(100);
    expect(scale.scale(10)).toBe(0);
  });

  it('ticks a log scale on decades and 1/2/5 mantissas', () => {
    expect(logTicks(1, 1000, 10, 10)).toMatchInlineSnapshot(`
      [
        1,
        2,
        5,
        10,
        20,
        50,
        100,
        200,
        500,
        1000,
      ]
    `);
    expect(logTicks(1, 1e6, 10, 4)).toEqual([1, 100, 10000, 1000000]);
  });

  it('keeps sqrt honest about zero', () => {
    const scale = createContinuousScale({ type: 'sqrt', domain: [0, 100], range: [0, 10] });
    expect(scale.scale(0)).toBe(0);
    expect(scale.scale(25)).toBe(5);
  });
});

describe('band and point geometry (SPEC 7.2)', () => {
  const domain = ['Q1', 'Q2', 'Q3', 'Q4'];

  it('divides the range into padded bands', () => {
    // `paddingOuter` defaults to `paddingInner`, not to d3's `paddingInner / 2`:
    // 400 / (4 − 0.2 + 0.4) = 95.238…, not 400 / 4. That is the geometry
    // `@mdv/charts` draws bars with, and an axis built here has to agree with it
    // to the pixel. See `bandGeometry`.
    const scale = createBandScale({ domain, range: [0, 400], paddingInner: 0.2 });
    expect(scale.step?.()).toMatchInlineSnapshot(`95.23809523809524`);
    expect(scale.bandwidth?.()).toMatchInlineSnapshot(`76.19047619047619`);
    expect(scale.scale('Q1')).toMatchInlineSnapshot(`19.047619047619047`);
    expect(scale.scale('Q4')).toMatchInlineSnapshot(`304.76190476190476`);
  });

  it('leaves the same gap at both ends as between bands', () => {
    const scale = createBandScale({ domain, range: [0, 400] });
    const first = scale.scale('Q1') ?? 0;
    const last = scale.scale('Q4') ?? 0;
    const width = scale.bandwidth?.() ?? 0;
    const gap = (scale.step?.() ?? 0) - width;

    expect(first).toBeCloseTo(gap, 10);
    expect(400 - (last + width)).toBeCloseTo(gap, 10);
  });

  it('touches with zero padding', () => {
    const scale = createBandScale({ domain, range: [0, 400], paddingInner: 0, paddingOuter: 0 });
    expect(scale.step?.()).toBe(100);
    expect(scale.bandwidth?.()).toBe(100);
    expect(scale.scale('Q1')).toBe(0);
    expect(scale.scale('Q4')).toBe(300);
  });

  it('centres a tick in its band', () => {
    const scale = createBandScale({ domain, range: [0, 400], paddingInner: 0, paddingOuter: 0 });
    expect(bandCenter(scale, 'Q1')).toBe(50);
  });

  it('gives a point scale zero width and puts points on the ends', () => {
    const scale = createBandScale({ domain, range: [0, 300], point: true, paddingOuter: 0 });
    expect(scale.bandwidth?.()).toBe(0);
    expect(scale.scale('Q1')).toBe(0);
    expect(scale.scale('Q4')).toBe(300);
  });

  it('returns undefined for a value outside the domain', () => {
    const scale = createBandScale({ domain, range: [0, 400] });
    expect(scale.scale('Q9')).toBeUndefined();
  });

  it('thins its ticks by an even stride when asked for fewer', () => {
    const scale = createBandScale({ domain: ['a', 'b', 'c', 'd', 'e', 'f'], range: [0, 600] });
    expect(scale.ticks(3)).toEqual(['a', 'c', 'e']);
  });
});

describe('ordinal scales (SPEC 11.2 rule 2)', () => {
  it('never cycles the range', () => {
    const scale = createOrdinalScale({ domain: ['a', 'b', 'c'], range: ['#1', '#2'] });
    expect(scale.scale('a')).toBe('#1');
    expect(scale.scale('b')).toBe('#2');
    expect(scale.scale('c')).toBeUndefined();
  });
});

describe('time scales (SPEC 7.2)', () => {
  it('chooses calendar boundaries, not millisecond arithmetic', () => {
    const from = new Date('2024-01-15T00:00:00Z');
    const to = new Date('2024-06-15T00:00:00Z');
    expect(timeTicks(from, to, 5, 'UTC').map((d) => d.toISOString())).toMatchInlineSnapshot(`
      [
        "2024-02-01T00:00:00.000Z",
        "2024-03-01T00:00:00.000Z",
        "2024-04-01T00:00:00.000Z",
        "2024-05-01T00:00:00.000Z",
        "2024-06-01T00:00:00.000Z",
      ]
    `);
  });

  it('steps by whole years over a long span', () => {
    const from = new Date('2001-03-01T00:00:00Z');
    const to = new Date('2006-03-01T00:00:00Z');
    expect(timeTicks(from, to, 5, 'UTC').map((d) => d.getUTCFullYear())).toEqual([
      2002, 2003, 2004, 2005, 2006,
    ]);
  });

  it('labels with a pattern chosen from the step', () => {
    const scale = createTimeScale({
      domain: [new Date('2024-01-01T00:00:00Z'), new Date('2024-12-01T00:00:00Z')],
      range: [0, 100],
      timezone: 'UTC',
    });
    expect(scale.format(new Date('2024-03-01T00:00:00Z'))).toBe('Mar 2024');
  });

  it('is timezone-driven, not host-driven', () => {
    const instant = new Date('2024-03-01T02:30:00Z');
    expect(formatDate(instant, '%Y-%m-%d %H:%M', 'UTC')).toBe('2024-03-01 02:30');
    expect(formatDate(instant, '%Y-%m-%d %H:%M', '-05:00')).toBe('2024-02-29 21:30');
  });
});

describe('number formatting (SPEC 6.9, 11.5)', () => {
  it('groups thousands and honours precision', () => {
    expect(formatNumber(1234567.891, ',.2f', 'en-US')).toBe('1,234,567.89');
    expect(formatNumber(0.256, '.1%', 'en-US')).toBe('25.6%');
    expect(formatNumber(1234, '$,.0f', 'en-US')).toBe('$1,234');
    expect(formatNumber(1500000, '~s', 'en-US')).toBe('1.5M');
  });

  it('uses a real minus sign, not a hyphen', () => {
    expect(formatNumber(-42, ',.0f', 'en-US')).toBe('−42');
  });

  it('follows the bundled locale conventions, never Intl', () => {
    expect(formatNumber(1234.5, ',.1f', 'de-DE')).toBe('1.234,5');
  });
});

describe('sequential colour (SPEC 11.3)', () => {
  it('interpolates within the listed steps', () => {
    const scale = createSequentialScale({
      domain: [0, 100],
      steps: THEME.sequential.steps,
    });
    expect(scale.scale(0)).toBe('#cde2fb');
    expect(scale.scale(100)).toBe('#0d366b');
    expect(scale.scale(50)).toMatchInlineSnapshot(`"#3987e5"`);
  });
});

describe('re-ranging (stage 5 → stage 6)', () => {
  it('keeps the domain and moves the range', () => {
    const scale = buildPositionalScale({
      values: [0, 10],
      range: [0, 1],
      fieldType: 'number',
    });
    const moved = rerangeScale(scale, [100, 300]);
    expect(moved.domain).toEqual(scale.domain);
    expect(moved.range).toEqual([100, 300]);
    expect(moved.scale(scale.domain[1] as number)).toBe(300);
  });

  it('is a no-op when the range already matches', () => {
    const scale = buildPositionalScale({ values: [0, 10], range: [0, 100], fieldType: 'number' });
    expect(rerangeScale(scale, [0, 100])).toBe(scale);
  });

  it('preserves band padding across a re-range', () => {
    const scale = buildPositionalScale({
      values: ['a', 'b', 'c'],
      range: [0, 100],
      fieldType: 'category',
    });
    const moved = rerangeScale(scale, [0, 300]);
    const ratio = (s: typeof scale): number => (s.bandwidth?.() ?? 0) / (s.step?.() ?? 1);
    expect(ratio(moved)).toBeCloseTo(ratio(scale), 12);
  });
});

describe('buildPositionalScale', () => {
  it('picks band for a category field and time for a date field', () => {
    expect(buildPositionalScale({ values: ['a'], range: [0, 1], fieldType: 'category' }).type).toBe(
      'band',
    );
    expect(
      buildPositionalScale({ values: [new Date(0)], range: [0, 1], fieldType: 'datetime' }).type,
    ).toBe('time');
  });

  it('degrades an impossible request instead of failing the block', () => {
    const scale = buildPositionalScale({
      values: ['a', 'b'],
      range: [0, 100],
      fieldType: 'category',
      spec: { type: 'log' },
    });
    expect(scale.type).toBe('band');
  });

  it('reports rows a log scale cannot represent', () => {
    const dropped: number[] = [];
    buildPositionalScale({
      values: [-4, 0, 10, 100],
      range: [0, 100],
      fieldType: 'number',
      spec: { type: 'log' },
      onNonPositive: (value) => dropped.push(value),
    });
    expect(dropped).toEqual([-4, 0]);
  });
});
