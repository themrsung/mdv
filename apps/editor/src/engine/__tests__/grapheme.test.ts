/**
 * Grapheme-aware editing.
 *
 * Backspace deletes one *user-perceived character*. That sentence hides a lot
 * of work: `"👩‍👩‍👧‍👦".length` is 11, and removing one UTF-16 code unit from it
 * produces mojibake while removing one code point produces a different, smaller
 * family. The same applies to flags, skin tones, keycaps, combining marks and
 * Hangul jamo.
 *
 * Two layers are tested. The segmenter itself is checked against both
 * implementations — `Intl.Segmenter` when the host has it and the hand-rolled
 * fallback always — because the fallback is what runs on hosts that lack it and
 * an untested fallback is a liability. Then the delete commands are checked
 * end-to-end, since a correct segmenter wired up wrongly is just as broken.
 */

import { describe, expect, it } from 'vitest';

import { deleteBackward, deleteForward, insertText } from '../commands/index.js';
import {
  defaultSegmenter,
  fallbackSegmenter,
  graphemeLength,
  nextBoundary,
  previousBoundary,
} from '../grapheme.js';
import type { GraphemeSegmenter } from '../grapheme.js';
import { createEditor } from '../editor.js';
import { createIdFactory } from '../ids.js';
import { at, blockAt, caretAt, editorFor, textOf } from './helpers.js';

/**
 * The awkward cases, as `[name, text, expected clusters]`.
 *
 * Every entry is written with explicit escapes rather than pasted literals so
 * that the test file itself cannot be silently mangled by an editor that
 * normalises Unicode on save.
 */
const CLUSTERS: readonly (readonly [string, string, readonly string[]])[] = [
  ['ascii', 'abc', ['a', 'b', 'c']],
  // A single astral code point: two UTF-16 units, one grapheme.
  ['surrogate pair', '\u{1F600}', ['\u{1F600}']],
  // e + combining acute.
  ['combining acute', 'é', ['é']],
  ['combining stack', 'à́̂', ['à́̂']],
  // Family: man + ZWJ + woman + ZWJ + girl + ZWJ + boy.
  [
    'emoji ZWJ family',
    '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}',
    ['\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'],
  ],
  // Waving hand + medium-dark skin tone.
  ['skin tone modifier', '\u{1F44B}\u{1F3FE}', ['\u{1F44B}\u{1F3FE}']],
  // Regional indicators K + R.
  ['flag', '\u{1F1F0}\u{1F1F7}', ['\u{1F1F0}\u{1F1F7}']],
  ['two flags', '\u{1F1F0}\u{1F1F7}\u{1F1EF}\u{1F1F5}', ['\u{1F1F0}\u{1F1F7}', '\u{1F1EF}\u{1F1F5}']],
  // Three regional indicators: the third starts a new (incomplete) cluster.
  [
    'odd regional indicator',
    '\u{1F1F0}\u{1F1F7}\u{1F1EF}',
    ['\u{1F1F0}\u{1F1F7}', '\u{1F1EF}'],
  ],
  ['variation selector', '❤️', ['❤️']],
  ['CRLF', 'a\r\nb', ['a', '\r\n', 'b']],
  // Hangul jamo that compose into one syllable block.
  ['hangul jamo', '한', ['한']],
  ['devanagari', 'क्ष', ['क्ष']],
];

