/**
 * Inline formatting commands.
 *
 * A toggle over a range is "remove if every covered character already has it,
 * otherwise add" — the rule that makes a bold button feel right when the
 * selection is half bold. A toggle at a collapsed caret changes no text at all;
 * it parks the mark in {@link EditorState.pendingMarks} for the next keystroke.
 */

import { commonMarks, hasMarkType, mapMarks, runsLength, withMark, withoutMark } from '../inline.js';
import { MappingBuilder, mapSelection } from '../mapping.js';
import type { Mark, MarkType, MdvDocument } from '../model.js';
import type { Command } from '../state.js';
import type { CellRect, Selection } from '../selection.js';
import {
  cellRect,
  containerPath,
  orderedPoints,
  requireContainer,
  resolveContainer,
  toAbsolute,
  writeContainer,
} from '../selection.js';
import { findBlock } from '../tree.js';
import { refsInRect } from '../table.js';
import { touchedBlocks } from './structure.js';

/** One contiguous stretch of one container, in absolute offsets. */
interface Span {
  readonly blockId: string;
  readonly path: readonly number[];
  readonly start: number;
  readonly end: number;
}

/**
 * Every stretch of inline content the selection covers.
 *
 * A cell selection contributes one span per cell; a text selection spanning
 * blocks contributes the tail of the first, the whole of each block between and
 * the head of the last. Formatting then becomes a fold over spans, and no
 * command has to special-case "the selection ends in a different block".
 */
export function selectedSpans(doc: MdvDocument, selection: Selection): readonly Span[] {
  if (selection.kind === 'node') return [];

  if (selection.kind === 'cells') {
    const location = findBlock(doc, selection.tableId);
    if (location?.block.kind !== 'table') return [];
    const table = location.block;
    const rect: CellRect = cellRect(selection);
    const out: Span[] = [];
    for (const ref of refsInRect(rect)) {
      const cell = table.rows[ref.row]?.cells[ref.col];
      if (!cell) continue;
      out.push({ blockId: table.id, path: [ref.row, ref.col], start: 0, end: runsLength(cell.runs) });
    }
    return out;
  }

  const [start, end] = orderedPoints(doc, selection);
  const startContainer = resolveContainer(doc, start);
  const endContainer = resolveContainer(doc, end);
  if (!startContainer || !endContainer) return [];

  const startAbs = toAbsolute(startContainer, start);
  const endAbs = toAbsolute(endContainer, end);

  if (start.blockId === end.blockId && containerPath(start).join() === containerPath(end).join()) {
    if (startAbs === endAbs) return [];
    return [{ blockId: start.blockId, path: containerPath(start), start: startAbs, end: endAbs }];
  }

  const out: Span[] = [
    {
      blockId: start.blockId,
      path: containerPath(start),
      start: startAbs,
      end: runsLength(startContainer.runs),
    },
  ];
  for (const block of touchedBlocks(doc, selection)) {
    if (block.id === start.blockId || block.id === end.blockId) continue;
    if (block.kind === 'table') {
      for (let row = 0; row < block.rows.length; row += 1) {
        const cells = block.rows[row]?.cells ?? [];
        for (let col = 0; col < cells.length; col += 1) {
          out.push({ blockId: block.id, path: [row, col], start: 0, end: runsLength(cells[col]?.runs ?? []) });
        }
      }
      continue;
    }
    const container = resolveContainer(doc, { blockId: block.id, path: [0], offset: 0 });
    if (!container) continue;
    out.push({ blockId: block.id, path: [], start: 0, end: runsLength(container.runs) });
  }
  out.push({ blockId: end.blockId, path: containerPath(end), start: 0, end: endAbs });
  return out.filter((span) => span.end > span.start);
}

/** True when every covered character already carries `type`. */
export function isMarkActive(doc: MdvDocument, selection: Selection, type: MarkType): boolean {
  const spans = selectedSpans(doc, selection);
  if (spans.length === 0) return false;
  return spans.every((span) => {
    const container = resolveContainer(doc, {
      blockId: span.blockId,
      path: [...span.path, 0],
      offset: 0,
    });
    if (!container) return false;
    return hasMarkType(commonMarks(container.runs, span.start, span.end), type);
  });
}

