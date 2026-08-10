/**
 * Formatting, driven the way an editor drives it (SPEC 29.4).
 *
 * Two properties matter, and everything here is one of them:
 *
 * 1. **Applying the edits produces exactly what `mdv fmt` would write.** The
 *    tests apply the returned edits to the original text and compare against
 *    `toMarkdown(parse(source))`. Asserting on the edits themselves would test
 *    the diff algorithm; applying them tests the contract.
 * 2. **A minimal edit is minimal.** A whole-document replacement passes the
 *    first property and is still a bug, so the ranges are asserted where the
 *    point of the exercise is that untouched lines are untouched.
 */

import { describe, expect, it } from 'vitest';
import { parse, toMarkdown } from '@mdv/parser';
import { TextDocument } from '../src/documents.js';
import { MAX_DIFF_LINES, editsWithin, splitLines, textEdits } from '../src/edits.js';
import { formatting } from '../src/features/formatting.js';
import { createServer } from '../src/server.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { InitializeResult, Range, TextEdit } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** Untidy, and canonical formatting has something to say about every line. */
const MESSY = '#    Title\n\n*   one\n*   two\n\n##   Second\n\ntext\n';

interface Started {
  readonly client: TestClient;
  readonly errors: string[];
  readonly result: InitializeResult;
}

/** A server with formatting installed, past the handshake. */
async function started(): Promise<Started> {
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [formatting()],
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, errors, result };
}

/** What the client would end up with, having applied what the server sent. */
function apply(source: string, edits: readonly TextEdit[]): string {
  const document = new TextDocument(URI, 'mdv', 1, source);
  // Back to front, so an earlier edit's offsets are still valid.
  const ordered = [...edits].sort(
    (a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start),
  );
  let text = source;
  for (const edit of ordered) {
    text =
      text.slice(0, document.offsetAt(edit.range.start)) +
      edit.newText +
      text.slice(document.offsetAt(edit.range.end));
  }
  return text;
}

function format(source: string): string {
  return toMarkdown(parse(source));
}

describe('textDocument/formatting', () => {
  it('is advertised, both halves of it', async () => {
    const { result } = await started();
    expect(result.capabilities.documentFormattingProvider).toBe(true);
    expect(result.capabilities.documentRangeFormattingProvider).toBe(true);
  });

  it('returns edits that produce what `mdv fmt` writes', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, MESSY));
    await settle();

    const edits = (await client.call('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
    })) as TextEdit[];

    expect(apply(MESSY, edits)).toBe(format(MESSY));
    expect(format(MESSY)).not.toBe(MESSY);
  });

  it('says null when the document is already canonical', async () => {
    const { client } = await started();
    const canonical = format(MESSY);
    client.notify('textDocument/didOpen', openParams(URI, canonical));
    await settle();

    const edits = await client.call('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits).toBeNull();
  });

  it('ignores the editor’s tab size, which SPEC 5.3.1 does not allow', async () => {
    const { client } = await started();
    const source = '# A\n\n## B\n\ntext\n';
    client.notify('textDocument/didOpen', openParams(URI, source));
    await settle();

    // `tabSize: 8, insertSpaces: false` is a real editor configuration. Honouring
    // it would emit tab-indented headers, which re-parse as MDV1212.
    const edits = await client.call('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 8, insertSpaces: false },
    });
    expect(edits).toBeNull();
  });

  it('refuses a document it has never seen', async () => {
    const { client } = await started();
    const response = await client.request('textDocument/formatting', {
      textDocument: { uri: 'file:///gone.mdv' },
      options: { tabSize: 2, insertSpaces: true },
    });
    // Not `internalError`: the client named a document the server does not have,
    // which is the client's mistake and is worth saying so.
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('keeps formatting a document that has diagnostics', async () => {
    // A file with problems is exactly when an author reaches for the formatter.
    const source = '#    Title\n\ntext\n';
    const { client, errors } = await started();
    client.notify('textDocument/didOpen', openParams(URI, source));
    await settle();

    const edits = (await client.call('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
    })) as TextEdit[];
    expect(parse(source).diagnostics.length).toBeGreaterThan(0);
    expect(apply(source, edits)).toBe(format(source));
    expect(errors).toEqual([]);
  });
});

describe('textDocument/rangeFormatting', () => {
  it('touches nothing outside the selection', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, MESSY));
    await settle();

    // Lines 0-3: the heading and the two list items, not `## Second`.
    const edits = (await client.call('textDocument/rangeFormatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
    })) as TextEdit[];

    const applied = apply(MESSY, edits);
    expect(applied).toContain('##   Second');
    expect(applied).not.toContain('#    Title');
    expect(applied).not.toContain('*   one');
  });

  it('says null when the selection holds nothing to fix', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, MESSY));
    await settle();

    // The blank line between the list and `## Second`.
    const edits = await client.call('textDocument/rangeFormatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
      range: { start: { line: 4, character: 0 }, end: { line: 5, character: 0 } },
    });
    expect(edits).toBeNull();
  });

  it('formatting the whole range equals formatting the document', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, MESSY));
    await settle();

    const whole = { textDocument: { uri: URI }, options: { tabSize: 2, insertSpaces: true } };
    const all = (await client.call('textDocument/formatting', whole)) as TextEdit[];
    const ranged = (await client.call('textDocument/rangeFormatting', {
      ...whole,
      range: { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } },
    })) as TextEdit[];
    expect(ranged).toEqual(all);
  });
});

