/**
 * DOM selection ↔ engine selection.
 *
 * The fake tree here is not hand-written text: it is rendered *from the engine's
 * own runs*, exactly as `../blocks/Editable.tsx` renders them. That is the point
 * of the test. Hand-writing the DOM would let the fixture drift into agreeing
 * with the mapper about a document the engine would never produce, and the bug
 * this whole layer exists to prevent — DOM text and engine text disagreeing by a
 * character — would pass unnoticed.
 */

import { describe, expect, it } from 'vitest';
import type { Block, InlineContainer, MdvDocument, Point } from '../../engine/index.js';
import { createEditor, fromAbsolute, resolveContainer, runsText, toAbsolute } from '../../engine/index.js';
import type { NodeLike } from '../dom/contract.js';
import { offsetInContainer } from '../dom/offsets.js';
import {
  domSelectionMatches,
  domTargetFor,
  pointFromDom,
  pointToDom,
  readDomSelection,
} from '../dom/selection.js';
import { block, container, element, firstText } from './fake-dom.js';

/** Build a document and the DOM a faithful renderer would produce for it. */
function render(source: string): { readonly doc: MdvDocument; readonly root: NodeLike } {
  const editor = createEditor({ text: source });
  const doc = editor.getDocument();
  const blocks = doc.blocks.map((node) => block(node.id, containersOf(node)));
  return { doc, root: element('div', { class: 'mdv-surface' }, blocks) };
}

function containersOf(node: Block): readonly NodeLike[] {
  if (node.kind === 'paragraph' || node.kind === 'heading') {
    return [container(node.id, [], node.runs.map((run) => run.text))];
  }
  if (node.kind === 'table') {
    return node.rows.flatMap((row, rowIndex) =>
      row.cells.map((cell, colIndex) =>
        container(node.id, [rowIndex, colIndex], cell.runs.map((run) => run.text), { tag: 'td' }),
      ),
    );
  }
  return [];
}

