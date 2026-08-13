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
  endOfBlock,
  findBlock,
  fromAbsolute,
  isAtomicBlock,
  resolveContainer,
  runsText,
  selectionsEqual,
  startOfBlock,
  toAbsolute,
  wholeDocument,
} from '../../engine/index.js';
import { BlockView } from '../blocks/BlockView.js';
import {
  blocksByDistanceFrom,
  caretFromPoint,
  caretRect,
  linePositionIn,
  rectAt,
} from '../dom/caret.js';
import type { ElementLike, NodeLike } from '../dom/contract.js';
import {
  closestContainer,
  describeContainer,
  findBlockElement,
  findContainerElement,
} from '../dom/contract.js';
import { focusIsControl, isControl } from '../dom/controls.js';
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
import { parkedAfter } from './focus-park.js';
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
  const focusOutPendingRef = useRef<Element | null>(null);
  /*
   * Set by a press on the surface that did *not* land on a block's control.
   *
   * The engine → DOM reconcile refuses to pull focus out of a control, so that
   * a re-render cannot yank the writer out of a fence's language field on its
   * first keystroke. That guard is right for a render nobody asked for and
   * wrong for a click elsewhere on the surface, which is the plainest way there
   * is of saying "I am done with this field". The press records which of the
   * two the next reconcile is answering.
   */
  const leaveControlRef = useRef(false);
  /*
   * Set when focus leaves for something outside the surface that named itself —
   * the shell's link dialog, in practice. The engine's selection is then the
   * only true one, and the return writes it back over the caret the browser
   * supplies. {@link parkedAfter} is the rule; the prose is there.
   */
  const parkedRef = useRef(false);
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

  /*
   * Answer a `focusout` that named no successor, once the DOM has settled: an
   * element the user simply left is still in the document, an element a render
   * replaced is not. Idempotent, because both the render and the microtask that
   * follow such an event race to call it and either may arrive first.
   */
  const settleFocusOut = useCallback((): void => {
    const losing = focusOutPendingRef.current;
    if (losing === null) return;
    focusOutPendingRef.current = null;
    if (losing.isConnected) focusInsideRef.current = false;
  }, []);

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
  /* Selection: DOM → engine                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Read the browser's selection into the engine.
   *
   * `selectionchange` is delivered asynchronously, so anything that acts on the
   * selection in the same task that produced it — a keystroke landing on a
   * fresh triple-click, a paste, a copy — would otherwise run against the
   * previous selection. Every such entry point reads the DOM first, so it acts
   * on what the user can see rather than on what the engine last heard about.
   */
  const syncSelectionFromDom = useCallback((): void => {
    if (composingRef.current !== null) return;
    // While the engine holds a selection spanning two editing hosts, the
    // browser's collapsed stand-in must not be read back as the truth.
    if (crossBlockRef.current) return;
    // A caret in a block's own control is not a caret in the document; the
    // browser still reports one near the field, and reading it back would
    // move the engine's selection to a place the user never clicked.
    if (focusIsControl(document)) return;

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
  }, [editor]);

  /**
   * Write the engine's selection back over the caret a returning focus brought
   * with it.
   *
   * Runs in the `focusin` handler rather than in the engine → DOM reconcile
   * below, because that reconcile is gated on the surface holding the focus and
   * so is skipped by exactly the render that closes the dialog. Doing it here
   * also beats the browser's own `selectionchange`, which is delivered in a
   * later task and by then reports what this put back.
   */
  const restoreParkedSelection = useCallback((): void => {
    if (composingRef.current !== null) return;
    const root = rootRef.current;
    if (root === null) return;
    if (focusIsControl(document)) return;

    const current = editor.getSelection();
    if (current.kind !== 'text') return;
    const target = domTargetFor(root as unknown as NodeLike, editor.getDocument(), current);
    if (target === null) return;
    // Two editing hosts: the browser cannot hold that range, and the collapsed
    // stand-in the reconcile leaves is already in place.
    if (closestContainer(target.anchor.node) !== closestContainer(target.focus.node)) return;

    const domSelection = document.getSelection();
    if (domSelection === null) return;
    try {
      domSelection.setBaseAndExtent(
        target.anchor.node as unknown as Node,
        target.anchor.offset,
        target.focus.node as unknown as Node,
        target.focus.offset,
      );
    } catch {
      // A node from a render that has already been replaced.
    }
  }, [editor]);

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
      syncSelectionFromDom();
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
      syncSelectionFromDom();

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
      syncSelectionFromDom();
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
      focusOutPendingRef.current = null;
      const parked = parkedRef.current;
      parkedRef.current = parkedAfter(parked, 'returned');
      if (parked) restoreParkedSelection();
    };
    /*
     * Losing focus is not the same as losing the caret.
     *
     * Changing a block's type swaps the element that holds it — a paragraph
     * becomes a heading, a heading becomes a quote — and the host the user was
     * typing in is torn out of the tree mid-render. The browser reports that
     * exactly as it reports a real blur: `focusout`, no `relatedTarget`,
     * `activeElement` back on `<body>`. Believing it would strand the caret,
     * because the effect that puts focus into the replacement is the one gated
     * on this flag: after a toolbar click the document would look right and be
     * dead to the keyboard.
     *
     * The two cases only differ *after* the commit finishes: an element the
     * user left is still in the document, an element React replaced is not. So
     * a `focusout` that names no successor is not answered here — it is parked,
     * and settled below by whichever runs first, the render that follows or the
     * microtask that catches the case where no render follows at all.
     */
    const onFocusOut = (event: Event): void => {
      const next = (event as FocusEvent).relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      if (next !== null) {
        focusOutPendingRef.current = null;
        focusInsideRef.current = false;
        parkedRef.current = parkedAfter(parkedRef.current, 'left-for');
        return;
      }
      parkedRef.current = parkedAfter(parkedRef.current, 'left-unknown');
      const losing = event.target;
      focusOutPendingRef.current = losing instanceof Element ? losing : null;
      queueMicrotask(settleFocusOut);
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
  }, [
    applyIntent,
    editor,
    reconcile,
    restoreParkedSelection,
    settleFocusOut,
    startIngest,
    syncSelectionFromDom,
  ]);

  /* ---------------------------------------------------------------------- */
  /* Selection: DOM → engine, on the browser's own schedule                  */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    document.addEventListener('selectionchange', syncSelectionFromDom);
    return () => {
      document.removeEventListener('selectionchange', syncSelectionFromDom);
    };
  }, [syncSelectionFromDom]);

  /* ---------------------------------------------------------------------- */
  /* Selection: engine → DOM                                                 */
  /* ---------------------------------------------------------------------- */

  useLayoutEffect(() => {
    /*
     * First, because the gate below reads what it decides: a `focusout` parked
     * by the render that is now committing has to be answered before anything
     * asks whether the surface still holds the caret.
     */
    settleFocusOut();

    if (composingRef.current !== null) return;
    const root = rootRef.current;
    if (root === null) return;

    if (selection.kind === 'text' && selection.anchor.blockId === selection.focus.blockId) {
      crossBlockRef.current = false;
    }
    if (!focusInsideRef.current) return;
    /*
     * A control inside a block — the fence's language field, an image's alt box
     * — holds the caret the user is typing into, while the engine's selection
     * goes on naming the block that owns it. Reconciling that selection here
     * would take the focus back out of the field on its first keystroke.
     *
     * Unless the writer just pressed somewhere else on the surface: that press
     * is a request to leave, and it is the only way out of a field in a fence
     * that ends the document, where the paragraph the click opens is created
     * after this handler has already run.
     */
    const leavingControl = leaveControlRef.current;
    leaveControlRef.current = false;
    if (!leavingControl && focusIsControl(document)) return;

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
  }, [doc, selection, revision, settleFocusOut]);

  useSelectionHighlight(rootRef, doc, selection, revision);

  /* ---------------------------------------------------------------------- */
  /* Pointer: cross-block selection                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Put the browser's focus in the container holding `at`.
   *
   * The engine → DOM reconcile runs only while focus is already inside the
   * surface, and a click answered by {@link caretNearPoint} has had its default
   * prevented, so nothing has focused anything yet. Without this the caret moves
   * in the engine and never appears on screen.
   */
  const focusPoint = useCallback(
    (at: Point): void => {
      const root = rootRef.current;
      if (root === null) return;
      const target = domTargetFor(root as unknown as NodeLike, editor.getDocument(), {
        kind: 'text',
        anchor: at,
        focus: at,
      });
      if (target === null) return;
      const host = closestContainer(target.focus.node) as unknown as HTMLElement | null;
      if (host !== null && host !== document.activeElement) host.focus({ preventScroll: true });
    },
    [editor],
  );

  /**
   * A caret for a click that missed every block, or `null` if nothing can hold
   * one. Blocks are tried nearest-first because the closest may be atomic — a
   * table or an image has no text position to offer.
   */
  const caretNearPoint = useCallback(
    (clientY: number): Point | null => {
      const root = rootRef.current;
      if (root === null) return null;
      const doc = editor.getDocument();
      for (const candidate of blocksByDistanceFrom(root, clientY)) {
        const location = findBlock(doc, candidate.blockId);
        if (location === undefined || isAtomicBlock(location.block)) continue;
        const at = candidate.below ? endOfBlock(location.block) : startOfBlock(location.block);
        if (at !== undefined) return at;
      }
      return null;
    },
    [editor],
  );

  /**
   * Answer a click below a document that ends in something uncaretable.
   *
   * `caretNearPoint` would put the caret at the *end* of the last block, which
   * for a table means inside its last cell — and from there no keystroke and no
   * click reaches the space after the table, because there is no such space.
   * The writer who clicks under it is asking for a paragraph; give them one.
   * Returns false when the last block can hold a caret at its end, leaving the
   * ordinary nearest-block answer to it.
   *
   * A code fence is caretable and still qualifies: its end holds a caret that
   * only ever writes more code, since `Enter` inside a fence means a newline.
   */
  const appendPastEnd = useCallback(
    (clientY: number): boolean => {
      const root = rootRef.current;
      if (root === null) return false;
      const doc = editor.getDocument();
      const last = doc.blocks[doc.blocks.length - 1];
      if (last === undefined) return false;
      if (!isAtomicBlock(last) && last.kind !== 'table' && last.kind !== 'code') return false;
      const element = findBlockElement(root as unknown as NodeLike, last.id);
      if (element === null) return false;
      const rect = (element as unknown as Element).getBoundingClientRect();
      if (clientY <= rect.bottom) return false;
      return editor.dispatch(commands.appendParagraph()) !== null;
    },
    [editor],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return;
      const onControl = isControl(event.target as unknown as NodeLike);
      // Recorded on every press, not only the ones that leave: going back into
      // a field must clear a flag an earlier press set, or the next render
      // would evict the writer from the field they just returned to.
      leaveControlRef.current = !onControl && focusIsControl(document);
      parkedRef.current = parkedAfter(parkedRef.current, 'pressed');
      // Let a block's own control take the press; the browser focuses it and
      // the caret the engine holds stays where the writer left it.
      if (onControl) return;

      /*
       * The space under the document is answered before the hit test, not
       * after it, because `caretFromPoint` does not miss the way the padding
       * suggests: a browser snaps a click below the last block to the nearest
       * text position, which for a trailing fence is *inside* the fence. Asked
       * for a caret in the empty space under a code block, it would put one at
       * the end of the code — the one place the writer is trying to get out of.
       */
      if (!event.shiftKey && appendPastEnd(event.clientY)) {
        event.preventDefault();
        crossBlockRef.current = false;
        const placed = editor.getSelection();
        if (placed.kind === 'text') focusPoint(placed.focus);
        return;
      }

      const hit = caretFromPoint(event.clientX, event.clientY);
      const at =
        hit === null
          ? null
          : pointFromDom(editor.getDocument(), hit.node as unknown as NodeLike, hit.offset);
      if (at === null) {
        /*
         * The click landed in the surface's padding rather than on any text —
         * below the last block is the common case. A word processor puts the
         * caret at the nearest end rather than doing nothing, and doing nothing
         * here is worse than merely unhelpful: in a document whose only block is
         * an empty paragraph, the sole target is one line tall.
         */
        crossBlockRef.current = false;
        const near = caretNearPoint(event.clientY);
        if (near !== null) {
          event.preventDefault();
          editor.select({ kind: 'text', anchor: near, focus: near });
          focusPoint(near);
        }
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
    [appendPastEnd, caretNearPoint, editor, focusPoint],
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
      /*
       * Which block the move starts from. A node selection is a whole block, so
       * it is its own starting point — without this the deliberate way out of an
       * atomic block (Escape, and the arrow keys) bailed here and the block was
       * a keyboard trap whose only exit was deleting it.
       */
      const from =
        current.kind === 'text'
          ? current.focus.blockId
          : current.kind === 'node'
            ? current.blockId
            : null;
      if (from === null) return false;
      // A selected block offers no caret to grow a range from, so shift+arrow
      // leaves it the same way a bare arrow does rather than doing nothing.
      const extending = extend && current.kind === 'text';
      const document_ = editor.getDocument();
      const neighbour =
        direction === 'previous'
          ? commands.previousLeaf(document_, from)
          : commands.nextLeaf(document_, from);
      if (neighbour === undefined) return false;

      if (isAtomicBlock(neighbour)) {
        if (extending) return false;
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
      crossBlockRef.current = extending;
      editor.select(
        extending && current.kind === 'text'
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

      // A key can arrive in the same task as the pointer gesture that moved the
      // caret, before `selectionchange` has been delivered.
      syncSelectionFromDom();

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

      // Enter on a selected block opens a paragraph after it: the keyboard's
      // version of clicking the space below the document, and the only way to
      // keep writing past a chart or a rule that ends one.
      if (event.key === 'Enter' && current.kind === 'node' && !event.shiftKey) {
        event.preventDefault();
        api.run(commands.insertParagraphAfter(current.blockId));
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
    [api, editor, mod, moveToAdjacentBlock, onShellAction, slash, syncSelectionFromDom],
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

/**
 * Ctrl/Cmd+A. The range is the engine's to define — a document that opens with
 * a list or ends with a table has no addressable position in its first or last
 * *block*, so the endpoints are leaves, and working that out here as well would
 * be a second implementation to keep in step with deletion.
 */
function selectWholeDocument(editor: Editor): void {
  const selection = wholeDocument(editor.getDocument());
  if (selection) editor.select(selection);
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
  /*
   * A selected block has no caret, so it has no first or last line to be at and
   * nothing to step through: every arrow leaves it. Left and Up go back, Right
   * and Down go on, which is what the block would do if it were a single wide
   * character — and what the writer who arrowed *into* it expects when they
   * carry on in the same direction.
   */
  if (current.kind === 'node') {
    const direction =
      event.key === 'ArrowUp' || event.key === 'ArrowLeft'
        ? 'previous'
        : event.key === 'ArrowDown' || event.key === 'ArrowRight'
          ? 'next'
          : null;
    if (direction === null) return;
    // Not preventing default when the move fails leaves the browser to scroll,
    // which is the right answer at the top or bottom of a document.
    if (moveToAdjacentBlock(direction, event.shiftKey)) event.preventDefault();
    return;
  }

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