/** The marks a toolbar should show as active for the current selection. */
export function activeMarks(doc: MdvDocument, selection: Selection, pending: readonly Mark[] | null): readonly Mark[] {
  if (pending) return pending;
  const spans = selectedSpans(doc, selection);
  if (spans.length === 0) {
    if (selection.kind !== 'text') return [];
    const container = resolveContainer(doc, selection.anchor);
    if (!container) return [];
    return commonMarks(container.runs, 0, 0);
  }
  let result: readonly Mark[] | null = null;
  for (const span of spans) {
    const container = resolveContainer(doc, {
      blockId: span.blockId,
      path: [...span.path, 0],
      offset: 0,
    });
    if (!container) continue;
    const marks = commonMarks(container.runs, span.start, span.end);
    result = result === null ? marks : result.filter((mark) => marks.some((other) => other.type === mark.type));
  }
  return result ?? [];
}

/**
 * Toggle a mark over the selection.
 *
 * Pass a full {@link Mark} to *set* one with data (a link's href); pass a bare
 * type to toggle a data-less one. Toggling a link with an href always applies
 * it — "make this a link to X" is never a request to remove a link.
 */
export function toggleMark(mark: Mark | MarkType): Command {
  return (state, ctx) => {
    const value: Mark = typeof mark === 'string' ? markOf(mark) : mark;
    const spans = selectedSpans(state.doc, state.selection);

    if (spans.length === 0) {
      if (state.selection.kind !== 'text') return null;
      const current = state.pendingMarks ?? currentMarks(state.doc, state.selection);
      const next = hasMarkType(current, value.type)
        ? withoutMark(current, value.type)
        : withMark(current, value);
      return {
        state: { doc: state.doc, selection: state.selection, pendingMarks: next },
        label: 'formatting',
      };
    }

    const active = value.type === 'link' && value.href !== '' ? false : isMarkActive(state.doc, state.selection, value.type);
    const update = active
      ? (marks: readonly Mark[]): readonly Mark[] => withoutMark(marks, value.type)
      : (marks: readonly Mark[]): readonly Mark[] => withMark(marks, value);

    let doc = state.doc;
    for (const span of spans) {
      const probe = { blockId: span.blockId, path: [...span.path, 0], offset: 0 };
      const container = resolveContainer(doc, probe);
      if (!container) continue;
      const runs = mapMarks(container.runs, span.start, span.end, update, ctx.ids);
      doc = writeContainer(doc, container, runs);
    }
    if (doc === state.doc) return null;
    // Applying a mark re-splits the run list, so the old point — which is a
    // (run index, offset) pair — no longer addresses the same character. The
    // mapping converts through absolute offsets, which do not move.
    const mapPoint = new MappingBuilder(state.doc).build(doc);
    return {
      state: { doc, selection: mapSelection(doc, state.selection, mapPoint), pendingMarks: null },
      label: 'formatting',
      mapPoint,
    };
  };
}

/** Remove every mark from the selection — the "clear formatting" button. */
export function clearMarks(): Command {
  return (state, ctx) => {
    const spans = selectedSpans(state.doc, state.selection);
    if (spans.length === 0) {
      return { state: { ...state, pendingMarks: [] }, label: 'formatting' };
    }
    let doc = state.doc;
    for (const span of spans) {
      const probe = { blockId: span.blockId, path: [...span.path, 0], offset: 0 };
      const container = resolveContainer(doc, probe);
      if (!container) continue;
      doc = writeContainer(doc, container, mapMarks(container.runs, span.start, span.end, () => [], ctx.ids));
    }
    if (doc === state.doc) return null;
    const mapPoint = new MappingBuilder(state.doc).build(doc);
    return {
      state: { doc, selection: mapSelection(doc, state.selection, mapPoint), pendingMarks: null },
      label: 'formatting',
      mapPoint,
    };
  };
}

function markOf(type: MarkType): Mark {
  if (type === 'link') return { type: 'link', href: '', title: null };
  return { type } as Mark;
}

function currentMarks(doc: MdvDocument, selection: Selection): readonly Mark[] {
  if (selection.kind !== 'text') return [];
  const container = requireContainer(doc, selection.anchor);
  return commonMarks(container.runs, 0, 0).length > 0
    ? commonMarks(container.runs, 0, 0)
    : marksBefore(container.runs, toAbsolute(container, selection.anchor));
}

function marksBefore(runs: Parameters<typeof commonMarks>[0], offset: number): readonly Mark[] {
  return commonMarks(runs, Math.max(0, offset - 1), offset);
}
