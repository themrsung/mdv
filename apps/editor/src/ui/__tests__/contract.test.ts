/**
 * The DOM contract, and the fact that the renderer actually honours it.
 *
 * `../dom/contract.ts` declares the attributes the offset mapper looks for, and
 * the block views write them as JSX literals — `data-mdv-run={index}` reads
 * better than a computed key and lets React fast-path the prop. The cost of
 * that choice is that the two can drift apart silently, and the failure mode is
 * not a crash: it is a caret that lands one character out. So the last test
 * here reads the renderer's own source and checks the literals are still there.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_ATTR,
  CONTAINER_ATTR,
  FILLER_ATTR,
  KIND_ATTR,
  PATH_ATTR,
  RUN_ATTR,
  closestBlock,
  closestContainer,
  contains,
  decodePath,
  describeContainer,
  encodePath,
  findBlockElement,
  findContainerElement,
  isElement,
  isText,
} from '../dom/contract.js';
import { block, container, element, firstText, text } from './fake-dom.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('path encoding', () => {
  it('round-trips', () => {
    for (const path of [[], [0], [1, 2], [12, 0, 3]]) {
      expect(decodePath(encodePath(path))).toEqual(path);
    }
  });

  it('decodes an empty or missing value to the block itself', () => {
    expect(decodePath('')).toEqual([]);
    expect(decodePath(null)).toEqual([]);
    expect(decodePath(undefined)).toEqual([]);
  });

  it('refuses to guess at a malformed value', () => {
    expect(decodePath('1,nonsense')).toEqual([]);
  });
});

describe('node predicates', () => {
  it('separates elements from text', () => {
    const el = element('p', {}, []);
    const node = text('hi');
    expect(isElement(el)).toBe(true);
    expect(isElement(node)).toBe(false);
    expect(isText(node)).toBe(true);
    expect(isText(el)).toBe(false);
    expect(isElement(null)).toBe(false);
    expect(isText(undefined)).toBe(false);
  });
});

describe('ancestor lookup', () => {
  const host = container('b1', [1, 2], ['cell text'], { tag: 'td' });
  const wrapper = block('b1', [host]);
  const root = element('div', {}, [wrapper]);

  it('finds the container a text node lives in', () => {
    expect(closestContainer(firstText(host))).toBe(host);
  });

  it('finds the block wrapper', () => {
    expect(closestBlock(firstText(host))).toBe(wrapper);
  });

  it('returns null above the surface', () => {
    expect(closestContainer(root)).toBeNull();
  });

  it('describes what a container renders', () => {
    expect(describeContainer(host)).toEqual({ blockId: 'b1', path: [1, 2] });
  });

  it('describes nothing for an element that is not a container', () => {
    expect(describeContainer(wrapper)).toBeNull();
  });

  it('knows whether one node contains another', () => {
    expect(contains(root, firstText(host))).toBe(true);
    expect(contains(host, root)).toBe(false);
    expect(contains(host, host)).toBe(true);
  });
});

describe('element lookup', () => {
  const cellA = container('t1', [0, 0], ['a'], { tag: 'td' });
  const cellB = container('t1', [0, 1], ['b'], { tag: 'td' });
  const paragraph = container('p1', [], ['text']);
  const root = element('div', {}, [block('t1', [cellA, cellB]), block('p1', [paragraph])]);

  it('finds a container by block id and path', () => {
    expect(findContainerElement(root, 't1', [0, 1])).toBe(cellB);
    expect(findContainerElement(root, 'p1', [])).toBe(paragraph);
  });

  it('returns null for a path that is not rendered', () => {
    expect(findContainerElement(root, 't1', [9, 9])).toBeNull();
  });

  it('finds a block wrapper by id', () => {
    const found = findBlockElement(root, 'p1');
    expect(found).not.toBeNull();
    expect(found?.getAttribute(BLOCK_ATTR)).toBe('p1');
  });
});

describe('the renderer honours the contract', () => {
  const sources = ['../blocks/Editable.tsx', '../blocks/Runs.tsx', '../blocks/BlockView.tsx'].map(
    (path) => readFileSync(resolve(here, path), 'utf8'),
  );
  const all = sources.join('\n');

  it.each([
    ['CONTAINER_ATTR', CONTAINER_ATTR],
    ['PATH_ATTR', PATH_ATTR],
    ['RUN_ATTR', RUN_ATTR],
    ['FILLER_ATTR', FILLER_ATTR],
    ['BLOCK_ATTR', BLOCK_ATTR],
    ['KIND_ATTR', KIND_ATTR],
  ])('still writes %s (%s) somewhere in the block views', (_name, attribute) => {
    expect(all).toContain(attribute);
  });

  it('uses the attribute names the mapper reads', () => {
    expect(CONTAINER_ATTR).toBe('data-mdv-container');
    expect(PATH_ATTR).toBe('data-mdv-path');
    expect(RUN_ATTR).toBe('data-mdv-run');
    expect(FILLER_ATTR).toBe('data-mdv-filler');
    expect(BLOCK_ATTR).toBe('data-mdv-block');
  });
});
