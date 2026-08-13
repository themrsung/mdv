# UI tests

```
pnpm exec vitest run --config apps/editor/src/ui/vitest.config.ts
```

These run in Node with `environment: 'node'`. There is no jsdom in the
repository and this suite does not want one: a fake DOM that agrees with the
code under test proves nothing about a browser, and it costs a dependency plus
a second, subtly different set of DOM semantics to reason about.

So the split is deliberate:

- **Everything that can be a pure function is one**, and is tested here.
  `dom/offsets.ts`, `dom/contract.ts` and `dom/selection.ts` take a minimal
  structural node interface (`nodeType` / `parentNode` / `childNodes` /
  `getAttribute` / `data`) rather than `Node`, which real DOM nodes satisfy
  structurally and `fake-dom.ts` satisfies in a hundred lines. `input/`,
  `menus/slash-items.ts` and `state/` are already free of the DOM.
- **Everything that needs real layout, a real caret or a real user gesture is
  listed below** and is verified by hand in a browser, because there is no
  honest way to assert it in Node.

`selection.test.ts` builds its fake tree out of the engine's own runs — it calls
`createEditor()` on Markdown source and renders whatever comes back — so the
round-trip is asserted against real documents rather than against hand-written
trees that happen to match the mapper's assumptions.

## Not covered here (browser only)

| Area                                                                                               | Why Node cannot see it                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dom/caret.ts` — `caretRect`, `rectAt`, `caretFromPoint`, `linePositionIn`, `blocksByDistanceFrom` | Client rectangles require layout. `linePositionIn` compares the caret box with the host box to decide whether ↑/↓ leaves the block. `blocksByDistanceFrom` orders blocks by vertical distance from a click that hit no text.          |
| Slash-menu placement                                                                               | `SlashMenu` renders nothing until it has a caret rectangle, and flips above the caret when there is less than 260px below it.                                                                                                         |
| Selection sync (`EditorSurface`)                                                                   | Needs a live `contenteditable`, a real `selectionchange`, and a real focus/blur cycle. The offset mapping underneath it _is_ covered here.                                                                                            |
| IME composition                                                                                    | `compositionstart`/`update`/`end` and the non-cancelable `beforeinput` that Android soft keyboards send. `intents.ts` covers the decision; only a browser covers the event sequence. `diffText` (the reconciliation) is covered here. |
| Clipboard and drag-and-drop                                                                        | `DataTransfer`, `ClipboardEvent`, file drops.                                                                                                                                                                                         |
| Image ingestion                                                                                    | `createImageBitmap`, `<canvas>` re-encoding. `input/images.ts` takes the decoder as an `ImageEnvironment`, so its policy is testable; the decoder itself is not.                                                                      |
| File open/save                                                                                     | File System Access API, the `<a download>` fallback, `beforeunload`.                                                                                                                                                                  |
| Theme following                                                                                    | `matchMedia('(prefers-color-scheme: dark)')` and the `prefers-contrast` / `forced-colors` rules in `styles/app.css`.                                                                                                                  |
| `styles/app.css`                                                                                   | Cascade, `white-space: pre-wrap`, focus rings, print rules.                                                                                                                                                                           |

## Manual pass

Run `pnpm --filter @mdv/editor dev` and check, at minimum:

1. Type into a paragraph — text appears once, and the `beforeinput` is
   cancelled (the engine, not the browser, made the change).
2. Type Korean or Japanese with the OS IME — candidates commit once, and the
   caret does not jump. Then undo: one composition is one undo step.
3. `/` after whitespace opens the menu; typing filters it; ↑/↓ move; Enter
   applies the block and removes the `/query` text; Escape closes it and leaves
   the text alone.
4. Select across two blocks and press Backspace, then undo.
5. Toolbar Bold on a selection — the source pane shows `**…**`.
6. Save, reload, and accept the recovery banner.
7. Switch the OS between light and dark with the theme control on _System_.
8. On a document of one short paragraph, click far below it — in the empty
   space that is most of the window. The caret lands at the end of that
   paragraph and typing goes in there. The surface, not the pane, owns that
   space; if the padding moves back to `.mdv-pane--document` the click hits the
   pane and nothing happens.
9. With the caret in a paragraph, click Heading 1 on the toolbar and keep
   typing without clicking back. The text goes into the heading. Changing the
   kind swaps the editing host, which the browser reports as a `focusout` with
   no `relatedTarget` — indistinguishable from a real blur until the render
   commits, so the surface defers the verdict rather than believing it. Then
   click the wordmark in the header: focus leaves for good and does _not_ get
   pulled back by the next Undo.

A synthetic `dispatchEvent(new InputEvent('beforeinput', …))` from the console
is **not** a substitute for step 1: it leaves the browser's own caret where it
was, so anything downstream that reads `getSelection()` for geometry — the
slash menu especially — behaves differently than it does for a real keystroke.
