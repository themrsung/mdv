/**
 * Block dispatch.
 *
 * One wrapper element per block, carrying its id and kind, with the editable
 * host (or the non-editable view) inside it. The wrapper is where selection
 * state, drop indicators and hover affordances live, so none of that ever has
 * to touch the element the browser is editing.
 */

import { memo, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement, ReactNode } from 'react';
import type { Block } from '../../engine/index.js';
import { commands } from '../../engine/index.js';
import { toggleTask } from '../commands/local.js';
import { useEditorApi } from '../state/store.js';
import { useViewPrefs } from '../state/view-prefs.js';
import { useSurface } from '../surface/surface-context.js';
import { Editable } from './Editable.js';
import { ImageView } from './ImageView.js';
import { readPageBreak, type PageBreakView } from './page-break.js';
import { TableView } from './TableView.js';
import { VisualBlockEditor } from '../visual/VisualBlockEditor.js';

/** Blocks with no caret inside them: selected as a unit, focusable as a unit. */
function isAtomicKind(kind: Block['kind']): boolean {
  return kind === 'image' || kind === 'visual' || kind === 'thematicBreak' || kind === 'raw';
}

function BlockViewImpl({ block }: { readonly block: Block }): ReactElement {
  const surface = useSurface();
  const { select } = useEditorApi();

  const generation = surface.generations.get(block.id) ?? 0;
  const nodeSelected = surface.nodeSelection === block.id;
  const atomic = isAtomicKind(block.kind);

  const onAtomicPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.target;
      // Controls inside the block's own inspector keep their click.
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, button, select, label, a, [contenteditable="true"]') !==
          null
      ) {
        return;
      }
      event.preventDefault();
      select({ kind: 'node', blockId: block.id });
      event.currentTarget.focus({ preventScroll: true });
    },
    [block.id, select],
  );

  const className = [
    'mdv-block',
    `mdv-block--${block.kind}`,
    surface.selectedBlocks.has(block.id) ? 'is-range-selected' : '',
    nodeSelected ? 'is-node-selected' : '',
    surface.dropTarget?.afterBlockId === block.id ? 'is-drop-after' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <div
      className={className}
      data-mdv-block={block.id}
      data-mdv-kind={block.kind}
      {...(atomic
        ? {
            tabIndex: 0,
            role: 'group' as const,
            'aria-label': atomicLabel(block),
            onPointerDown: onAtomicPointerDown,
          }
        : {})}
    >
      <BlockBody block={block} generation={generation} nodeSelected={nodeSelected} />
    </div>
  );
}

function BlockBody({
  block,
  generation,
  nodeSelected,
}: {
  readonly block: Block;
  readonly generation: number;
  readonly nodeSelected: boolean;
}): ReactNode {
  const { run } = useEditorApi();
  const prefs = useViewPrefs();
  const editableKey = `${block.id}:${String(generation)}`;

  switch (block.kind) {
    case 'paragraph':
      return (
        <Editable
          key={editableKey}
          tag="p"
          blockId={block.id}
          path={[]}
          runs={block.runs}
          className="mdv-p"
        />
      );

    case 'heading':
      return (
        <Editable
          key={editableKey}
          tag={`h${String(block.level)}`}
          blockId={block.id}
          path={[]}
          runs={block.runs}
          className={`mdv-h mdv-h${String(block.level)}`}
        />
      );

    case 'code':
      return (
        <pre className="mdv-pre">
          {/*
           * The info string, as a field rather than a label. It is the only part
           * of a fence with no caret position of its own — ``` ```ts ``` is not
           * text in the block — so a writer who could not type here had no way at
           * all to say what language the code is in, and highlighting, which reads
           * exactly this, could never be turned on from the editor.
           */}
          <input
            className="mdv-pre__info"
            contentEditable={false}
            type="text"
            value={block.info}
            aria-label="Code language"
            placeholder="language"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              run(commands.setCodeInfo(block.id, event.target.value));
            }}
          />
          <Editable
            key={editableKey}
            tag="code"
            blockId={block.id}
            path={[]}
            runs={[{ kind: 'text', id: `${block.id}:text`, text: block.text, marks: [] }]}
            className="mdv-code"
            spellCheck={false}
          />
        </pre>
      );

    case 'blockquote':
      return (
        <blockquote className="mdv-quote">
          {block.children.map((child) => (
            <BlockView key={child.id} block={child} />
          ))}
        </blockquote>
      );

    case 'list': {
      const items = block.items.map((item) => (
        <li key={item.id} className={`mdv-li${item.checked === null ? '' : ' mdv-li--task'}`}>
          {item.checked === null ? null : (
            <input
              className="mdv-task"
              type="checkbox"
              checked={item.checked}
              aria-label={item.checked ? 'Done' : 'Not done'}
              onChange={() => {
                run(toggleTask(block.id, item.id));
              }}
            />
          )}
          <div className="mdv-li__content">
            {item.blocks.map((child) => (
              <BlockView key={child.id} block={child} />
            ))}
          </div>
        </li>
      ));
      return block.ordered ? (
        <ol className="mdv-ol" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="mdv-ul">{items}</ul>
      );
    }

    case 'table':
      return <TableView block={block} />;

    case 'image':
      return (
        <ImageView
          block={block}
          selected={nodeSelected}
          align={prefs.imageAlign.get(block.id) ?? 'left'}
          onAlign={prefs.setImageAlign}
        />
      );

    case 'visual':
      return <VisualBlockEditor block={block} selected={nodeSelected} scheme={prefs.scheme} />;

    case 'thematicBreak':
      return <hr className="mdv-hr" />;

    case 'raw': {
      // A page break is a container the editor keeps verbatim, but it is the one
      // container an author needs to *see* rather than read (SPEC 28.4).
      const page = readPageBreak(block.text);
      if (page) return <PageRule view={page} />;
      return (
        <pre
          className="mdv-rawblock"
          title="Source the editor did not recognise; kept byte for byte."
        >
          {block.text}
        </pre>
      );
    }
  }
}

/**
 * The page rule: a labelled line where the page ends, or a labelled frame around
 * content that must stay together. Neither has any counterpart on a rendered
 * page — this is editor furniture, and `@mdv/react` deliberately draws nothing.
 */
function PageRule({ view }: { readonly view: PageBreakView }): ReactElement {
  const className = [
    'mdv-pagerule',
    view.wrapping ? 'mdv-pagerule--wrap' : '',
    view.edge === null ? '' : `mdv-pagerule--${view.edge}`,
  ]
    .filter((part) => part !== '')
    .join(' ');

  // No `role`/`aria-label` here: the block wrapper is already the labelled
  // group (see `atomicLabel`), and naming the same thing twice reads it twice.
  return (
    <div className={className}>
      <span className="mdv-pagerule__label" aria-hidden="true">
        {view.label}
      </span>
      {view.wrapping ? <pre className="mdv-pagerule__body">{view.body}</pre> : null}
    </div>
  );
}

function atomicLabel(block: Block): string {
  switch (block.kind) {
    case 'image':
      return block.alt === '' ? 'Image without alt text' : `Image: ${block.alt}`;
    case 'visual':
      return `MDV ${block.blockType === '' ? 'visual' : block.blockType} block`;
    case 'thematicBreak':
      return 'Thematic break';
    case 'raw': {
      const page = readPageBreak(block.text);
      return page === null ? 'Unrecognised source block' : page.label;
    }
    default:
      return 'Block';
  }
}

export const BlockView = memo(BlockViewImpl);