describe('the diff', () => {
  const document = (text: string): TextDocument => new TextDocument(URI, 'mdv', 1, text);

  it('keeps every line terminator with its line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLines('a\nb')).toEqual(['a\n', 'b']);
    expect(splitLines('\n')).toEqual(['\n']);
    // Empty text is no lines, not one empty one.
    expect(splitLines('')).toEqual([]);
  });

  it('changes one line in the middle and leaves the rest alone', () => {
    const before = 'one\ntwo\nthree\n';
    const edits = textEdits(document(before), 'one\nTWO\nthree\n');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 2, character: 0 },
    });
    expect(apply(before, edits)).toBe('one\nTWO\nthree\n');
  });

  it('reports two separated changes as two edits', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const edits = textEdits(document(before), 'A\nb\nc\nd\nE\n');
    expect(edits).toHaveLength(2);
    expect(apply(before, edits)).toBe('A\nb\nc\nd\nE\n');
  });

  it('inserts without replacing the line it inserts before', () => {
    const before = 'a\nc\n';
    const edits = textEdits(document(before), 'a\nb\nc\n');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.range.start).toEqual(edits[0]?.range.end);
    expect(apply(before, edits)).toBe('a\nb\nc\n');
  });

  it('deletes with an empty replacement', () => {
    const before = 'a\nb\nc\n';
    const edits = textEdits(document(before), 'a\nc\n');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.newText).toBe('');
    expect(apply(before, edits)).toBe('a\nc\n');
  });

  it('handles a document with no trailing newline at either end', () => {
    expect(apply('a\nb', textEdits(document('a\nb'), 'a\nB'))).toBe('a\nB');
    expect(apply('a\nb', textEdits(document('a\nb'), 'a\nb\n'))).toBe('a\nb\n');
    expect(apply('a\nb\n', textEdits(document('a\nb\n'), 'a\nb'))).toBe('a\nb');
  });

  it('empties and fills a document', () => {
    expect(apply('a\n', textEdits(document('a\n'), ''))).toBe('');
    expect(apply('', textEdits(document(''), 'a\n'))).toBe('a\n');
  });

  it('has nothing to say about identical text', () => {
    expect(textEdits(document('a\nb\n'), 'a\nb\n')).toEqual([]);
    expect(textEdits(document(''), '')).toEqual([]);
  });

  it('produces edits in order, none of them overlapping', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}\n`).join('');
    const after = before.replace(/line (3|11|29)\n/g, 'LINE $1\n');
    const doc = document(before);
    const edits = textEdits(doc, after);
    expect(edits).toHaveLength(3);
    let previous = -1;
    for (const edit of edits) {
      const start = doc.offsetAt(edit.range.start);
      expect(start).toBeGreaterThan(previous);
      previous = doc.offsetAt(edit.range.end);
    }
    expect(apply(before, edits)).toBe(after);
  });

  it('falls back to one hunk rather than a quadratic blowup', () => {
    // Two documents that share nothing, longer than the diff is willing to be
    // careful about. The answer must still be correct.
    const before = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `a${i}\n`).join('');
    const after = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `b${i}\n`).join('');
    const edits = textEdits(document(before), after);
    expect(edits).toHaveLength(1);
    expect(apply(before, edits)).toBe(after);
  });

  it('survives a real formatting pass, one edit per untidy line', () => {
    const edits = textEdits(document(MESSY), format(MESSY));
    expect(apply(MESSY, edits)).toBe(format(MESSY));
    expect(edits.length).toBeLessThan(splitLines(MESSY).length);
  });
});

describe('editsWithin', () => {
  const range = (startLine: number, endLine: number): Range => ({
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: 0 },
  });
  const source = 'a\nb\nc\nd\ne\n';
  const document = new TextDocument(URI, 'mdv', 1, source);
  const edits = textEdits(document, 'A\nb\nC\nd\nE\n');

  it('keeps the edits inside and drops the rest', () => {
    expect(editsWithin(edits, range(0, 1))).toHaveLength(1);
    expect(editsWithin(edits, range(0, 3))).toHaveLength(2);
    expect(editsWithin(edits, range(0, 5))).toHaveLength(3);
    expect(editsWithin(edits, range(1, 2))).toHaveLength(0);
  });

  it('will not half-apply an edit that straddles the boundary', () => {
    const straddling = textEdits(new TextDocument(URI, 'mdv', 1, source), 'a\nX\n');
    expect(straddling).toHaveLength(1);
    expect(editsWithin(straddling, range(1, 3))).toHaveLength(0);
    expect(editsWithin(straddling, range(1, 5))).toHaveLength(1);
  });

  it('counts a selection that stops mid-line as covering that line', () => {
    const partial = { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } };
    expect(editsWithin(edits, partial)).toHaveLength(2);
  });
});
