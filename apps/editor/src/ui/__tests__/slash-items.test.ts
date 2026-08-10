/**
 * The slash catalogue and its matcher.
 *
 * What matters about a command palette is that it is *predictable*: the same
 * keystrokes must always leave the same entry under the cursor, or Enter stops
 * being safe to press. So these assertions are mostly about ordering, and the
 * one thing they never do is accept "some plausible order".
 */

import { describe, expect, it } from 'vitest';
import { matchSlashItems, SLASH_ITEMS } from '../menus/slash-items.js';

const ids = (query: string): readonly string[] => matchSlashItems(query).map((item) => item.id);

describe('the catalogue', () => {
  it('has unique ids', () => {
    expect(new Set(SLASH_ITEMS.map((item) => item.id)).size).toBe(SLASH_ITEMS.length);
  });

  it('gives every entry a label, a hint and something to run', () => {
    for (const item of SLASH_ITEMS) {
      expect(item.label.length, item.id).toBeGreaterThan(0);
      expect(item.hint.length, item.id).toBeGreaterThan(0);
      expect(['commands', 'pickImage'], item.id).toContain(item.effect.kind);
    }
  });

  it('produces commands eagerly enough to be inspected, but not shared', () => {
    const bullet = SLASH_ITEMS.find((item) => item.id === 'bullet');
    if (bullet === undefined || bullet.effect.kind !== 'commands')
      throw new Error('no bullet item');
    const first = bullet.effect.run();
    const second = bullet.effect.run();
    expect(first.length).toBeGreaterThan(0);
    // A fresh command per invocation: menus are opened more than once.
    expect(first[0]).not.toBe(second[0]);
  });

  it('asks the host for a file rather than inventing an image', () => {
    const image = SLASH_ITEMS.find((item) => item.id === 'image');
    expect(image?.effect.kind).toBe('pickImage');
  });
});

describe('matching', () => {
  it('shows everything for an empty query', () => {
    expect(matchSlashItems('')).toEqual(SLASH_ITEMS);
  });

  it('treats whitespace as empty', () => {
    expect(matchSlashItems('   ')).toEqual(SLASH_ITEMS);
  });

  it('ignores case', () => {
    expect(ids('CHART')).toEqual(ids('chart'));
  });

  it('finds nothing for a query that means nothing', () => {
    expect(ids('zzzz')).toEqual([]);
  });

  it('ranks an exact label above a longer one that starts with it', () => {
    // 'Table' exactly, then 'Enhanced table' which only contains the word.
    expect(ids('table')).toEqual(['table', 'mdv-table']);
  });

  it('prefers a label prefix to a keyword', () => {
    const ranked = ids('code');
    expect(ranked[0]).toBe('code');
  });

  it('finds a block by a keyword its label never mentions', () => {
    expect(ids('kpi')).toEqual(['metric']);
    expect(ids('photo')).toEqual(['image']);
    expect(ids('###')).toEqual(['h3']);
  });

  it('breaks ties by the catalogue order, not by locale', () => {
    // Every visual carries the 'mdv' keyword, so all five score identically.
    expect(ids('mdv')).toEqual(['chart-bar', 'chart-line', 'chart-pie', 'metric', 'mdv-table']);
  });

  it('narrows as the query grows', () => {
    const wide = ids('c');
    const narrow = ids('cha');
    expect(narrow.length).toBeLessThan(wide.length);
    for (const id of narrow) expect(wide).toContain(id);
  });

  it('is deterministic', () => {
    expect(ids('li')).toEqual(ids('li'));
  });
});
