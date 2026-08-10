/**
 * The editing surface: every browser event that can change the document, and
 * the two-way selection sync.
 *
 * ## The rule that keeps React and the browser apart
 *
 * The DOM changes **only** because React re-rendered it from engine state.
 * Every `beforeinput` we understand is cancelled and replayed as a command; the
 * ones we do not understand are cancelled too. That is what makes the character
 * offsets in `../dom/offsets.ts` trustworthy — nothing has written into the
 * tree that the engine does not know about.
 *
 * ## Except for the input method, where the opposite rule applies
 *
 * `insertCompositionText` is not cancelable, and it must not be: an IME needs
 * to place its own preedit in the DOM, and taking that away breaks Korean,
 * Japanese and Chinese input outright — dropped jamo, duplicated syllables, a
 * candidate window anchored to the wrong place.
 *
 * So during a composition the browser owns the block, and we deliberately do
 * nothing:
 *
 * - no command is dispatched, so engine state — and therefore the `runs` array
 *   — is referentially unchanged, and `memo` on `RunsView` means React cannot
 *   re-render over the preedit even if something else on the page does;
 * - the selection sync is suspended in both directions, so the caret is not
 *   yanked out from under the candidate window;
 * - `keydown` is skipped while `isComposing` is set, which is what stops the
 *   Enter that accepts a Hangul candidate from also splitting the paragraph.
 *
 * On `compositionend` the block is reconciled: read the subtree's text, diff it
 * against the engine's, and replay the difference as **one** edit — one undo
 * step per commit, which is what a person expects. The block's `generation` is
 * then bumped so React discards the subtree the browser wrote and rebuilds it
 * from the model; anything the IME left behind goes with it.
 *
 * The same reconcile path serves every non-cancelable input, which is most of
 * what Android soft keyboards emit.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react';
import type { CellRect, Editor, MdvDocument, Point, Selection } from '../../engine/index.js';
import type { ImageEnvironment, ImageSource } from '../../engine/image/index.js';
import {
  cellRect,
  clipboard,
  commands,
  containerLength,
  containerPath,
  findBlock,
  fromAbsolute,
  isAtomicBlock,
  resolveContainer,
  runsText,
  selectionsEqual,
  toAbsolute,
} from '../../engine/index.js';
import { BlockView } from '../blocks/BlockView.js';
import { caretFromPoint, caretRect, linePositionIn, rectAt } from '../dom/caret.js';
import type { ElementLike, NodeLike } from '../dom/contract.js';
import {
  closestContainer,
  describeContainer,
  findBlockElement,
  findContainerElement,
} from '../dom/contract.js';
import { diffText, offsetInContainer, textOf } from '../dom/offsets.js';
import {
  domSelectionMatches,
  domTargetFor,
  pointFromDom,
  readDomSelection,
} from '../dom/selection.js';
import type { EditorIntent } from '../input/intents.js';
import {
  intentForInput,
  lineEndAfter,
  lineStartBefore,
  shouldPreventDefault,
  wordEndAfter,
  wordStartBefore,
} from '../input/intents.js';
import type { ImageNotice, PendingImage } from '../input/images.js';
import { formatBytes, ingestBatch, noticesFor } from '../input/images.js';
import { detectModKey, resolveShortcut } from '../input/keymap.js';
import type { KeyAction } from '../input/keymap.js';
import { SlashMenu } from '../menus/SlashMenu.js';
import type { SlashItem } from '../menus/slash-items.js';
import { matchSlashItems } from '../menus/slash-items.js';
import { useEditorApi } from '../state/store.js';
import type { DropTarget, SurfaceInfo } from './surface-context.js';
import { SurfaceContext } from './surface-context.js';
import { useSelectionHighlight } from './useSelectionHighlight.js';

export interface EditorSurfaceProps {
  /** Injected so the whole image path can be exercised without a browser. */
  readonly imageEnv: ImageEnvironment;
  readonly onNotice: (notice: ImageNotice) => void;
  /** Shortcuts the shell owns: save, open, link, toggle source. */
  readonly onShellAction: (action: KeyAction) => void;
}

interface SlashState {
  readonly blockId: string;
  readonly path: readonly number[];
  /** Absolute offset of the `/` itself, within its container. */
  readonly start: number;
}

