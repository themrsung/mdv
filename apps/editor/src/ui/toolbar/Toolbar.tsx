/**
 * The formatting toolbar.
 *
 * Two details that matter more than they look:
 *
 * - **`pointerdown` is cancelled on every control.** Pressing a toolbar button
 *   otherwise moves focus out of the document, which collapses the selection
 *   the button was about to act on. Cancelling the default leaves the caret
 *   exactly where it was and the click still fires.
 * - **It is one composite widget for the keyboard.** A roving tabindex means Tab
 *   enters the toolbar once and the arrow keys move within it, instead of
 *   fifteen stops between the document and whatever comes next.
 *
 * Button state is read from the engine on every render — `isMarkActive` and the
 * block kind under the selection — so it can never disagree with the document.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import type { Block, HeadingLevel, MarkType } from '../../engine/index.js';
import type { BlockTypeSpec } from '../../engine/commands/index.js';
import { commands, findBlock } from '../../engine/index.js';
import type { ModKey } from '../input/keymap.js';
import { shortcutLabel } from '../input/keymap.js';
import { useEditorApi } from '../state/store.js';

export interface ToolbarProps {
  readonly mod: ModKey;
  readonly onLink: () => void;
}

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly glyph: ReactNode;
  readonly title: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  run(): void;
}

/** The block kinds the selection touches, for the block-type buttons. */
function selectedKinds(blocks: readonly Block[]): {
  readonly heading: HeadingLevel | null;
  readonly kinds: ReadonlySet<Block['kind']>;
} {
  const kinds = new Set<Block['kind']>();
  let heading: HeadingLevel | null = null;
  for (const block of blocks) {
    kinds.add(block.kind);
    if (block.kind === 'heading') heading = heading === null || heading === block.level ? block.level : heading;
  }
  return { heading, kinds };
}