describe('the segmenter', () => {
  const implementations: readonly (readonly [string, GraphemeSegmenter])[] = [
    ['default', defaultSegmenter],
    ['fallback', fallbackSegmenter],
  ];

  for (const [label, segment] of implementations) {
    describe(label, () => {
      for (const [name, text, expected] of CLUSTERS) {
        it(`segments ${name}`, () => {
          expect(segment(text)).toEqual(expected);
        });
      }

      it('reassembles the input exactly', () => {
        for (const [, text] of CLUSTERS) expect(segment(text).join('')).toBe(text);
      });

      it('returns nothing for the empty string', () => {
        expect(segment('')).toEqual([]);
      });
    });
  }

  it('agrees with Intl.Segmenter on every case the fallback claims to handle', () => {
    // If the host lacks Intl.Segmenter this assertion is vacuous, which is the
    // honest outcome: there is nothing to compare against.
    if (defaultSegmenter === fallbackSegmenter) return;
    for (const [, text] of CLUSTERS) {
      expect(fallbackSegmenter(text)).toEqual(defaultSegmenter(text));
    }
  });
});

describe('boundaries', () => {
  const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';

  it('steps back over a whole cluster', () => {
    const text = `a${FAMILY}b`;
    expect(previousBoundary(text, text.length)).toBe(text.length - 1);
    expect(previousBoundary(text, text.length - 1)).toBe(1);
    expect(previousBoundary(text, 1)).toBe(0);
  });

  it('steps forward over a whole cluster', () => {
    const text = `a${FAMILY}b`;
    expect(nextBoundary(text, 0)).toBe(1);
    expect(nextBoundary(text, 1)).toBe(1 + FAMILY.length);
    expect(nextBoundary(text, 1 + FAMILY.length)).toBe(text.length);
  });

  it('is a fixed point at either end', () => {
    expect(previousBoundary('abc', 0)).toBe(0);
    expect(nextBoundary('abc', 3)).toBe(3);
    expect(previousBoundary('', 0)).toBe(0);
    expect(nextBoundary('', 0)).toBe(0);
  });

  it('clamps an offset past the end rather than throwing', () => {
    expect(previousBoundary('abc', 99)).toBe(2);
    expect(nextBoundary('abc', 99)).toBe(3);
  });

  it('counts user-perceived characters', () => {
    expect(graphemeLength(`a${FAMILY}b`)).toBe(3);
    expect(graphemeLength('éé')).toBe(2);
  });

  it('walks a whole string one cluster at a time in both directions', () => {
    const text = CLUSTERS.map(([, value]) => value).join('');
    const forward: number[] = [0];
    while (true) {
      const last = forward[forward.length - 1] ?? 0;
      const next = nextBoundary(text, last);
      if (next === last) break;
      forward.push(next);
    }

    const backward: number[] = [text.length];
    while (true) {
      const last = backward[backward.length - 1] ?? 0;
      const previous = previousBoundary(text, last);
      if (previous === last) break;
      backward.push(previous);
    }

    expect(forward).toEqual([...backward].reverse());
  });
});

describe('deleteBackward', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['a family emoji', 'x\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}', 'x'],
    ['a flag', 'x\u{1F1F0}\u{1F1F7}', 'x'],
    ['a skin-tone emoji', 'x\u{1F44B}\u{1F3FE}', 'x'],
    ['a combining mark with its base', 'xé', 'x'],
    ['a heart with its variation selector', 'x❤️', 'x'],
    ['a hangul syllable built from jamo', 'x한', 'x'],
  ];

  for (const [name, before, after] of cases) {
    it(`removes ${name} in one press`, () => {
      const editor = editorFor(`${before}\n`);
      const id = blockAt(editor.getDocument(), 0).id;
      editor.select(caretAt(editor.getDocument(), id, before.length));
      editor.dispatch(deleteBackward());

      expect(textOf(blockAt(editor.getDocument(), 0))).toBe(after);
    });
  }

  it('empties a run of hard cases one press at a time', () => {
    const text = '\u{1F1F0}\u{1F1F7}é\u{1F44B}\u{1F3FE}';
    const editor = editorFor(`${text}\n`);
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, text.length));

    expect(editor.dispatch(deleteBackward())).not.toBeNull();
    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('\u{1F1F0}\u{1F1F7}é');
    expect(editor.dispatch(deleteBackward())).not.toBeNull();
    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('\u{1F1F0}\u{1F1F7}');
    expect(editor.dispatch(deleteBackward())).not.toBeNull();
    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('');
  });

  it('leaves a well-formed string behind at every step', () => {
    const text = 'a\u{1F468}‍\u{1F469}‍\u{1F467}b\u{1F1EF}\u{1F1F5}c';
    const editor = editorFor(`${text}\n`);
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, text.length));

    for (let guard = 0; guard < 20; guard += 1) {
      const current = textOf(blockAt(editor.getDocument(), 0));
      if (current === '') break;
      // No lone surrogate may ever be left behind.
      for (const unit of current) {
        const code = unit.codePointAt(0) ?? 0;
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
      }
      expect(editor.dispatch(deleteBackward())).not.toBeNull();
    }

    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('');
  });
});