export function EditorSurface({
  imageEnv,
  onNotice,
  onShellAction,
}: EditorSurfaceProps): ReactElement {
  const api = useEditorApi();
  const { editor, doc, selection, revision } = api;

  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef<HTMLElement | null>(null);
  const plainPasteRef = useRef(false);
  const focusInsideRef = useRef(false);
  const crossBlockRef = useRef(false);
  const dragAnchorRef = useRef<Point | null>(null);
  const slashKeyRef = useRef<((key: string, shift: boolean) => boolean) | null>(null);

  const [composing, setComposing] = useState(false);
  const [generations, setGenerations] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [pending, setPending] = useState<readonly PendingImage[]>([]);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashAnchor, setSlashAnchor] = useState<DOMRect | null>(null);

  const mod = useMemo(() => detectModKey(hostPlatform()), []);

  const bumpGeneration = useCallback((blockId: string) => {
    setGenerations((current) => {
      const next = new Map(current);
      next.set(blockId, (current.get(blockId) ?? 0) + 1);
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Reconcile a subtree the browser wrote                                   */
  /* ---------------------------------------------------------------------- */

  const reconcile = useCallback(
    (host: HTMLElement): void => {
      const descriptor = describeContainer(host as unknown as ElementLike);
      if (descriptor === null) return;
      const current = editor.getDocument();
      const probe: Point = {
        blockId: descriptor.blockId,
        path: [...descriptor.path, 0],
        offset: 0,
      };
      const container = resolveContainer(current, probe);
      if (container === undefined) return;

      const before = runsText(container.runs);
      const after = textOf(host as unknown as NodeLike);
      const splice = diffText(before, after);

      // Where the browser left the caret, in container coordinates. Read now:
      // the next render moves it.
      const domSelection = document.getSelection();
      const caretAt =
        domSelection?.focusNode != null && host.contains(domSelection.focusNode)
          ? offsetInContainer(
              host as unknown as NodeLike,
              domSelection.focusNode as unknown as NodeLike,
              domSelection.focusOffset,
            )
          : null;

      if (splice !== null) {
        editor.select({
          kind: 'text',
          anchor: fromAbsolute(container, splice.start),
          focus: fromAbsolute(container, splice.end),
        });
        if (splice.inserted === '') editor.dispatch(commands.deleteBackward());
        else editor.dispatch(commands.insertText(splice.inserted));
      }

      const settled = resolveContainer(editor.getDocument(), probe);
      if (settled !== undefined && caretAt !== null) {
        const at = fromAbsolute(settled, Math.min(Math.max(caretAt, 0), containerLength(settled)));
        editor.select({ kind: 'text', anchor: at, focus: at });
      }
      // Always rebuild: even a cancelled composition can leave the IME's own
      // markup behind, and React never built it so it will never remove it.
      bumpGeneration(descriptor.blockId);
    },
    [bumpGeneration, editor],
  );

  /* ---------------------------------------------------------------------- */
  /* Intent execution                                                        */
  /* ---------------------------------------------------------------------- */

  const applyIntent = useCallback(
    (intent: EditorIntent, host: HTMLElement | null): void => {
      const current = editor.getSelection();

      switch (intent.kind) {
        case 'insertText':
          editor.dispatch(commands.insertText(intent.text));
          return;
        case 'insertParagraph':
        case 'insertLineBreak':
          editor.dispatch(commands.splitBlock());
          return;
        case 'deleteBackward':
          editor.dispatch(commands.deleteBackward());
          return;
        case 'deleteForward':
          editor.dispatch(commands.deleteForward());
          return;
        case 'deleteSelection':
          editor.dispatch(
            current.kind === 'cells' ? commands.clearSelection() : commands.deleteBackward(),
          );
          return;
        case 'toggleMark':
          editor.dispatch(commands.toggleMark(intent.mark));
          return;
        case 'undo':
          editor.undo();
          return;
        case 'redo':
          editor.redo();
          return;
        case 'clipboard':
        case 'ignore':
          return;
        case 'reconcile':
          if (host !== null && composingRef.current === null) {
            // The browser has not written yet when `beforeinput` fires.
            requestAnimationFrame(() => {
              if (composingRef.current === null) reconcile(host);
            });
          }
          return;
        case 'deleteWordBackward':
        case 'deleteWordForward':
        case 'deleteLineBackward':
        case 'deleteLineForward': {
          const backwards =
            intent.kind === 'deleteWordBackward' || intent.kind === 'deleteLineBackward';
          if (current.kind !== 'text') {
            editor.dispatch(backwards ? commands.deleteBackward() : commands.deleteForward());
            return;
          }
          const at = current.anchor;
          const container = resolveContainer(editor.getDocument(), at);
          if (container === undefined) return;
          const text = runsText(container.runs);
          const offset = toAbsolute(container, at);
          const boundary =
            intent.kind === 'deleteWordBackward'
              ? wordStartBefore(text, offset)
              : intent.kind === 'deleteWordForward'
                ? wordEndAfter(text, offset)
                : intent.kind === 'deleteLineBackward'
                  ? lineStartBefore(text, offset)
                  : lineEndAfter(text, offset);

          if (boundary === offset) {
            // Nothing to eat here: fall through so Backspace at a block start
            // still merges into the block above.
            editor.dispatch(backwards ? commands.deleteBackward() : commands.deleteForward());
            return;
          }
          editor.select({
            kind: 'text',
            anchor: fromAbsolute(container, Math.min(boundary, offset)),
            focus: fromAbsolute(container, Math.max(boundary, offset)),
          });
          editor.dispatch(commands.deleteBackward());
          return;
        }
      }
    },
    [editor, reconcile],
  );

  /* ---------------------------------------------------------------------- */
  /* Images                                                                  */
  /* ---------------------------------------------------------------------- */

  const startIngest = useCallback(
    (sources: readonly ImageSource[], afterBlockId: string | null) => {
      if (sources.length === 0) return;
      void ingestBatch(
        sources,
        imageEnv,
        {
          onPending: (item) => {
            setPending((current) => [...current, item]);
          },
          onReady: (_id, command, image) => {
            const placement = placementSelection(editor.getDocument(), afterBlockId);
            if (placement !== null) editor.select(placement);
            editor.dispatch(command);
            for (const notice of noticesFor(image)) onNotice(notice);
          },
          onFailed: (_id, notice) => {
            onNotice(notice);
          },
          onSettled: (id) => {
            setPending((current) => current.filter((item) => item.id !== id));
          },
        },
        { afterBlockId },
      );
    },
    [editor, imageEnv, onNotice],
  );

  const pickImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Native event wiring                                                     */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;

    const hostOf = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Node)) return null;
      const element = closestContainer(target as unknown as NodeLike);
      return element === null ? null : (element as unknown as HTMLElement);
    };

    const onBeforeInput = (event: Event): void => {
      const input = event as InputEvent;
      const host = hostOf(input.target);
      if (host === null) return;
      const descriptor = describeContainer(host as unknown as ElementLike);
      const inCode =
        descriptor !== null &&
        findBlock(editor.getDocument(), descriptor.blockId)?.block.kind === 'code';

      const intent = intentForInput(
        {
          inputType: input.inputType,
          data: input.data,
          cancelable: input.cancelable,
          transferText: input.dataTransfer?.getData('text/plain') ?? null,
        },
        inCode,
      );
      if (shouldPreventDefault(intent)) input.preventDefault();
      applyIntent(intent, host);
    };

    const onCompositionStart = (event: Event): void => {
      const host = hostOf(event.target);
      if (host === null) return;
      composingRef.current = host;
      setComposing(true);
    };

    const onCompositionEnd = (event: Event): void => {
      const host = composingRef.current ?? hostOf(event.target);
      composingRef.current = null;
      setComposing(false);
      if (host !== null) reconcile(host);
    };

    const onPaste = (event: Event): void => {
      const clip = event as ClipboardEvent;
      const data = clip.clipboardData;
      if (data === null) return;
      event.preventDefault();

      const payload = clipboard.readClipboardPayload(data);
      const plain = plainPasteRef.current;
      plainPasteRef.current = false;

      if (clipboard.isImageOnly(payload)) {
        startIngest(payload.images, null);
        return;
      }
      editor.dispatch(clipboard.paste(payload, plain ? { plainOnly: true } : {}));
    };

    const onCopy = (event: Event): void => {
      const clip = event as ClipboardEvent;
      const result = clipboard.copySelection(editor.getDocument(), editor.getSelection());
      if (result === null || clip.clipboardData === null) return;
      event.preventDefault();
      for (const [type, value] of Object.entries(clipboard.clipboardEntries(result))) {
        try {
          clip.clipboardData.setData(type, value);
        } catch {
          // Safari rejects unregistered MIME types; text/plain and text/html
          // still land, which is the part that degrades gracefully.
        }
      }
    };

    const onCut = (event: Event): void => {
      onCopy(event);
      if (!event.defaultPrevented) return;
      const current = editor.getSelection();
      editor.dispatch(
        current.kind === 'cells' ? commands.clearSelection() : commands.deleteBackward(),
      );
    };

    const onDragOver = (event: Event): void => {
      const drag = event as DragEvent;
      const types = drag.dataTransfer?.types;
      if (types === undefined || !Array.from(types).includes('Files')) return;
      drag.preventDefault();
      if (drag.dataTransfer !== null) drag.dataTransfer.dropEffect = 'copy';
      const target = dropTargetAt(root, drag.clientY);
      setDropTarget((current) =>
        current?.afterBlockId === target.afterBlockId ? current : target,
      );
    };

    const onDragLeave = (event: Event): void => {
      const drag = event as DragEvent;
      if (drag.relatedTarget instanceof Node && root.contains(drag.relatedTarget)) return;
      setDropTarget(null);
    };

    const onDrop = (event: Event): void => {
      const drag = event as DragEvent;
      const data = drag.dataTransfer;
      if (data === null) return;
      drag.preventDefault();
      const target = dropTargetAt(root, drag.clientY);
      setDropTarget(null);

      const payload = clipboard.readClipboardPayload(data);
      if (payload.images.length > 0) {
        startIngest(payload.images, target.afterBlockId);
        return;
      }
      // Text lands where it was dropped, not where the caret happened to be.
      const hit = caretFromPoint(drag.clientX, drag.clientY);
      if (hit !== null) {
        const at = pointFromDom(editor.getDocument(), hit.node as unknown as NodeLike, hit.offset);
        if (at !== null) editor.select({ kind: 'text', anchor: at, focus: at });
      }
      editor.dispatch(clipboard.paste(payload, {}));
    };

    const onFocusIn = (): void => {
      focusInsideRef.current = true;
    };
    const onFocusOut = (event: Event): void => {
      const next = (event as FocusEvent).relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      focusInsideRef.current = false;
    };

    root.addEventListener('beforeinput', onBeforeInput);
    root.addEventListener('compositionstart', onCompositionStart);
    root.addEventListener('compositionend', onCompositionEnd);
    root.addEventListener('paste', onPaste);
    root.addEventListener('copy', onCopy);
    root.addEventListener('cut', onCut);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);

    return () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('compositionstart', onCompositionStart);
      root.removeEventListener('compositionend', onCompositionEnd);
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('copy', onCopy);
      root.removeEventListener('cut', onCut);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [applyIntent, editor, reconcile, startIngest]);

  /* ---------------------------------------------------------------------- */
  /* Selection: DOM → engine                                                 */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const onSelectionChange = (): void => {
      if (composingRef.current !== null) return;
      // While the engine holds a selection spanning two editing hosts, the
      // browser's collapsed stand-in must not be read back as the truth.
      if (crossBlockRef.current) return;

      const root = rootRef.current;
      if (root === null) return;
      const domSelection = document.getSelection();
      if (domSelection === null || domSelection.anchorNode === null) return;
      if (!root.contains(domSelection.anchorNode)) return;

      const next = readDomSelection(editor.getDocument(), {
        anchorNode: domSelection.anchorNode as unknown as NodeLike,
        anchorOffset: domSelection.anchorOffset,
        focusNode: domSelection.focusNode as unknown as NodeLike | null,
        focusOffset: domSelection.focusOffset,
      });
      if (next === null) return;
      if (selectionsEqual(next, editor.getSelection())) return;
      editor.select(next);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [editor]);

  /* ---------------------------------------------------------------------- */
  /* Selection: engine → DOM                                                 */
  /* ---------------------------------------------------------------------- */

  useLayoutEffect(() => {
    if (composingRef.current !== null) return;
    const root = rootRef.current;
    if (root === null) return;

    if (selection.kind === 'text' && selection.anchor.blockId === selection.focus.blockId) {
      crossBlockRef.current = false;
    }
    if (!focusInsideRef.current) return;

    if (selection.kind === 'node') {
      const element = findBlockElement(
        root as unknown as NodeLike,
        selection.blockId,
      ) as unknown as HTMLElement | null;
      if (element !== null && element !== document.activeElement)
        element.focus({ preventScroll: true });
      return;
    }

    if (selection.kind === 'cells') {
      const rect: CellRect = cellRect(selection);
      const element = findContainerElement(root as unknown as NodeLike, selection.tableId, [
        rect.top,
        rect.left,
      ]) as unknown as HTMLElement | null;
      if (element !== null && !element.contains(document.activeElement)) {
        element.focus({ preventScroll: true });
      }
      return;
    }

    const target = domTargetFor(root as unknown as NodeLike, doc, selection);
    if (target === null) return;

    const focusHost = closestContainer(target.focus.node) as unknown as HTMLElement | null;
    if (focusHost !== null && focusHost !== document.activeElement)
      focusHost.focus({ preventScroll: true });

    const domSelection = document.getSelection();
    if (domSelection === null) return;
    const currentDom = {
      anchorNode: domSelection.anchorNode as unknown as NodeLike | null,
      anchorOffset: domSelection.anchorOffset,
      focusNode: domSelection.focusNode as unknown as NodeLike | null,
      focusOffset: domSelection.focusOffset,
    };
    if (domSelectionMatches(currentDom, target)) return;

    const sameHost =
      (closestContainer(target.anchor.node) as unknown as HTMLElement | null) === focusHost;
    try {
      if (sameHost) {
        domSelection.setBaseAndExtent(
          target.anchor.node as unknown as Node,
          target.anchor.offset,
          target.focus.node as unknown as Node,
          target.focus.offset,
        );
      } else {
        // Two editing hosts: the browser cannot hold this range. Keep a
        // collapsed caret at the focus end so the block still receives input
        // events, and let `useSelectionHighlight` draw what is really selected.
        crossBlockRef.current = true;
        domSelection.setBaseAndExtent(
          target.focus.node as unknown as Node,
          target.focus.offset,
          target.focus.node as unknown as Node,
          target.focus.offset,
        );
      }
    } catch {
      // A node from a render that has already been replaced. The next revision
      // places it correctly.
    }
  }, [doc, selection, revision]);

  useSelectionHighlight(rootRef, doc, selection, revision);

  /* ---------------------------------------------------------------------- */
  /* Pointer: cross-block selection                                          */
  /* ---------------------------------------------------------------------- */

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      const hit = caretFromPoint(event.clientX, event.clientY);
      if (hit === null) {
        crossBlockRef.current = false;
        return;
      }
      const at = pointFromDom(editor.getDocument(), hit.node as unknown as NodeLike, hit.offset);
      if (at === null) {
        crossBlockRef.current = false;
        return;
      }

      if (event.shiftKey) {
        const current = editor.getSelection();
        const anchor = current.kind === 'text' ? current.anchor : at;
        event.preventDefault();
        crossBlockRef.current = anchor.blockId !== at.blockId;
        editor.select({ kind: 'text', anchor, focus: at });
        return;
      }
      crossBlockRef.current = false;
      dragAnchorRef.current = at;
    },
    [editor],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const anchor = dragAnchorRef.current;
      if (anchor === null) return;
      if (event.buttons === 0) {
        dragAnchorRef.current = null;
        return;
      }
      const hit = caretFromPoint(event.clientX, event.clientY);
      if (hit === null) return;
      const focus = pointFromDom(editor.getDocument(), hit.node as unknown as NodeLike, hit.offset);
      if (focus === null || focus.blockId === anchor.blockId) return;
      // Only once the drag has left the first block does the editor take over;
      // inside one block the browser's own selection is better than ours.
      crossBlockRef.current = true;
      editor.select({ kind: 'text', anchor, focus });
    },
    [editor],
  );

  const endDrag = useCallback((): void => {
    dragAnchorRef.current = null;
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  const moveToAdjacentBlock = useCallback(
    (direction: 'previous' | 'next', extend: boolean): boolean => {
      const current = editor.getSelection();
      if (current.kind !== 'text') return false;
      const document_ = editor.getDocument();
      const neighbour =
        direction === 'previous'
          ? commands.previousLeaf(document_, current.focus.blockId)
          : commands.nextLeaf(document_, current.focus.blockId);
      if (neighbour === undefined) return false;

      if (isAtomicBlock(neighbour)) {
        if (extend) return false;
        editor.select({ kind: 'node', blockId: neighbour.id });
        return true;
      }

      const container = resolveContainer(document_, {
        blockId: neighbour.id,
        path: neighbour.kind === 'table' ? [0, 0, 0] : [0],
        offset: 0,
      });
      if (container === undefined) return false;
      const at = fromAbsolute(container, direction === 'previous' ? containerLength(container) : 0);
      crossBlockRef.current = extend;
      editor.select(
        extend
          ? { kind: 'text', anchor: current.anchor, focus: at }
          : { kind: 'text', anchor: at, focus: at },
      );
      return true;
    },
    [editor],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // Never interfere with a composition: the Enter that accepts a Hangul or
      // Kana candidate must not also split the paragraph.
      if (event.nativeEvent.isComposing || composingRef.current !== null) return;

      if (slash !== null) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setSlash(null);
          return;
        }
        if (slashKeyRef.current?.(event.key, event.shiftKey) === true) {
          event.preventDefault();
          return;
        }
      }

      const shortcut = resolveShortcut(event, mod);
      if (shortcut !== null) {
        switch (shortcut.kind) {
          case 'mark':
            event.preventDefault();
            api.run(commands.toggleMark(shortcut.mark));
            return;
          case 'clearMarks':
            event.preventDefault();
            api.run(commands.clearMarks());
            return;
          case 'blockType':
            event.preventDefault();
            api.run(commands.setBlockType(shortcut.spec));
            return;
          case 'undo':
            event.preventDefault();
            editor.undo();
            return;
          case 'redo':
            event.preventDefault();
            editor.redo();
            return;
          case 'selectAll':
            event.preventDefault();
            crossBlockRef.current = true;
            selectWholeDocument(editor);
            return;
          case 'slashMenu':
            event.preventDefault();
            api.run(commands.insertText('/'));
            return;
          case 'link':
          case 'save':
          case 'saveAs':
          case 'open':
          case 'toggleSource':
            event.preventDefault();
            onShellAction(shortcut);
            return;
        }
      }

      // Paste-without-formatting arrives as a paste event carrying no modifier
      // state, so the intent is recorded here and read there.
      if (
        (mod === 'meta' ? event.metaKey : event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'v'
      ) {
        plainPasteRef.current = true;
        return;
      }

      const current = editor.getSelection();
      const table = commands.tableFocus(editor.getDocument(), current);

      if (event.key === 'Tab') {
        if (table !== undefined) {
          event.preventDefault();
          api.run(commands.navigateCell(event.shiftKey ? 'previous' : 'next'));
          return;
        }
        if (api.run(event.shiftKey ? commands.outdent() : commands.indent())) {
          event.preventDefault();
          return;
        }
        // Outside a list and a table, Tab moves focus. An editor that traps Tab
        // is a keyboard trap, which is a WCAG 2.1.2 failure.
        return;
      }

      if (event.key === 'Enter' && table !== undefined && !event.shiftKey) {
        event.preventDefault();
        if (!api.run(commands.navigateCell('down'))) {
          api.run(commands.insertRowBelow());
          api.run(commands.navigateCell('down'));
        }
        return;
      }

      if (event.key === 'Escape') {
        if (current.kind === 'cells') {
          event.preventDefault();
          const rect = cellRect(current);
          editor.select(commands.caretInCell(current.tableId, { row: rect.top, col: rect.left }));
          return;
        }
        if (current.kind === 'node') {
          event.preventDefault();
          if (!moveToAdjacentBlock('next', false)) moveToAdjacentBlock('previous', false);
          return;
        }
        return;
      }

      if (current.kind === 'node' && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault();
        api.run(commands.deleteBlocks());
        return;
      }

      handleArrowKey(event, editor, current, table !== undefined, moveToAdjacentBlock);
    },
    [api, editor, mod, moveToAdjacentBlock, onShellAction, slash],
  );

  /* ---------------------------------------------------------------------- */
  /* Slash menu bookkeeping                                                  */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (selection.kind !== 'text') {
      setSlash(null);
      return;
    }
    const at = selection.anchor;
    const container = resolveContainer(doc, at);
    if (container === undefined) {
      setSlash(null);
      return;
    }
    const text = runsText(container.runs);
    const offset = toAbsolute(container, at);

    if (slash !== null) {
      const open =
        slash.blockId === at.blockId &&
        slash.path.join() === containerPath(at).join() &&
        offset > slash.start &&
        text.charAt(slash.start) === '/' &&
        !/\s/u.test(text.slice(slash.start + 1, offset));
      if (!open) setSlash(null);
      return;
    }

    // Open when the caret is directly after a `/` that begins a word.
    if (offset === 0 || text.charAt(offset - 1) !== '/') return;
    const preceding = offset >= 2 ? text.charAt(offset - 2) : '';
    if (preceding !== '' && !/\s/u.test(preceding)) return;
    setSlash({ blockId: at.blockId, path: containerPath(at), start: offset - 1 });
  }, [doc, selection, slash]);

  useLayoutEffect(() => {
    setSlashAnchor(slash === null ? null : caretRect());
  }, [slash, revision]);

  const slashQuery = useMemo(() => {
    if (slash === null || selection.kind !== 'text') return '';
    const container = resolveContainer(doc, selection.anchor);
    if (container === undefined) return '';
    return runsText(container.runs).slice(slash.start + 1, toAbsolute(container, selection.anchor));
  }, [doc, selection, slash]);

  const slashMatches = useMemo(() => matchSlashItems(slashQuery), [slashQuery]);

  const runSlashItem = useCallback(
    (item: SlashItem): void => {
      const state = slash;
      setSlash(null);
      if (state === null) return;

      const probe: Point = { blockId: state.blockId, path: [...state.path, 0], offset: 0 };
      const container = resolveContainer(editor.getDocument(), probe);
      if (container === undefined) return;
      const text = runsText(container.runs);
      const end = Math.min(state.start + 1 + slashQuery.length, text.length);

      // Remove the `/query` the user typed before running the item, so the
      // block it produces does not carry the menu's own trigger text.
      editor.select({
        kind: 'text',
        anchor: fromAbsolute(container, state.start),
        focus: fromAbsolute(container, end),
      });
      editor.dispatch(commands.deleteBackward());

      if (item.effect.kind === 'pickImage') {
        pickImage();
        return;
      }
      for (const command of item.effect.run()) editor.dispatch(command);
    },
    [editor, pickImage, slash, slashQuery],
  );

  const dismissSlash = useCallback(() => {
    setSlash(null);
  }, []);

  const registerSlashKeys = useCallback(
    (handler: ((key: string, shift: boolean) => boolean) | null) => {
      slashKeyRef.current = handler;
    },
    [],
  );

  /* ---------------------------------------------------------------------- */
  /* Derived surface facts                                                   */
  /* ---------------------------------------------------------------------- */

  const surface: SurfaceInfo = useMemo(() => {
    const selectedBlocks = new Set<string>();
    if (selection.kind === 'text') {
      const spans = commands.selectedSpans(doc, selection);
      if (spans.length > 1) for (const span of spans) selectedBlocks.add(span.blockId);
    }
    return {
      generations,
      selectedBlocks,
      nodeSelection: selection.kind === 'node' ? selection.blockId : null,
      cellSelection:
        selection.kind === 'cells'
          ? { tableId: selection.tableId, rect: cellRect(selection) }
          : null,
      activeBlockId:
        selection.kind === 'text'
          ? selection.focus.blockId
          : selection.kind === 'cells'
            ? selection.tableId
            : selection.blockId,
      pending,
      dropTarget,
      composing,
    };
  }, [composing, doc, dropTarget, generations, pending, selection]);

  return (
    <SurfaceContext.Provider value={surface}>
      <div
        className={`mdv-surface${composing ? ' is-composing' : ''}`}
        ref={rootRef}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {dropTarget !== null && dropTarget.afterBlockId === null ? (
          <div className="mdv-dropline" aria-hidden="true" />
        ) : null}
        {doc.blocks.map((block) => (
          <BlockView key={block.id} block={block} />
        ))}
        {pending.map((item) => (
          <div className="mdv-pending" key={item.id} role="status">
            <span className="mdv-spinner" aria-hidden="true" />
            <span>
              Decoding <strong>{item.name}</strong> ({formatBytes(item.sourceBytes)})…
            </span>
          </div>
        ))}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          startIngest(files, null);
        }}
      />

      {slash !== null ? (
        <SlashMenu
          anchor={slashAnchor}
          query={slashQuery}
          items={slashMatches}
          onChoose={runSlashItem}
          onDismiss={dismissSlash}
          registerKeyHandler={registerSlashKeys}
        />
      ) : null}
    </SurfaceContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function hostPlatform(): string {
  const scope = globalThis as { navigator?: { platform?: string; userAgent?: string } };
  return scope.navigator?.platform ?? scope.navigator?.userAgent ?? '';
}