/** The container element rendered for `blockId` at `path`. */
function hostFor(root: NodeLike, blockId: string, path: readonly number[]): NodeLike {
  const wanted = path.join(',');
  const search = (node: NodeLike): NodeLike | null => {
    const attribute =
      'getAttribute' in node ? (node as { getAttribute(n: string): string | null }).getAttribute : null;
    if (
      attribute !== null &&
      attribute.call(node, 'data-mdv-container') === blockId &&
      (attribute.call(node, 'data-mdv-path') ?? '') === wanted
    ) {
      return node;
    }
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes[index];
      if (child !== undefined) {
        const found = search(child);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const found = search(root);
  if (found === null) throw new Error(`no container for ${blockId} [${wanted}]`);
  return found;
}

describe('pointFromDom', () => {
  it('maps a position inside a run to the engine point at the same character', () => {
    const { doc, root } = render('Hello **bold** world\n');
    const paragraph = doc.blocks[0];
    expect(paragraph).toBeDefined();

    const host = hostFor(root, paragraph!.id, []);
    // Second run wrapper is the bold one; offset 2 inside it is `bo|ld`.
    const boldRun = host.childNodes[1];
    expect(boldRun).toBeDefined();

    const at = pointFromDom(doc, firstText(boldRun!), 2);
    expect(at).not.toBeNull();
    expect(at?.blockId).toBe(paragraph!.id);

    const container_ = resolve(doc, at!);
    expect(toAbsolute(container_, at!)).toBe('Hello bo'.length);
  });

  it('returns null outside every container', () => {
    const { doc } = render('Hello\n');
    const stray = element('button', {}, []);
    expect(pointFromDom(doc, stray, 0)).toBeNull();
  });

  it('returns null for a container the document no longer has', () => {
    const { doc } = render('Hello\n');
    const ghost = container('missing-block', [], ['x']);
    expect(pointFromDom(doc, firstText(ghost), 0)).toBeNull();
  });

  it('maps a table cell through its [row, col] path', () => {
    const { doc, root } = render('| a | b |\n| - | - |\n| c | d |\n');
    const table = doc.blocks.find((node) => node.kind === 'table');
    expect(table).toBeDefined();

    const host = hostFor(root, table!.id, [1, 1]);
    const at = pointFromDom(doc, firstText(host), 1);
    expect(at).not.toBeNull();
    expect(at?.blockId).toBe(table!.id);
    expect(at?.path.slice(0, 2)).toEqual([1, 1]);
  });
});

describe('pointToDom', () => {
  it('round-trips every offset in a multi-run paragraph', () => {
    const { doc, root } = render('Hello **bold** world\n');
    const paragraph = doc.blocks[0];
    const host = hostFor(root, paragraph!.id, []);
    const container_ = resolve(doc, { blockId: paragraph!.id, path: [0], offset: 0 });
    const length = runsText(container_.runs).length;

    for (let offset = 0; offset <= length; offset += 1) {
      const point = fromOffset(doc, paragraph!.id, offset);
      const position = pointToDom(root, doc, point);
      expect(position).not.toBeNull();
      expect(offsetInContainer(host, position!.node, position!.offset)).toBe(offset);
    }
  });

  it('returns null for a block that is not rendered', () => {
    const { doc, root } = render('Hello\n');
    const point: Point = { blockId: 'never-rendered', path: [0], offset: 0 };
    expect(pointToDom(root, doc, point)).toBeNull();
  });
});

describe('readDomSelection', () => {
  it('reads a range within one container', () => {
    const { doc, root } = render('Hello world\n');
    const paragraph = doc.blocks[0];
    const host = hostFor(root, paragraph!.id, []);
    const node = firstText(host);

    const selection = readDomSelection(doc, {
      anchorNode: node,
      anchorOffset: 0,
      focusNode: node,
      focusOffset: 5,
    });

    expect(selection?.kind).toBe('text');
    if (selection?.kind !== 'text') throw new Error('expected a text selection');
    expect(toAbsolute(resolve(doc, selection.anchor), selection.anchor)).toBe(0);
    expect(toAbsolute(resolve(doc, selection.focus), selection.focus)).toBe(5);
  });

  it('collapses to the anchor when the focus is unmappable', () => {
    const { doc, root } = render('Hello world\n');
    const host = hostFor(root, doc.blocks[0]!.id, []);
    const selection = readDomSelection(doc, {
      anchorNode: firstText(host),
      anchorOffset: 3,
      focusNode: null,
      focusOffset: 0,
    });
    if (selection?.kind !== 'text') throw new Error('expected a text selection');
    expect(selection.anchor).toEqual(selection.focus);
  });

  it('returns null when the anchor is outside the surface', () => {
    const { doc } = render('Hello\n');
    expect(
      readDomSelection(doc, {
        anchorNode: element('div', {}, []),
        anchorOffset: 0,
        focusNode: null,
        focusOffset: 0,
      }),
    ).toBeNull();
  });
});

describe('domSelectionMatches', () => {
  it('is true for a different DOM spelling of the same caret', () => {
    const { doc, root } = render('Hello **bold**\n');
    const paragraph = doc.blocks[0];
    const host = hostFor(root, paragraph!.id, []);

    const target = domTargetFor(root, doc, {
      kind: 'text',
      anchor: fromOffset(doc, paragraph!.id, 6),
      focus: fromOffset(doc, paragraph!.id, 6),
    });
    expect(target).not.toBeNull();

    // The engine's offset 6 is the end of run 0 *and* the start of run 1. The
    // browser may report either; both must compare equal or the sync loops.
    const secondRun = host.childNodes[1];
    const matched = domSelectionMatches(
      {
        anchorNode: firstText(secondRun!),
        anchorOffset: 0,
        focusNode: firstText(secondRun!),
        focusOffset: 0,
      },
      target!,
    );
    expect(matched).toBe(true);
  });

  it('is false when the DOM is somewhere else', () => {
    const { doc, root } = render('Hello world\n');
    const paragraph = doc.blocks[0];
    const host = hostFor(root, paragraph!.id, []);
    const target = domTargetFor(root, doc, {
      kind: 'text',
      anchor: fromOffset(doc, paragraph!.id, 0),
      focus: fromOffset(doc, paragraph!.id, 0),
    });

    expect(
      domSelectionMatches(
        { anchorNode: firstText(host), anchorOffset: 4, focusNode: firstText(host), focusOffset: 4 },
        target!,
      ),
    ).toBe(false);
  });

  it('is false when the DOM selection is in another block', () => {
    const { doc, root } = render('One\n\nTwo\n');
    const first = doc.blocks[0];
    const second = doc.blocks[1];
    const target = domTargetFor(root, doc, {
      kind: 'text',
      anchor: fromOffset(doc, first!.id, 0),
      focus: fromOffset(doc, first!.id, 0),
    });
    const otherHost = hostFor(root, second!.id, []);

    expect(
      domSelectionMatches(
        {
          anchorNode: firstText(otherHost),
          anchorOffset: 0,
          focusNode: firstText(otherHost),
          focusOffset: 0,
        },
        target!,
      ),
    ).toBe(false);
  });
});

describe('domTargetFor', () => {
  it('refuses a selection shape the DOM cannot express', () => {
    const { doc, root } = render('Hello\n');
    expect(domTargetFor(root, doc, { kind: 'node', blockId: doc.blocks[0]!.id })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

/** The inline container a point addresses. Throws, so tests stay short. */
function resolve(doc: MdvDocument, at: Point): InlineContainer {
  const found = resolveContainer(doc, at);
  if (found === undefined) throw new Error('container did not resolve');
  return found;
}

/** A point `offset` characters into the first container of `blockId`. */
function fromOffset(doc: MdvDocument, blockId: string, offset: number): Point {
  return fromAbsolute(resolve(doc, { blockId, path: [0], offset: 0 }), offset);
}
