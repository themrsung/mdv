/**
 * The chrome/content boundary.
 *
 * Four regressions found by authoring a document through the UI live here. A
 * code fence's language field and an image's alt box are focusable elements
 * inside the editing surface, and every path that reads "the browser moved its
 * focus" used to conclude "so move the engine's caret". The field then lost
 * focus on its first keystroke, which is Bug 6 in the authoring log: the info
 * string could only be set by editing the source.
 *
 * The third is the same mistake read backwards: focus returning to the surface
 * does not mean the writer chose a caret, and the link dialog was losing one
 * that way. The fourth is what that caret should be once it survives — a park
 * puts back whatever the engine holds, so a link dialog that finishes holding
 * its own words puts *them* back, and the next keystroke deletes them.
 */

import { describe, expect, it } from 'vitest';
import { block, container, element, firstText, text } from './fake-dom.js';
import {
  absoluteOf,
  blockAt,
  caretAt,
  editorFor,
  rangeIn,
} from '../../engine/__tests__/helpers.js';
import type { TextSelection } from '../../engine/index.js';
import { commands } from '../../engine/index.js';
import type { NodeLike } from '../dom/contract.js';
import { focusIsControl, isControl } from '../dom/controls.js';
import { caretAfterLink } from '../menus/link-caret.js';
import { parkedAfter } from '../surface/focus-park.js';

/** A document with `activeElement`, which is all `focusIsControl` reads. */
function documentWith(active: NodeLike | null): Document {
  return { activeElement: active } as unknown as Document;
}

describe('isControl', () => {
  it('answers false for document content', () => {
    const paragraph = container('mdv-0', [], ['Intro paragraph']);
    expect(isControl(firstText(paragraph))).toBe(false);
    expect(isControl(paragraph)).toBe(false);
  });

  it('answers true for a field, whatever it holds the caret with', () => {
    for (const tag of ['input', 'textarea', 'select', 'button']) {
      expect(isControl(element(tag))).toBe(true);
    }
  });

  it("finds the field a text node sits in - the fence's language box", () => {
    // `../blocks/BlockView.tsx`, case 'code': the info input rides along with
    // the `<pre>` inside the block wrapper.
    const info = element('input', { class: 'mdv-pre__info' }, [text('ts')]);
    const fence = block('mdv-1', [element('pre', {}, [container('mdv-1', [], ['x'])]), info]);
    expect(isControl(firstText(info))).toBe(true);
    expect(isControl(fence)).toBe(false);
  });

  it('stops at the editable container, so a wrapping label is not a control', () => {
    // An inspector row labels its field; a block that put its content inside
    // one would otherwise report the whole document as chrome.
    const content = container('mdv-2', [], ['Body text']);
    const labelled = element('label', {}, [element('span', {}, [text('Alt text')]), content]);
    expect(isControl(firstText(content))).toBe(false);
    expect(isControl(labelled)).toBe(true);
  });

  it('answers false for nothing', () => {
    expect(isControl(null)).toBe(false);
    expect(isControl(undefined)).toBe(false);
  });
});

describe('focusIsControl', () => {
  it('reads the focus at the moment of the call', () => {
    const info = element('input', { class: 'mdv-pre__info' });
    expect(focusIsControl(documentWith(info))).toBe(true);
    expect(focusIsControl(documentWith(container('mdv-0', [], ['Intro'])))).toBe(false);
  });

  it('answers false when nothing is focused', () => {
    expect(focusIsControl(documentWith(null))).toBe(false);
    expect(focusIsControl(null)).toBe(false);
    expect(focusIsControl(undefined)).toBe(false);
  });
});

/**
 * Bug 9: a fence's language field held the browser's focus after the writer
 * clicked the empty space below the document, so the paragraph that click
 * opened was created and then typed *past* — the next keystroke went on
 * editing the language. The surface answers a press with this rule, and the
 * asymmetry is the whole of it: a render is not allowed to take focus out of a
 * control, a press somewhere else is.
 */
describe('a press that leaves a control', () => {
  /** The condition `EditorSurface`'s `pointerdown` records for the reconcile. */
  function leavesControl(active: NodeLike | null, pressed: NodeLike): boolean {
    return !isControl(pressed) && focusIsControl(documentWith(active));
  }

  const languageField = element('input', { class: 'mdv-pre__info' });
  const fence = block('mdv-1', [languageField, container('mdv-1', [], ['const a = 1;'])]);
  /** The surface's padding: a press below the last block hits no block at all. */
  const padding = element('div', { class: 'mdv-surface' });

  it('says yes when the press lands on the surface', () => {
    expect(leavesControl(languageField, padding)).toBe(true);
  });

  it('says no when the press lands back in the field', () => {
    // The flag is recorded on *every* press, so returning to the field must
    // clear what an earlier press set rather than leave it armed.
    expect(leavesControl(languageField, languageField)).toBe(false);
  });

  it('says no when the caret was in the document all along', () => {
    expect(leavesControl(firstText(fence), padding)).toBe(false);
  });

  it('says no when nothing was focused', () => {
    expect(leavesControl(null, padding)).toBe(false);
  });
});

