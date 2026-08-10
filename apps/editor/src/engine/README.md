# `@editor/engine` — the MDV editing engine

The headless core of the WYSIWYG `.mdv` editor: an immutable document model, a
selection algebra, a command layer, undo/redo, selection mapping, a reader and a
writer for `.mdv` text, clipboard flavours, and image ingestion.

Everything here is plain TypeScript. There is no React, no DOM requirement in
the pure paths, and **no runtime dependencies at all**.

## Hard constraints

- **Separate engine from the parser.** Nothing in this directory imports
  `@mdv/parser`, `@mdv/core`, or any other `@mdv/*` package, and nothing depends
  on micromark or mdast. The engine owns its own model (`model.ts`) and its own
  reader and writer (`io/`). Round-tripping is verified against the engine's own
  corpus, not against another package's output.
- **Zero runtime dependencies.** No packages were added.
- **ESM only**, TypeScript strict with `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`.
- **Deterministic.** No `Date.now()`, no `Math.random()`, no locale-dependent
  comparison, no reliance on object key order. Ids come from an injected
  `IdFactory`, so reading the same text twice yields two structurally identical
  documents, ids included. Times and randomness, where a host needs them, are
  the host's business.

## Quick start

```ts
import { createEditor, insertText, toggleMark } from './engine/index.js';

const editor = createEditor({ text: '# Title\n\nSome text\n' });

editor.dispatch(insertText('!')); // returns the Transaction, or null
editor.dispatch(toggleMark({ type: 'strong' }));
editor.undo();

editor.toText(); // back to `.mdv` source
const off = editor.subscribe(() => render(editor.getSnapshot()));
```

A command that does not apply returns `null` rather than throwing: that is not
an error, it is a key the editor does not handle in this position, and the host
may fall through to the browser default.

## Layout

| Path                                  | What lives there                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `model.ts`                            | The document model: plain, immutable, `structuredClone`-able nodes.               |
| `ids.ts`, `tree.ts`, `builders.ts`    | Id allocation, tree navigation/edits, node constructors.                          |
| `inline.ts`, `grapheme.ts`            | Runs and marks; grapheme-cluster segmentation for caret motion.                   |
| `selection.ts`                        | Points, text/node/cell selections, normalisation, absolute↔path offsets.          |
| `table.ts`                            | Rectangular cell selections and the ragged-table invariant.                       |
| `state.ts`, `history.ts`, `editor.ts` | State, coalescing undo stacks, the `Editor` facade.                               |
| `mapping.ts`                          | Where did this position go? Commands record splices/moves/drops; mapping answers. |
| `commands/`                           | Text, marks, structure, lists, tables, insertion — all `Command`s.                |
| `io/`                                 | `read()` and `write()` for `.mdv`, attribute notation, escaping.                  |
| `clipboard/`                          | Copy/paste across three flavours plus hostile-HTML normalisation.                 |
| `image/`                              | Blob → resized, re-encoded `data:` URI, through an injected codec.                |
| `errors.ts`                           | `EngineError` with a stable `EngineErrorCode`.                                    |

## Concepts worth knowing before using it

**Offsets are content-relative.** A point's offset indexes the block's inline
content, not its source. In `# A long heading`, offsets `2..6` are `long`; the
`# ` marker is syntax, not text.

**Copy produces three flavours.** `text/x-mdv` is the document's own source, so
a copy between two `.mdv` documents is exact — visual blocks, attribute quoting,
raw blocks and all. `text/plain` is _also_ the source, which is the useful thing
to paste into a terminal or a commit message. `text/html` is semantic HTML for
everyone else. Paste prefers them in that order; paste-without-formatting takes
the plain text and inserts it literally, escaping anything that would otherwise
be re-read as markup. Fragments come back with fresh ids, so a copied fragment
can be pasted straight back into the document it came from.

**Images are ingested, not fetched.** `ingestImage` resizes and re-encodes
through an `ImageEnvironment` you supply (`browserImageEnvironment` is provided
for the browser); the engine never performs network I/O.

**Selection mapping is explicit.** Commands describe their edits to a
`MappingBuilder`, so splitting a paragraph sends the caret's tail into the _new_
block instead of clamping it to the end of the old one.

## Tests and typecheck

```sh
pnpm exec vitest run --config apps/editor/src/engine/vitest.config.ts
pnpm exec tsc --noEmit -p apps/editor/tsconfig.json
```

The suite is self-contained: it exercises this package only, with no
cross-package integration. `__tests__/corpus.ts` holds the round-trip corpus —
add a document there and both directions are checked automatically.