/** Which top-level block a drop at `clientY` should land after. */
function dropTargetAt(root: HTMLElement, clientY: number): DropTarget {
  const blocks = root.querySelectorAll<HTMLElement>(':scope > [data-mdv-block]');
  let afterBlockId: string | null = null;
  for (const element of blocks) {
    const box = element.getBoundingClientRect();
    if (clientY >= (box.top + box.bottom) / 2)
      afterBlockId = element.dataset['mdvBlock'] ?? afterBlockId;
  }
  return { afterBlockId };
}

/**
 * A selection that makes an insertion land after `afterBlockId`.
 *
 * `insertBlocksAtSelection` inserts after the anchor block when the caret is at
 * its end, so that is what this produces. When the target is atomic — an image,
 * a chart — there is no caret in it, and the next block's start is the same
 * position from the document's point of view.
 */
function placementSelection(doc: MdvDocument, afterBlockId: string | null): Selection | null {
  if (afterBlockId === null) return null;
  const block = findBlock(doc, afterBlockId)?.block;
  if (block === undefined) return null;

  if (!isAtomicBlock(block)) {
    const container = resolveContainer(doc, {
      blockId: block.id,
      path: block.kind === 'table' ? [block.rows.length - 1, 0, 0] : [0],
      offset: 0,
    });
    if (container !== undefined) {
      const at = fromAbsolute(container, containerLength(container));
      return { kind: 'text', anchor: at, focus: at };
    }
  }

  const next = commands.nextLeaf(doc, block.id);
  if (next === undefined || isAtomicBlock(next)) return { kind: 'node', blockId: block.id };
  const container = resolveContainer(doc, {
    blockId: next.id,
    path: next.kind === 'table' ? [0, 0, 0] : [0],
    offset: 0,
  });
  if (container === undefined) return null;
  const at = fromAbsolute(container, 0);
  return { kind: 'text', anchor: at, focus: at };
}

