/**
 * `beforeinput` → editor intent, and the text boundaries two of them need.
 *
 * `beforeinput` is the only input channel that is both complete and honest: it
 * covers typing, autocorrect, dictation, drag-and-drop, the platform's own
 * "undo" gesture and the bold/italic gestures an on-screen keyboard offers, and
 * it fires *before* the DOM changes. Building an editor on `keydown` alone
 * means guessing at every one of those, and guessing wrong for every input
 * method and every locale that is not the one it was tested against.
 *
 * So the surface translates one `InputEvent` into one {@link EditorIntent} here
 * — a pure function, which is what lets the whole input layer be tested without
 * a browser — and executes it there.
 *
 * Two inputs are deliberately *not* translated into edits:
 *
 * - anything not `cancelable`, which is how Android soft keyboards and some
 *   dictation engines deliver text, and
 * - `insertCompositionText`, which must not be cancelled or an IME breaks.
 *
 * Both become {@link EditorIntent} `reconcile`: let the browser write, then
 * diff the subtree against the engine and replay the difference as one edit.
 * That is the only correct answer, because the alternative — cancelling — makes
 * Korean, Japanese and Chinese input drop or duplicate syllables.
 *
 * @see https://www.w3.org/TR/input-events-2/
 */

import type { MarkType } from '../../engine/index.js';

/** What the surface should do about one input event. */
export type EditorIntent =
  | { readonly kind: 'insertText'; readonly text: string }
  | { readonly kind: 'insertParagraph' }
  | { readonly kind: 'insertLineBreak' }
  | { readonly kind: 'deleteBackward' }
  | { readonly kind: 'deleteForward' }
  | { readonly kind: 'deleteWordBackward' }
  | { readonly kind: 'deleteWordForward' }
  | { readonly kind: 'deleteLineBackward' }
  | { readonly kind: 'deleteLineForward' }
  /** Delete what is selected, whatever shape the selection has. */
  | { readonly kind: 'deleteSelection' }
  | { readonly kind: 'toggleMark'; readonly mark: MarkType }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  /** Handled by the `paste`/`copy`/`cut` listeners, which have the data. */
  | { readonly kind: 'clipboard' }
  /** Let the browser write, then diff the subtree back into the engine. */
  | { readonly kind: 'reconcile' }
  /** Understood, and the answer is to do nothing. */
  | { readonly kind: 'ignore' };

/** The slice of `InputEvent` the translation reads. */
export interface InputEventLike {
  readonly inputType: string;
  readonly data: string | null;
  readonly cancelable: boolean;
  /** `dataTransfer.getData('text/plain')`, already extracted by the caller. */
  readonly transferText: string | null;
}

const MARKS: Readonly<Record<string, MarkType>> = {
  formatBold: 'strong',
  formatItalic: 'emphasis',
  formatStrikeThrough: 'strikethrough',
  // `formatUnderline` has no MDV counterpart: Markdown has no underline, and
  // silently turning it into emphasis would produce a document the user did not
  // ask for. It falls through to `ignore`.
};

/**
 * Translate one input event.
 *
 * `inCode` suppresses the formatting gestures inside a code block, where a bold
 * run cannot be represented, and keeps Enter a line break rather than a new
 * paragraph.
 */
export function intentForInput(input: InputEventLike, inCode: boolean): EditorIntent {
  // Non-cancelable first: whatever it claims to be, we cannot stop it, so the
  // only honest response is to let it happen and reconcile afterwards.
  if (!input.cancelable) return { kind: 'reconcile' };

  switch (input.inputType) {
    case 'insertText':
    case 'insertReplacementText':
      return input.data === null ? { kind: 'ignore' } : { kind: 'insertText', text: input.data };

    case 'insertCompositionText':
      return { kind: 'reconcile' };

    case 'insertFromComposition':
      // Only fired by browsers that also fire a cancelable composition end;
      // treat it as ordinary text so nothing is lost if the reconcile pass has
      // already run.
      return input.data === null ? { kind: 'reconcile' } : { kind: 'insertText', text: input.data };

    case 'insertParagraph':
      // A code block holds literal text: Enter adds a line to it rather than
      // ending the block.
      return inCode ? { kind: 'insertText', text: '\n' } : { kind: 'insertParagraph' };

    case 'insertLineBreak':
      return inCode ? { kind: 'insertText', text: '\n' } : { kind: 'insertLineBreak' };

    case 'insertFromPaste':
    case 'insertFromPasteAsQuotation':
    case 'insertFromYank':
    case 'deleteByCut':
      return { kind: 'clipboard' };

    case 'insertFromDrop':
    case 'deleteByDrag':
      // The `drop` listener has the transfer and does the whole move; letting
      // this through as well would insert the text twice.
      return { kind: 'ignore' };

    case 'insertTranspose':
      return { kind: 'reconcile' };

    case 'deleteContentBackward':
      return { kind: 'deleteBackward' };
    case 'deleteContentForward':
      return { kind: 'deleteForward' };
    case 'deleteContent':
      return { kind: 'deleteSelection' };
    case 'deleteWordBackward':
      return { kind: 'deleteWordBackward' };
    case 'deleteWordForward':
      return { kind: 'deleteWordForward' };
    case 'deleteSoftLineBackward':
    case 'deleteHardLineBackward':
      return { kind: 'deleteLineBackward' };
    case 'deleteSoftLineForward':
    case 'deleteHardLineForward':
      return { kind: 'deleteLineForward' };
    case 'deleteEntireSoftLine':
      return { kind: 'deleteLineBackward' };

    case 'historyUndo':
      return { kind: 'undo' };
    case 'historyRedo':
      return { kind: 'redo' };

    case 'formatBold':
    case 'formatItalic':
    case 'formatStrikeThrough': {
      const mark = MARKS[input.inputType];
      if (mark === undefined || inCode) return { kind: 'ignore' };
      return { kind: 'toggleMark', mark };
    }

    default:
      // Every other `insertFrom*` carries text worth keeping — `insertLink`,
      // `insertFromParagraphSelectDrop`, vendor extensions — so take it if it
      // brought any, and otherwise refuse rather than let the browser write
      // something the engine will not know about.
      if (input.inputType.startsWith('insert')) {
        const text = input.data ?? input.transferText;
        if (text !== null && text !== '') return { kind: 'insertText', text };
      }
      return { kind: 'ignore' };
  }
}