/**
 * Bug 12: the link dialog handed focus back to the surface, an editing host
 * focused while holding no range was given one at its very start, and the
 * `selectionchange` that followed read as a click there — so the caret came
 * back to the top of the block instead of to the words that were linked.
 *
 * The surface parks the engine's selection across the trip. What the rule has
 * to get right is which trips: `parkedAfter` is that rule, and every case below
 * is a way it was wrong before, or a way it would break the editor if it were.
 */
describe('parkedAfter', () => {
  it('parks when focus leaves for something that named itself', () => {
    expect(parkedAfter(false, 'left-for')).toBe(true);
  });

  it('leaves a render tearing out the host alone', () => {
    // A `focusout` with no `relatedTarget` is how the browser reports a
    // paragraph becoming a heading. Parking on that would park on every
    // block-type change, and the next click would be overruled by the park.
    expect(parkedAfter(false, 'left-unknown')).toBe(false);
    // It cannot unpark either: the dialog's own open can report this way.
    expect(parkedAfter(true, 'left-unknown')).toBe(true);
  });

  it('unparks on the way back in', () => {
    expect(parkedAfter(true, 'returned')).toBe(false);
  });

  it('answers one homecoming, not every later one', () => {
    // Restoring on a second `focusin` would put the caret back at the link
    // long after the writer had moved on.
    expect(parkedAfter(parkedAfter(true, 'returned'), 'returned')).toBe(false);
  });

  it('lets a press outrank a selection parked before the writer left', () => {
    // Coming back from the dialog by clicking elsewhere in the document is a
    // choice, not a homecoming.
    expect(parkedAfter(true, 'pressed')).toBe(false);
  });
});

/**
 * Bug 13: with Bug 12 fixed the park faithfully restored what the engine held —
 * and what it held after the link dialog was the range over the words that had
 * just been linked. Typing `.` to end the sentence deleted the link instead.
 *
 * `toggleMark` returns that range on purpose, so the dialog is the one that has
 * to say otherwise. These are the shapes it has to say it about.
 */
describe('caretAfterLink', () => {
  const LINK = { type: 'link', href: 'https://example.com/mdv', title: null } as const;

  /**
   * The dialog's sequence over `A quick tour and a link`: select the last word,
   * apply the link, then ask where to leave the selection. `from`/`to` are
   * absolute offsets in the paragraph, in the order the writer selected them.
   */
  function linkTheLastWord(from: number, to: number): { after: TextSelection; end: number } {
    const editor = editorFor('A quick tour and a link');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(rangeIn(editor.getDocument(), id, from, to));
    editor.dispatch(commands.toggleMark(LINK));
    const after = caretAfterLink(editor.getDocument(), editor.getSelection());
    if (after.kind !== 'text') throw new Error(`expected a text selection, got ${after.kind}`);
    // Marking splits the run, so the point's own `offset` is relative to a run
    // that did not exist when the selection was made. Absolutes compare.
    return { after, end: absoluteOf(editor.getDocument(), after.focus) };
  }

  it('leaves a caret after the words it linked', () => {
    // The four characters of "link", the repro from the authoring log.
    const { after, end } = linkTheLastWord(19, 23);
    expect(after.anchor).toEqual(after.focus);
    // Past the link text, which is where the sentence goes on. The mark is
    // non-inclusive at that edge (Bug 8), so the `.` typed there lands outside.
    expect(end).toBe(23);
  });

  it('collapses to the end of the range, not to where the drag started', () => {
    // Selecting right-to-left — shift+Left from the end of the paragraph, which
    // is exactly how the repro selected the word — puts the anchor last.
    expect(linkTheLastWord(23, 19).end).toBe(23);
  });

  it('keeps a caret where it is, so a pending link still marks what is typed', () => {
    // Cmd+K with nothing selected sets a pending mark; moving the caret would
    // drop it, and there are no words to be after.
    const editor = editorFor('A quick tour and a ');
    const id = blockAt(editor.getDocument(), 0).id;
    const before = caretAt(editor.getDocument(), id, 19);
    editor.select(before);
    expect(caretAfterLink(editor.getDocument(), editor.getSelection())).toEqual(before);
  });

  it('passes a selection that is not text through untouched', () => {
    const cells = {
      kind: 'cells',
      tableId: 'r1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    } as const;
    const node = { kind: 'node', blockId: 'r2' } as const;
    const doc = editorFor('A quick tour').getDocument();
    expect(caretAfterLink(doc, cells)).toBe(cells);
    expect(caretAfterLink(doc, node)).toBe(node);
  });
});
