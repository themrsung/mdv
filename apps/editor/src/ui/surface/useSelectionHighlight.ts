/**
 * Painting a selection the browser refuses to hold.
 *
 * With one editing host per block, a native selection stops at the block it
 * started in — so a selection from the middle of one paragraph to the middle of
 * the next has to be drawn by the editor. The CSS Custom Highlight API is
 * exactly the right tool: real `Range`s, styled with `::highlight()`, painted
 * by the browser's own text renderer, no DOM mutation and therefore nothing for
 * React to fight over.
 *
 * Where it is missing, the fallback is the `is-range-selected` class the block
 * views already carry: whole blocks tint instead of exact character ranges.
 * Coarser, never wrong about *what* is selected, and it degrades in the one
 * direction that cannot mislead — it can only over-report the edges of the
 * first and last block.
 */

import { useEffect } from 'react';
import type { MdvDocument, Selection } from '../../engine/index.js';
import { commands } from '../../engine/index.js';
import { findContainerElement } from '../dom/contract.js';
import type { NodeLike } from '../dom/contract.js';
import { positionAtOffset } from '../dom/offsets.js';

const HIGHLIGHT_NAME = 'mdv-selection';

interface HighlightLike {
  /* marker interface: the registry only stores and deletes them */
  readonly size?: number;
}

interface HighlightRegistry {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

interface HighlightCapableCss {
  highlights?: HighlightRegistry;
}

type HighlightConstructor = new (...ranges: readonly Range[]) => HighlightLike;

function registry(): HighlightRegistry | null {
  const scope = globalThis as { CSS?: HighlightCapableCss };
  return scope.CSS?.highlights ?? null;
}

function highlightConstructor(): HighlightConstructor | null {
  const scope = globalThis as { Highlight?: HighlightConstructor };
  return scope.Highlight ?? null;
}

/**
 * Register the cross-block part of `selection` as a custom highlight.
 *
 * A selection inside a single container is left alone: the browser is already
 * drawing it, and drawing it twice makes it darker than every other selection
 * on the machine.
 */
export function useSelectionHighlight(
  rootRef: { readonly current: HTMLElement | null },
  doc: MdvDocument,
  selection: Selection,
  revision: number,
): void {
  useEffect(() => {
    const store = registry();
    const Ctor = highlightConstructor();
    if (store === null || Ctor === null) return;

    const root = rootRef.current;
    if (root === null || selection.kind !== 'text') {
      store.delete(HIGHLIGHT_NAME);
      return;
    }

    const spans = commands.selectedSpans(doc, selection);
    if (spans.length < 2) {
      store.delete(HIGHLIGHT_NAME);
      return;
    }

    const ranges: Range[] = [];
    for (const span of spans) {
      const element = findContainerElement(root as unknown as NodeLike, span.blockId, span.path);
      if (element === null) continue;
      const from = positionAtOffset(element, span.start);
      const to = positionAtOffset(element, span.end);
      const range = document.createRange();
      try {
        range.setStart(from.node as unknown as Node, from.offset);
        range.setEnd(to.node as unknown as Node, to.offset);
      } catch {
        continue;
      }
      ranges.push(range);
    }

    if (ranges.length === 0) {
      store.delete(HIGHLIGHT_NAME);
      return;
    }
    store.set(HIGHLIGHT_NAME, new Ctor(...ranges));

    return () => {
      store.delete(HIGHLIGHT_NAME);
    };
    // `revision` is the engine's change counter: the same selection over a
    // changed document needs new ranges, and object identity would miss that.
  }, [rootRef, doc, selection, revision]);
}