/** Select every block in the document, first to last. */
function selectWholeDocument(editor: Editor): void {
  const doc = editor.getDocument();
  const first = doc.blocks[0];
  const last = doc.blocks[doc.blocks.length - 1];
  if (first === undefined || last === undefined) return;

  const start = resolveContainer(doc, {
    blockId: first.id,
    path: first.kind === 'table' ? [0, 0, 0] : [0],
    offset: 0,
  });
  const end = resolveContainer(doc, {
    blockId: last.id,
    path: last.kind === 'table' ? [Math.max(0, last.rows.length - 1), 0, 0] : [0],
    offset: 0,
  });
  if (start === undefined || end === undefined) return;
  editor.select({
    kind: 'text',
    anchor: fromAbsolute(start, 0),
    focus: fromAbsolute(end, containerLength(end)),
  });
}

/**
 * Arrow keys at a block boundary.
 *
 * Inside a block the browser is left to it — it knows about bidi, grapheme
 * clusters and where a soft wrap fell, and reimplementing that would be
 * strictly worse. Only the boundary cases are intercepted, because with one
 * editing host per block the browser has nowhere to go.
 */
function handleArrowKey(
  event: ReactKeyboardEvent<HTMLDivElement>,
  editor: Editor,
  current: Selection,
  inTable: boolean,
  moveToAdjacentBlock: (direction: 'previous' | 'next', extend: boolean) => boolean,
): void {
  if (current.kind !== 'text') return;

  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
  if (!horizontal && !vertical) return;

  if (inTable && vertical) {
    event.preventDefault();
    editor.dispatch(commands.navigateCell(event.key === 'ArrowUp' ? 'up' : 'down'));
    return;
  }

  const doc = editor.getDocument();
  const container = resolveContainer(doc, current.focus);
  if (container === undefined) return;
  const offset = toAbsolute(container, current.focus);

  if (horizontal) {
    if (inTable) return; // Left/Right stay inside the cell.
    const atStart = offset === 0 && event.key === 'ArrowLeft';
    const atEnd = offset === containerLength(container) && event.key === 'ArrowRight';
    if (!atStart && !atEnd) return;
    if (moveToAdjacentBlock(atStart ? 'previous' : 'next', event.shiftKey)) event.preventDefault();
    return;
  }

  // Vertical: only leave the block from its first or last visual line.
  const domSelection = document.getSelection();
  if (domSelection === null || domSelection.focusNode === null) return;
  const host = closestContainer(
    domSelection.focusNode as unknown as NodeLike,
  ) as unknown as Element | null;
  if (host === null) return;
  const line = linePositionIn(host, rectAt(domSelection.focusNode, domSelection.focusOffset));
  const leaving =
    event.key === 'ArrowUp'
      ? line === 'first' || line === 'both'
      : line === 'last' || line === 'both';
  if (!leaving) return;
  if (moveToAdjacentBlock(event.key === 'ArrowUp' ? 'previous' : 'next', event.shiftKey))
    event.preventDefault();
}