export function Toolbar({ mod, onLink }: ToolbarProps): ReactElement {
  const api = useEditorApi();
  const { doc, selection, run, canUndo, canRedo, editor } = api;
  const listRef = useRef<HTMLDivElement>(null);

  const touched = useMemo(() => commands.touchedBlocks(doc, selection), [doc, selection]);
  const { heading, kinds } = useMemo(() => selectedKinds(touched), [touched]);

  const markActive = useCallback(
    (type: MarkType): boolean => commands.isMarkActive(doc, selection, type),
    [doc, selection],
  );

  const inList = useMemo(
    () =>
      touched.some((block) =>
        commands.ancestorIds(doc, block.id).some((id) => findBlock(doc, id)?.block.kind === 'list'),
      ),
    [doc, touched],
  );

  const blockButton = (
    id: string,
    label: string,
    glyph: ReactNode,
    spec: BlockTypeSpec,
    active: boolean,
    title: string,
  ): Entry => ({
    id,
    label,
    glyph,
    title,
    active,
    run: () => void run(commands.setBlockType(spec)),
  });

  const groups: readonly (readonly Entry[])[] = [
    [
      {
        id: 'undo',
        label: 'Undo',
        glyph: '↶',
        title: `Undo (${shortcutLabel(mod, { key: 'z' })})`,
        active: false,
        disabled: !canUndo,
        run: () => {
          editor.undo();
        },
      },
      {
        id: 'redo',
        label: 'Redo',
        glyph: '↷',
        title: `Redo (${shortcutLabel(mod, { shift: true, key: 'z' })})`,
        active: false,
        disabled: !canRedo,
        run: () => {
          editor.redo();
        },
      },
    ],
    [
      {
        id: 'strong',
        label: 'Bold',
        glyph: <strong>B</strong>,
        title: `Bold (${shortcutLabel(mod, { key: 'b' })})`,
        active: markActive('strong'),
        run: () => void run(commands.toggleMark('strong')),
      },
      {
        id: 'emphasis',
        label: 'Italic',
        glyph: <em>I</em>,
        title: `Italic (${shortcutLabel(mod, { key: 'i' })})`,
        active: markActive('emphasis'),
        run: () => void run(commands.toggleMark('emphasis')),
      },
      {
        id: 'code',
        label: 'Inline code',
        glyph: <code>{'<>'}</code>,
        title: `Inline code (${shortcutLabel(mod, { key: 'e' })})`,
        active: markActive('code'),
        run: () => void run(commands.toggleMark('code')),
      },
      {
        id: 'strikethrough',
        label: 'Strikethrough',
        glyph: <s>S</s>,
        title: `Strikethrough (${shortcutLabel(mod, { shift: true, key: 'x' })})`,
        active: markActive('strikethrough'),
        run: () => void run(commands.toggleMark('strikethrough')),
      },
      {
        id: 'link',
        label: 'Link',
        glyph: '🔗',
        title: `Link (${shortcutLabel(mod, { key: 'k' })})`,
        active: markActive('link'),
        run: onLink,
      },
    ],
    [
      blockButton('h1', 'Heading 1', 'H1', { kind: 'heading', level: 1 }, heading === 1, `Heading 1 (${shortcutLabel(mod, { alt: true, key: '1' })})`),
      blockButton('h2', 'Heading 2', 'H2', { kind: 'heading', level: 2 }, heading === 2, `Heading 2 (${shortcutLabel(mod, { alt: true, key: '2' })})`),
      blockButton('h3', 'Heading 3', 'H3', { kind: 'heading', level: 3 }, heading === 3, `Heading 3 (${shortcutLabel(mod, { alt: true, key: '3' })})`),
      blockButton('paragraph', 'Paragraph', '¶', { kind: 'paragraph' }, kinds.has('paragraph') && heading === null, `Paragraph (${shortcutLabel(mod, { alt: true, key: '0' })})`),
    ],
    [
      blockButton('ul', 'Bulleted list', '•', { kind: 'bulletList' }, inList, `Bulleted list (${shortcutLabel(mod, { shift: true, key: '8' })})`),
      blockButton('ol', 'Numbered list', '1.', { kind: 'orderedList' }, false, `Numbered list (${shortcutLabel(mod, { shift: true, key: '7' })})`),
      blockButton('quote', 'Quote', '❝', { kind: 'quote' }, kinds.has('blockquote'), `Quote (${shortcutLabel(mod, { shift: true, key: '9' })})`),
      blockButton('codeblock', 'Code block', '{ }', { kind: 'code' }, kinds.has('code'), `Code block (${shortcutLabel(mod, { alt: true, key: 'c' })})`),
    ],
    [
      {
        id: 'indent',
        label: 'Indent',
        glyph: '⇥',
        title: 'Indent list item (Tab)',
        active: false,
        run: () => void run(commands.indent()),
      },
      {
        id: 'outdent',
        label: 'Outdent',
        glyph: '⇤',
        title: 'Outdent list item (Shift+Tab)',
        active: false,
        run: () => void run(commands.outdent()),
      },
      {
        id: 'table',
        label: 'Table',
        glyph: '▦',
        title: 'Insert a 3×2 table',
        active: false,
        run: () => void run(commands.insertTable(3, 2)),
      },
      {
        id: 'divider',
        label: 'Divider',
        glyph: '―',
        title: 'Insert a thematic break',
        active: false,
        run: () => void run(commands.insertThematicBreak()),
      },
    ],
  ];

  const flat = groups.flat();

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      const buttons = Array.from(listRef.current?.querySelectorAll('button') ?? []);
      const index = buttons.findIndex((button) => button === document.activeElement);
      const next = buttons[(index + step + buttons.length) % buttons.length];
      if (next !== undefined) {
        for (const button of buttons) button.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
      }
    },
    [],
  );

  return (
    <div className="mdv-toolbar" role="toolbar" aria-label="Formatting" ref={listRef} onKeyDown={onKeyDown}>
      {groups.map((group, groupIndex) => (
        <div className="mdv-toolbar__group" key={group[0]?.id ?? String(groupIndex)}>
          {group.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`mdv-tool${entry.active ? ' is-active' : ''}`}
              title={entry.title}
              aria-label={entry.label}
              aria-pressed={entry.active}
              disabled={entry.disabled ?? false}
              tabIndex={entry.id === flat[0]?.id ? 0 : -1}
              onPointerDown={(event) => {
                event.preventDefault();
              }}
              onClick={entry.run}
            >
              <span aria-hidden="true">{entry.glyph}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
