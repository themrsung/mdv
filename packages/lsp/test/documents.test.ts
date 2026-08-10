/**
 * The document mirror and its offset arithmetic.
 *
 * Every feature in this package converts between an LSP `(line, character)` and
 * a `@mdv/parser` offset, so an error of one here becomes a squiggle in the
 * wrong place everywhere. The round-trip properties are asserted directly.
 */

import { describe, expect, it } from 'vitest';

import { DocumentStore, TextDocument } from '../src/documents.js';
import type { Position, TextDocumentContentChangeEvent } from '../src/protocol/types.js';

const SOURCE = ['# Title', '', '```mdv bar', 'x: month', '---', 'a,b', '```', ''].join('\n');

function doc(text = SOURCE): TextDocument {
  return new TextDocument('file:///doc.mdv', 'mdv', 1, text);
}

function at(line: number, character: number): Position {
  return { line, character };
}

describe('TextDocument positions', () => {
  it('counts lines by their terminators', () => {
    expect(doc().lineCount).toBe(8);
    expect(doc('').lineCount).toBe(1);
    expect(doc('a').lineCount).toBe(1);
    expect(doc('a\n').lineCount).toBe(2);
  });

  it('round-trips every offset in the document', () => {
    const document = doc();
    for (let offset = 0; offset <= SOURCE.length; offset += 1) {
      expect(document.offsetAt(document.positionAt(offset))).toBe(offset);
    }
  });

  it('places a position at the start of each line', () => {
    const document = doc();
    expect(document.positionAt(0)).toEqual(at(0, 0));
    expect(document.positionAt(SOURCE.indexOf('```mdv'))).toEqual(at(2, 0));
    expect(document.offsetAt(at(3, 3))).toBe(SOURCE.indexOf('x: month') + 3);
  });

  it('clamps an offset outside the document', () => {
    const document = doc();
    expect(document.positionAt(-5)).toEqual(at(0, 0));
    expect(document.positionAt(9_999)).toEqual(document.positionAt(SOURCE.length));
  });

  it("clamps a character past a line's end to where the next line starts", () => {
    // VS Code sends this for a selection that ends in the virtual space after
    // the last character. Clamping to the next line's start — rather than to
    // the end of the document — is what the reference implementation does.
    const document = doc();
    expect(document.offsetAt(at(0, 500))).toBe(SOURCE.indexOf('\n') + 1);
    expect(document.offsetAt(at(0, 7))).toBe(SOURCE.indexOf('\n'));
  });

  it('clamps a line past the end to the end of the document', () => {
    const document = doc();
    expect(document.offsetAt(at(500, 0))).toBe(SOURCE.length);
    expect(document.offsetAt(at(-1, 4))).toBe(0);
  });

  it('measures characters in UTF-16 code units, as the protocol says', () => {
    // '🎯' is one code point and two code units; a `character` of 2 is after it.
    const document = doc('🎯x');
    expect(document.offsetAt(at(0, 2))).toBe(2);
    expect(document.getText({ start: at(0, 0), end: at(0, 2) })).toBe('🎯');
    expect(document.positionAt(3)).toEqual(at(0, 3));
  });

  it('reads a line without its terminator, and a range across lines', () => {
    const document = doc();
    expect(document.lineText(2)).toBe('```mdv bar');
    expect(document.lineText(7)).toBe('');
    expect(document.lineText(99)).toBe('');
    expect(document.getText({ start: at(3, 0), end: at(4, 0) })).toBe('x: month\n');
  });

  it('handles CRLF without leaving the terminator in the line text', () => {
    const document = doc('a\r\nb\r\n');
    expect(document.lineCount).toBe(3);
    expect(document.lineText(0)).toBe('a');
    expect(document.offsetAt(at(1, 0))).toBe(3);
  });

  it('reports the whole document as a range', () => {
    expect(doc('ab\ncd').fullRange()).toEqual({ start: at(0, 0), end: at(1, 2) });
  });
});