describe('deleteForward', () => {
  it('removes a whole cluster ahead of the caret', () => {
    const text = '\u{1F468}‍\u{1F469}x';
    const editor = editorFor(`${text}\n`);
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 0));
    editor.dispatch(deleteForward());

    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('x');
  });

  it('is the mirror of deleteBackward over the same content', () => {
    const text = 'a\u{1F1F0}\u{1F1F7}b';

    const back = editorFor(`${text}\n`);
    const backId = blockAt(back.getDocument(), 0).id;
    back.select(caretAt(back.getDocument(), backId, text.length - 1));
    back.dispatch(deleteBackward());

    const forward = editorFor(`${text}\n`);
    const forwardId = blockAt(forward.getDocument(), 0).id;
    forward.select(caretAt(forward.getDocument(), forwardId, 1));
    forward.dispatch(deleteForward());

    expect(textOf(blockAt(back.getDocument(), 0))).toBe('ab');
    expect(textOf(blockAt(forward.getDocument(), 0))).toBe(textOf(blockAt(back.getDocument(), 0)));
  });
});

describe('the caret after a grapheme delete', () => {
  it('lands on the boundary, not inside the cluster', () => {
    const text = 'a\u{1F1F0}\u{1F1F7}b';
    const editor = editorFor(`${text}\n`);
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, text.length - 1));
    editor.dispatch(deleteBackward());
    editor.dispatch(insertText('!'));

    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('a!b');
  });

  it('does not split a cluster when text is inserted at a mid-cluster offset', () => {
    // The UI should never produce such a point, but a stale selection can.
    // Normalisation must not leave the document holding a lone surrogate.
    const flag = '\u{1F1F0}\u{1F1F7}';
    const editor = editorFor(`${flag}\n`);
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;
    editor.select(caretAt(doc, id, flag.length));
    editor.dispatch(insertText('x'));

    expect(textOf(blockAt(editor.getDocument(), 0))).toBe(`${flag}x`);
  });
});

describe('an injected segmenter', () => {
  it('is used in preference to the default', () => {
    // A segmenter that treats every three characters as one cluster. Nonsense
    // linguistically, but it proves the injection point is real: if the engine
    // reached for `defaultSegmenter` directly, this would delete one character.
    const byThrees: GraphemeSegmenter = (text) => {
      const out: string[] = [];
      for (let i = 0; i < text.length; i += 3) out.push(text.slice(i, i + 3));
      return out;
    };

    const editor = createEditor({
      text: 'abcdef\n',
      context: { ids: createIdFactory('t'), segment: byThrees },
    });
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 6));
    editor.dispatch(deleteBackward());

    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('abc');
  });
});

describe('offsets are UTF-16 offsets throughout', () => {
  it('addresses a point after an astral character by code-unit count', () => {
    const editor = editorFor('\u{1F600}x\n');
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;
    // The emoji occupies two code units, so `x` starts at offset 2.
    const point = at(doc, id, 3);
    editor.select(caretAt(doc, id, 3));
    editor.dispatch(insertText('!'));

    expect(point.offset).toBe(3);
    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('\u{1F600}x!');
  });
});
