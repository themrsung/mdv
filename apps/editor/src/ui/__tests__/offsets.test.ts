/**
 * Character-offset mapping, both directions.
 *
 * The identity under test is the one the whole editor rests on: the
 * concatenation of a container's text nodes is exactly the container's engine
 * text, so an offset in one is an offset in the other. Every case below is a
 * way that identity can break — decoration elements, the filler `<br>`, an
 * element-boundary position, a surrogate pair.
 */

import { describe, expect, it } from 'vitest';
import {
  diffText,
  offsetInContainer,
  positionAtOffset,
  runIndexOf,
  textLengthOf,
  textNodesOf,
  textOf,
} from '../dom/offsets.js';
import { container, element, firstText, text } from './fake-dom.js';

describe('text extraction', () => {
  it('concatenates the text nodes in document order', () => {
    const host = container('b1', [], ['Hello, ', 'bold', ' world']);
    expect(textOf(host)).toBe('Hello, bold world');
    expect(textLengthOf(host)).toBe('Hello, bold world'.length);
    expect(textNodesOf(host)).toHaveLength(3);
  });

  it('reads through nested mark elements', () => {
    const host = element('p', { 'data-mdv-container': 'b1', 'data-mdv-path': '' }, [
      element('span', { 'data-mdv-run': '0' }, [
        element('strong', {}, [element('em', {}, [text('deep')])]),
      ]),
    ]);
    expect(textOf(host)).toBe('deep');
  });

  it('skips the filler break of an empty container', () => {
    const host = container('b1', [], []);
    expect(textOf(host)).toBe('');
    expect(textLengthOf(host)).toBe(0);
  });
});

describe('offsetInContainer', () => {
  const host = container('b1', [], ['Hello, ', 'bold']);

  it('counts the text before a position inside a text node', () => {
    const second = host.childNodes[1];
    expect(second).toBeDefined();
    expect(offsetInContainer(host, firstText(second!), 2)).toBe(9);
  });

  it('handles an element-boundary position', () => {
    // (host, 1) means "before child 1", i.e. after the first run.
    expect(offsetInContainer(host, host, 1)).toBe(7);
    expect(offsetInContainer(host, host, 0)).toBe(0);
    expect(offsetInContainer(host, host, 99)).toBe(11);
  });

  it('clamps an offset past the end of a text node', () => {
    expect(offsetInContainer(host, firstText(host), 500)).toBe(7);
  });

  it('returns the full length for a node outside the container', () => {
    const stranger = text('elsewhere');
    expect(offsetInContainer(host, stranger, 0)).toBe(11);
  });
});

describe('positionAtOffset', () => {
  const host = container('b1', [], ['Hello, ', 'bold']);

  it('round-trips every offset', () => {
    for (let offset = 0; offset <= 11; offset += 1) {
      const position = positionAtOffset(host, offset);
      expect(offsetInContainer(host, position.node, position.offset)).toBe(offset);
    }
  });

  it('prefers the end of the earlier node at a run boundary', () => {
    const position = positionAtOffset(host, 7);
    expect(position.node).toBe(firstText(host));
    expect(position.offset).toBe(7);
  });

  it('points at the first run wrapper when there is no text', () => {
    const empty = container('b1', [], []);
    const position = positionAtOffset(empty, 0);
    expect(position.offset).toBe(0);
    // The filler `<br>` is a valid element-offset target; what matters is that
    // the position is inside the host and maps back to 0.
    expect(offsetInContainer(empty, position.node, position.offset)).toBe(0);
  });
});

describe('runIndexOf', () => {
  const host = container('b1', [], ['a', 'b']);

  it('finds the wrapper index for a node inside it', () => {
    const second = host.childNodes[1];
    expect(runIndexOf(host, firstText(second!))).toBe(1);
  });

  it('returns -1 above the run wrappers', () => {
    expect(runIndexOf(host, host)).toBe(-1);
  });
});

describe('diffText', () => {
  it('returns null when nothing changed', () => {
    expect(diffText('same', 'same')).toBeNull();
  });

  it('finds a pure insertion', () => {
    expect(diffText('ac', 'abc')).toEqual({ start: 1, end: 1, inserted: 'b' });
  });

  it('finds a pure deletion', () => {
    expect(diffText('abc', 'ac')).toEqual({ start: 1, end: 2, inserted: '' });
  });

  it('finds a replacement, which is what an IME commit looks like', () => {
    // Hangul: the preedit syllable is replaced wholesale on commit.
    expect(diffText('가', '각')).toEqual({ start: 0, end: 1, inserted: '각' });
  });

  it('never splits a surrogate pair', () => {
    // Two emoji sharing a leading high surrogate would tempt a naive prefix
    // scan into cutting between the halves.
    const before = '👍';
    const after = '👎';
    const splice = diffText(before, after);
    expect(splice).not.toBeNull();
    expect(splice?.start).toBe(0);
    expect(splice?.end).toBe(2);
    expect(splice?.inserted).toBe('👎');
    // Applying it must produce a string with no lone surrogate.
    const applied = before.slice(0, splice!.start) + splice!.inserted + before.slice(splice!.end);
    expect(applied).toBe(after);
    expect([...applied]).toHaveLength(1);
  });

  it('applies cleanly for a random-ish sample of edits', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['', 'new'],
      ['old', ''],
      ['prefix middle suffix', 'prefix MIDDLE suffix'],
      ['aaa', 'aaaa'],
      ['日本語', '日本の語'],
      ['x👍y', 'x👍👍y'],
    ];
    for (const [before, after] of cases) {
      const splice = diffText(before, after);
      const applied =
        splice === null
          ? before
          : before.slice(0, splice.start) + splice.inserted + before.slice(splice.end);
      expect(applied).toBe(after);
    }
  });
});