describe('TextDocument.update', () => {
  it('replaces the whole text for a change with no range', () => {
    const document = doc();
    document.update([{ text: 'new' }], 2);
    expect(document.text).toBe('new');
    expect(document.version).toBe(2);
  });

  it('applies an incremental change and re-indexes the lines', () => {
    const document = doc('one\ntwo\n');
    document.update([{ range: { start: at(1, 0), end: at(1, 3) }, text: 'three' }], 2);
    expect(document.text).toBe('one\nthree\n');
    expect(document.lineText(1)).toBe('three');
    expect(document.offsetAt(at(2, 0))).toBe(10);
  });

  it('applies changes in order, each against the text the last produced', () => {
    // The protocol's rule. Applying both against the original text would put
    // the second edit at the wrong offset — the classic multi-cursor corruption.
    const document = doc('abcdef');
    const changes: TextDocumentContentChangeEvent[] = [
      { range: { start: at(0, 0), end: at(0, 3) }, text: 'XY' },
      { range: { start: at(0, 2), end: at(0, 2) }, text: '-' },
    ];
    document.update(changes, 2);
    expect(document.text).toBe('XY-def');
  });

  it('treats an inverted range as an insertion rather than deleting backwards', () => {
    const document = doc('abcdef');
    document.update([{ range: { start: at(0, 4), end: at(0, 1) }, text: '!' }], 2);
    expect(document.text).toBe('abcd!ef');
  });

  it('inserts a newline and grows the line count', () => {
    const document = doc('ab');
    document.update([{ range: { start: at(0, 1), end: at(0, 1) }, text: '\n' }], 2);
    expect(document.lineCount).toBe(2);
    expect(document.positionAt(2)).toEqual(at(1, 0));
  });
});

describe('DocumentStore', () => {
  it('opens, tracks and closes documents', () => {
    const store = new DocumentStore();
    const item = { uri: 'file:///a.mdv', languageId: 'mdv', version: 1, text: 'a' };
    const opened = store.open(item);
    expect(store.get('file:///a.mdv')).toBe(opened);
    expect(store.all()).toHaveLength(1);
    store.close('file:///a.mdv');
    expect(store.get('file:///a.mdv')).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it('drops a change for a document that was never opened', () => {
    const store = new DocumentStore();
    const result = store.change({
      textDocument: { uri: 'file:///ghost.mdv', version: 2 },
      contentChanges: [{ text: 'invented' }],
    });
    // Inventing a buffer from a delta would publish diagnostics about text
    // nobody has open.
    expect(result).toBeUndefined();
    expect(store.all()).toHaveLength(0);
  });

  it('announces open, change and save with the reason', () => {
    const store = new DocumentStore();
    const seen: string[] = [];
    store.onDidChangeContent((event) => seen.push(`${event.reason}:${event.document.text}`));
    store.open({ uri: 'file:///a.mdv', languageId: 'mdv', version: 1, text: 'a' });
    store.change({
      textDocument: { uri: 'file:///a.mdv', version: 2 },
      contentChanges: [{ text: 'b' }],
    });
    store.save('file:///a.mdv');
    expect(seen).toEqual(['open:a', 'change:b', 'save:b']);
  });

  it('takes the text a save carries, when a client sends one', () => {
    const store = new DocumentStore();
    store.open({ uri: 'file:///a.mdv', languageId: 'mdv', version: 1, text: 'a' });
    store.save('file:///a.mdv', 'from disk');
    expect(store.get('file:///a.mdv')?.text).toBe('from disk');
    expect(store.save('file:///missing.mdv')).toBeUndefined();
  });

  it('announces a close exactly once, and not for an unknown document', () => {
    const store = new DocumentStore();
    const closed: string[] = [];
    store.onDidClose((uri) => closed.push(uri));
    store.open({ uri: 'file:///a.mdv', languageId: 'mdv', version: 1, text: 'a' });
    store.close('file:///a.mdv');
    store.close('file:///a.mdv');
    store.close('file:///never-opened.mdv');
    expect(closed).toEqual(['file:///a.mdv']);
  });

  it('stops calling a disposed listener', () => {
    const store = new DocumentStore();
    let calls = 0;
    const subscription = store.onDidChangeContent(() => {
      calls += 1;
    });
    store.open({ uri: 'file:///a.mdv', languageId: 'mdv', version: 1, text: 'a' });
    subscription.dispose();
    store.save('file:///a.mdv');
    expect(calls).toBe(1);
  });
});
