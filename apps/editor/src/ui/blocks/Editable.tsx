/**
 * One editable inline container.
 *
 * Every text-bearing block gets its own editing host rather than the document
 * sharing one. The cost is that the browser will not extend a native selection
 * across two of them, which the surface makes up for with its own cross-block
 * selection. What it buys is worth more: an IME, a spell-checker or an
 * autocorrect can only ever corrupt the one block it is working in, React never
 * has to reconcile a subtree the browser rewrote somewhere else, and a
 * misbehaving embedded view cannot take the whole document down with it.
 *
 * No `role` is set. The element keeps its semantic tag — `h2` stays a heading,
 * `li` stays a list item — and `contenteditable` already makes it an editable
 * region in the accessibility tree. Stamping `role="textbox"` on each block
 * would trade a document a screen reader can navigate for a stack of unlabelled
 * text fields.
 */

import { createElement, memo } from 'react';
import type { ReactElement } from 'react';
import type { Run } from '../../engine/index.js';
import { encodePath } from '../dom/contract.js';
import { RunsView } from './Runs.js';

export interface EditableProps {
  /** Intrinsic tag to render. */
  readonly tag: string;
  readonly blockId: string;
  /** Container path: `[]` for a block, `[row, col]` for a table cell. */
  readonly path: readonly number[];
  readonly runs: readonly Run[];
  readonly className?: string;
  /** Code blocks hold literal text; a spell-checker there is only noise. */
  readonly spellCheck?: boolean;
}

function EditableImpl(props: EditableProps): ReactElement {
  const { tag, blockId, path, runs, className, spellCheck } = props;
  return createElement(
    tag,
    {
      className,
      contentEditable: true,
      suppressContentEditableWarning: true,
      spellCheck: spellCheck ?? true,
      'data-mdv-container': blockId,
      'data-mdv-path': encodePath(path),
    },
    <RunsView runs={runs} />,
  );
}

export const Editable = memo(EditableImpl);
