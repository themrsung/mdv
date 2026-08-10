/**
 * `beforeinput` translation and the text boundaries.
 *
 * The composition and non-cancelable cases are the ones that matter most: get
 * them wrong and the editor is unusable in Korean, Japanese, Chinese, or on an
 * Android soft keyboard — which is to say, for most of the people who might use
 * it. They are asserted here rather than left to a manual browser check.
 */

import { describe, expect, it } from 'vitest';
import type { EditorIntent, InputEventLike } from '../input/intents.js';
import {
  intentForInput,
  lineEndAfter,
  lineStartBefore,
  shouldPreventDefault,
  wordEndAfter,
  wordStartBefore,
} from '../input/intents.js';

function event(partial: Partial<InputEventLike> & { readonly inputType: string }): InputEventLike {
  return { data: null, cancelable: true, transferText: null, ...partial };
}

function intent(
  inputType: string,
  extra: Partial<InputEventLike> = {},
  inCode = false,
): EditorIntent {
  return intentForInput(event({ inputType, ...extra }), inCode);
}

describe('intentForInput', () => {
  it('turns typed text into an insertion', () => {
    expect(intent('insertText', { data: 'a' })).toEqual({ kind: 'insertText', text: 'a' });
  });

  it('ignores an insertion with no data rather than inventing one', () => {
    expect(intent('insertText')).toEqual({ kind: 'ignore' });
  });

  it('never cancels a composition', () => {
    const composing = intent('insertCompositionText', { data: '한' });
    expect(composing).toEqual({ kind: 'reconcile' });
    expect(shouldPreventDefault(composing)).toBe(false);
  });

  it('reconciles anything it cannot cancel, whatever it claims to be', () => {
    // Android soft keyboards deliver ordinary typing this way.
    const uncancelable = intent('insertText', { data: 'x', cancelable: false });
    expect(uncancelable).toEqual({ kind: 'reconcile' });
    expect(shouldPreventDefault(uncancelable)).toBe(false);
  });

  it('maps the delete family onto the engine granularities', () => {
    expect(intent('deleteContentBackward')).toEqual({ kind: 'deleteBackward' });
    expect(intent('deleteContentForward')).toEqual({ kind: 'deleteForward' });
    expect(intent('deleteWordBackward')).toEqual({ kind: 'deleteWordBackward' });
    expect(intent('deleteWordForward')).toEqual({ kind: 'deleteWordForward' });
    expect(intent('deleteSoftLineBackward')).toEqual({ kind: 'deleteLineBackward' });
    expect(intent('deleteHardLineForward')).toEqual({ kind: 'deleteLineForward' });
    expect(intent('deleteContent')).toEqual({ kind: 'deleteSelection' });
  });

  it('leaves the clipboard to the clipboard listeners', () => {
    expect(intent('insertFromPaste')).toEqual({ kind: 'clipboard' });
    expect(intent('deleteByCut')).toEqual({ kind: 'clipboard' });
  });

  it('ignores drops, which the drop listener already handled', () => {
    expect(intent('insertFromDrop', { transferText: 'text' })).toEqual({ kind: 'ignore' });
    expect(intent('deleteByDrag')).toEqual({ kind: 'ignore' });
  });

  it('maps the platform history gestures', () => {
    expect(intent('historyUndo')).toEqual({ kind: 'undo' });
    expect(intent('historyRedo')).toEqual({ kind: 'redo' });
  });

  it('maps the formatting gestures a touch keyboard sends', () => {
    expect(intent('formatBold')).toEqual({ kind: 'toggleMark', mark: 'strong' });
    expect(intent('formatItalic')).toEqual({ kind: 'toggleMark', mark: 'emphasis' });
    expect(intent('formatStrikeThrough')).toEqual({ kind: 'toggleMark', mark: 'strikethrough' });
  });

  it('has no answer for underline, which Markdown cannot express', () => {
    expect(intent('formatUnderline')).toEqual({ kind: 'ignore' });
  });

  describe('inside a code block', () => {
    it('keeps Enter a newline instead of a new paragraph', () => {
      expect(intent('insertParagraph', {}, true)).toEqual({ kind: 'insertText', text: '\n' });
      expect(intent('insertLineBreak', {}, true)).toEqual({ kind: 'insertText', text: '\n' });
    });

    it('drops formatting that cannot be represented there', () => {
      expect(intent('formatBold', {}, true)).toEqual({ kind: 'ignore' });
    });
  });

  it('takes the text out of an unrecognised insertion', () => {
    expect(intent('insertLink', { data: 'https://example.com' })).toEqual({
      kind: 'insertText',
      text: 'https://example.com',
    });
  });

  it('refuses an unrecognised input that carries nothing', () => {
    expect(intent('formatJustifyCenter')).toEqual({ kind: 'ignore' });
  });

  it('cancels everything except a reconcile', () => {
    for (const inputType of [
      'insertText',
      'deleteContentBackward',
      'insertFromPaste',
      'formatBold',
    ]) {
      expect(shouldPreventDefault(intent(inputType, { data: 'x' }))).toBe(true);
    }
  });
});

describe('word boundaries', () => {
  it('eats trailing space and then the word', () => {
    expect(wordStartBefore('foo bar ', 8)).toBe(4);
    expect(wordStartBefore('foo bar', 7)).toBe(4);
  });

  it('stops at the start of the text', () => {
    expect(wordStartBefore('foo', 3)).toBe(0);
    expect(wordStartBefore('foo', 0)).toBe(0);
  });

  it('always makes progress, even against punctuation', () => {
    expect(wordStartBefore('a...', 4)).toBeLessThan(4);
    expect(wordEndAfter('...a', 0)).toBeGreaterThan(0);
  });

  it('works in scripts without spaces between words', () => {
    // No word break inside 日本語, so the whole run goes.
    expect(wordStartBefore('日本語', 3)).toBe(0);
  });

  it('never lands inside a surrogate pair', () => {
    const text = 'hi 👍';
    const start = wordStartBefore(text, text.length);
    expect(start).not.toBe(text.length - 1);
    expect(text.slice(start)).toBe('👍');
  });

  it('moves forward over the following word', () => {
    expect(wordEndAfter('foo bar', 3)).toBe(7);
    expect(wordEndAfter('foo bar', 0)).toBe(3);
    expect(wordEndAfter('foo', 3)).toBe(3);
  });

  it('treats combining marks as part of the word', () => {
    // e + combining acute: one word, and the boundary must not split it.
    const text = 'café next';
    expect(wordStartBefore(text, 5)).toBe(0);
  });
});

describe('line boundaries', () => {
  const text = 'first\nsecond\nthird';

  it('finds the start of the current line', () => {
    expect(lineStartBefore(text, 8)).toBe(6);
    expect(lineStartBefore(text, 0)).toBe(0);
    expect(lineStartBefore(text, 6)).toBe(6);
  });

  it('finds the end of the current line', () => {
    expect(lineEndAfter(text, 8)).toBe(12);
    expect(lineEndAfter(text, 13)).toBe(text.length);
  });

  it('clamps an offset outside the text', () => {
    expect(lineStartBefore(text, 999)).toBe(13);
    expect(lineEndAfter(text, -5)).toBe(5);
  });
});
