/**
 * The store's invariants.
 *
 * Most of the engine is pure functions over a document, tested elsewhere. What
 * is left — and what this file covers — is the small set of promises the
 * mutable box itself makes, the ones a UI is entitled to rely on without
 * checking.
 *
 * The load-bearing one is *editability*: whatever document the store is holding,
 * there is always somewhere to put the caret. An empty file parses to zero
 * blocks, which is the honest reading of it, but a surface rendering zero blocks
 * has no `contenteditable` host — no click lands, no keystroke arrives, and the
 * document cannot be recovered by any means the UI offers. `New` went through
 * exactly that path, so the invariant is asserted at every entry point that can
 * introduce a document, not just the one that was reported.
 */

import { describe, expect, it } from 'vitest';

import { createEditor } from '../editor.js';
import { insertText } from '../commands/index.js';
import { createIdFactory } from '../ids.js';
import { document as buildDocument } from '../builders.js';
import { read } from '../io/read.js';

describe('editable invariant', () => {
  it('gives an editor created from empty text a block to type into', () => {
    const editor = createEditor({ text: '' });

    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  it('keeps a block after the text is emptied', () => {
    const editor = createEditor({ text: '# Gone\n' });

    editor.setText('');

    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  it('keeps a block when an empty document is set directly', () => {
    const editor = createEditor({ text: '# Gone\n' });

    editor.setDocument(buildDocument(createIdFactory('t'), []));

    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  it('gives an editor constructed from an empty parsed document a block', () => {
    const editor = createEditor({ doc: read('', { ids: createIdFactory('t') }) });

    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  /* The point of the invariant: the caret has somewhere to land afterwards. */
  it('accepts typing immediately after the text is emptied', () => {
    const editor = createEditor({ text: '# Gone\n' });

    editor.setText('');
    editor.dispatch(insertText('back'));

    expect(editor.toText()).toBe('back\n');
  });

  /* The invariant must not leak into the file: '' has to stay ''. */
  it('does not serialise the paragraph it added', () => {
    const editor = createEditor({ text: '' });

    expect(editor.toText()).toBe('');
  });

  it('leaves a document that already has blocks untouched', () => {
    const doc = read('# Kept\n', { ids: createIdFactory('t') });
    const editor = createEditor({ doc });

    expect(editor.getDocument()).toBe(doc);
  });
});