/**
 * Whether the event that produced `intent` must be cancelled.
 *
 * Everything is cancelled except a reconcile, which by definition is the case
 * where the browser is allowed to write. Cancelling the intents we do not
 * understand is deliberate: an uncancelled edit is an edit the engine never
 * sees, and from then on every offset in the block is wrong.
 */
export function shouldPreventDefault(intent: EditorIntent): boolean {
  return intent.kind !== 'reconcile';
}

/* -------------------------------------------------------------------------- */
/* Text boundaries                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Word deletion is computed here rather than left to the browser because the
 * browser would have to be allowed to write to do it. The rule is the familiar
 * one: eat the whitespace next to the caret, then eat the run of word
 * characters beyond it — so Ctrl-Backspace at the end of `foo bar ` lands after
 * `foo`, in one step, not two.
 *
 * `\p{L}\p{N}` and the connector punctuation class make this behave the same in
 * every script rather than only in ASCII, and all four functions step by *code
 * point*, so a boundary can never fall between the halves of a surrogate pair
 * and leave a lone surrogate in the document.
 */

const WORD = /[\p{L}\p{N}\p{Pc}\p{Mn}\p{Mc}]/u;

function isWordChar(codePoint: number): boolean {
  return WORD.test(String.fromCodePoint(codePoint));
}

function isSpace(codePoint: number): boolean {
  return /\s/u.test(String.fromCodePoint(codePoint));
}

/** The code point ending at `offset`, and where it starts. */
function before(text: string, offset: number): { readonly codePoint: number; readonly start: number } | null {
  if (offset <= 0) return null;
  const code = text.charCodeAt(offset - 1);
  if (code >= 0xdc00 && code <= 0xdfff && offset >= 2) {
    const high = text.charCodeAt(offset - 2);
    if (high >= 0xd800 && high <= 0xdbff) {
      return { codePoint: (high - 0xd800) * 0x400 + (code - 0xdc00) + 0x10000, start: offset - 2 };
    }
  }
  return { codePoint: code, start: offset - 1 };
}

/** The code point starting at `offset`, and where it ends. */
function after(text: string, offset: number): { readonly codePoint: number; readonly end: number } | null {
  if (offset >= text.length) return null;
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return null;
  return { codePoint, end: offset + (codePoint > 0xffff ? 2 : 1) };
}

/** Offset of the start of the word before `offset`. */
export function wordStartBefore(text: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, text.length));
  for (let step = before(text, at); step !== null && isSpace(step.codePoint); step = before(text, at)) {
    at = step.start;
  }
  for (let step = before(text, at); step !== null && isWordChar(step.codePoint); step = before(text, at)) {
    at = step.start;
  }
  // A caret against punctuation eats exactly that one character, so the
  // function always makes progress and the caller never loops.
  if (at === Math.min(offset, text.length)) {
    const step = before(text, at);
    if (step !== null) at = step.start;
  }
  return at;
}

/** Offset of the end of the word after `offset`. */
export function wordEndAfter(text: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, text.length));
  for (let step = after(text, at); step !== null && isSpace(step.codePoint); step = after(text, at)) {
    at = step.end;
  }
  for (let step = after(text, at); step !== null && isWordChar(step.codePoint); step = after(text, at)) {
    at = step.end;
  }
  if (at === Math.max(0, Math.min(offset, text.length))) {
    const step = after(text, at);
    if (step !== null) at = step.end;
  }
  return at;
}

/**
 * Offset of the start of the line containing `offset`.
 *
 * This is the *hard* line — the one bounded by newlines in the source. Soft
 * wraps are a layout fact the engine has no access to, and the surface maps
 * `deleteSoftLineBackward` here on purpose: deleting to the start of the
 * paragraph is the conservative reading, and it is what a caret on an unwrapped
 * line means anyway.
 */
export function lineStartBefore(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  const newline = text.lastIndexOf('\n', at - 1);
  return newline === -1 ? 0 : newline + 1;
}

/** Offset of the end of the line containing `offset`. */
export function lineEndAfter(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  const newline = text.indexOf('\n', at);
  return newline === -1 ? text.length : newline;
}
