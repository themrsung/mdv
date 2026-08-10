# CONTRACTS

**Read this before writing a line of code.** It is the integration surface for
the MDV reference implementation: who owns which files, what each package
exports, and the rules that keep ten people working in one tree from destroying
each other's work.

The normative document is [`SPEC.md`](./SPEC.md). Where this file and the spec
disagree, the spec wins and this file is the bug.

---

## 1. The rules

### 1.1 Disjoint ownership

Every directory has exactly one owner. **Write only inside the paths you own.**
Do not edit, move, reformat or delete a file outside them — not to fix a typo,
not to unblock yourself. If you need a change in someone else's package, say so
in your summary and work around it locally in the meantime.

Never run repo-wide tooling: no `prettier --write .`, no `eslint --fix .`, no
codemods, no `git add -A`, no `git commit`, no `git checkout`, no `git stash`.

### 1.2 No installs

**Do not run `pnpm install`, `npm install`, or `yarn`.** Concurrent installs
corrupt the lockfile. Everything currently declared is already installed.

If you genuinely need a new dependency: add it to *your own* package's
`package.json`, state it loudly in your summary, and keep working. Integration
installs it.

### 1.3 The four invariants

Verbatim from SPEC 17.3. These are not guidelines.

> 1. `@mdv/core` never touches the DOM, the filesystem, the network, or the
>    clock. All four arrive through injected capabilities
>    ([§25.2](#252-capabilities)).
> 2. Layout is pure: `(ResolvedBlock, Theme, Size, TextMetrics) → Scene`.
> 3. Backends are total: any valid scene graph renders on any backend, or the
>    backend declares the node type unsupported at registration time.
> 4. No global mutable state. Two documents render concurrently without
>    interference — required for a server and for the VS Code preview.

`eslint.config.js` enforces invariant 1 mechanically for `packages/core/src`:
`document`, `window`, bare `fetch`, `Math.random`, `Date.now` and Node built-ins
are all errors there.

### 1.4 Determinism (SPEC 24.3)

Same source + same config + same version ⇒ **byte-identical output**. In library
code that means: no `Math.random()` (seed from the block id), no wall-clock reads
(`now()` is `config.buildTime`), no host locale or timezone (both come from
config), map iteration in insertion order, any data-derived set sorted before
use, and element ids from the `mdv-{blockIndex}-{counter}` scheme — never
content-derived, never random.

`Array.prototype.sort` with no comparator and `localeCompare` are both banned in
library code: they are locale- and engine-dependent.

---

## 2. How packages import each other

**There is no build step between packages.** `@mdv/core` resolves to
`packages/core/src/index.ts`, not to a `dist`. Editing a type in one package is
immediately visible in every other, in your editor, in `tsc`, in Vitest and in
the editor app's dev server.

Three files make that work, and they must stay in sync:

| File | Mechanism |
|---|---|
| `tsconfig.base.json` | `compilerOptions.paths` — `"@mdv/core": ["packages/core/src/index.ts"]`, plus `"@mdv/core/*"` for deep imports. Resolved relative to the repo root because `baseUrl` lives in the base config. |
| `vitest.config.ts` | `resolve.alias`, generated from the same package list. Deep-import patterns are listed before bare ones, because Vite tests aliases in order. |
| `apps/editor/vite.config.ts` | the same alias table again, for the app bundle. |

**If you add a package, you must add it to all three.** Ask the foundation owner
rather than editing them yourself.

Consequences worth knowing:

- Always import by package name (`import type { Scene } from '@mdv/core'`), never
  by relative path across a package boundary (`../../core/src/...`). The latter
  compiles today and breaks the moment anything is published.
- Relative imports **inside** a package carry the `.js` extension
  (`./types/scene.js`), which is correct for the ESM output. TypeScript and Vite
  both map it back to the `.ts` source.
- A package's entry point must remain `src/index.ts`. `@mdv/react` re-exports its
  `.tsx` modules from `src/index.ts` for exactly this reason.

### Per-package builds

Each package's `tsconfig.json` is `composite` and declares `references` to its
workspace dependencies, so `pnpm -r build` (`tsc -b`) produces real `dist/` output
in topological order. The root `tsconfig.json` is a separate, flat, non-emitting
project that typechecks the whole tree from source — that is what
`pnpm exec tsc --noEmit` runs.

**If you add a cross-package dependency, add the matching `references` entry** to
your package's `tsconfig.json`, or `pnpm -r build` will fail with TS6059.

---

## 3. Packages

### `@mdv/spec` — `packages/spec/`

Specification artefacts. **No runtime logic.** Depends on nothing.

| Path | Contents |
|---|---|
| `errors.json` | Every Appendix C code as `{code, severity, summary}`. The single source of default severities. |
| `schemas/common/*.json` | `block`, `channel`, `scale`, `axis`, `format`, `dimension` — SPEC Appendix D. |
| `schemas/block/*.json` | One per block type. `bar.json` is complete and is the template. |
| `tests/` | The normative conformance corpus (SPEC 16.2). See `tests/README.md` for the fixture layout. |
| `src/` | A typed loader over `errors.json`. |

Public API: `ERROR_TABLE`, `ERROR_CODES`, `lookupErrorCode`, `severityOf`,
`summaryOf`, `groupOf`, `groupName`, `codesInGroup`, `isKnownErrorCode`,
`SPEC_VERSION`; types `ErrorCodeEntry`, `ErrorSeverity`, `ConformanceLevel`,
`FixtureMeta`, `FixtureCategory`.

*Deviation from SPEC 17.2:* the dependency table lists `@mdv/spec` as depended on
by nobody. In this implementation `@mdv/parser` and `@mdv/core` both depend on it,
so diagnostic severities come from one table instead of being duplicated in code.

### `@mdv/parser` — `packages/parser/`

Text → MDV AST. Position-accurate through the header and data sub-parses.
Depends on `@mdv/spec`, `micromark*`, `mdast-util-*`, `yaml`.

- `src/types.ts` — the AST (SPEC 19) and the diagnostic vocabulary (SPEC 14.2):
  `MdvDocument`, `MdvBlock`, `MdvDirective`, `MdvError`, `FrontMatter`,
  `AttrMap`, `AttrValue`, `AttrRanges`, `Position`, `Range`, `Diagnostic`,
  `DiagnosticSeverity`, `DiagnosticSource`, `CodeFix`, `TextEdit`. Re-exports the
  standard mdast node types unchanged, and augments `mdast`'s `RootContentMap` so
  `unist-util-visit` knows about the four MDV nodes.
- `src/options.ts` — `ParseOptions`, `FormatOptions`.
- `src/index.ts` — `parse(source, options?)`, `toMarkdown(doc, options?)`.

**`Diagnostic` lives here**, not in core: the parser is the first producer of
diagnostics and core depends on the parser, not the reverse. Core re-exports it.

Contract: `parse` and `toMarkdown` never throw for document content. Malformed
input becomes diagnostics and `mdvError` nodes. `toMarkdown` MUST round-trip.

### `@mdv/core` — `packages/core/`

Datasets, inference, transforms, MDVX, scales, ticks, formatting, the theme
cascade, validation, encoding, layout, a11y text. **No DOM.** Depends on
`@mdv/parser` and `@mdv/spec`.

`src/types/` — one module per concern, all re-exported from `src/types/index.ts`
and from the package root:

| Module | Owns |
|---|---|
| `scene.ts` | SPEC 20: `Scene`, `SceneNode` and its eight variants, `Paint`, `Stroke`, `Font`, `Transform`, `PathCommand` (structured, never a `d` string), `Def`, `A11yTree`, `A11yTable`, `A11yRole`, `HitRegion`, `ReadoutRow` |
| `theme.ts` | SPEC 11: `Theme`, every token, `MarkSpec`, `CategoricalPalette`, `SequentialPalette`, `DivergingPalette`, `STATUS_PALETTE`, `PaletteValidation` |
| `config.ts` | SPEC 25: `MdvConfig`, `ResolvedConfig`, `Capabilities`, `FetchInit`, `FetchResult`, `KeyValueCache`, `Logger`, `MdvPlugin`, `MdvConfigError` |
| `data.ts` | SPEC 6: `Value`, `DataType`, `Column`, `Table`, `TableRef`, `DatasetNode`, `DataRegistry`, `TransformStep` and its twelve variants |
| `attrs.ts` | SPEC 8.1 / 5.5: `BlockAttrs`, `Dimension`, `PaddingAttr`, `LegendAttr`, `TooltipAttr` |
| `encode.ts` | SPEC 7 / 18.5: `ChannelName`, `Channel`, `Encoding`, `ChannelSpec`, `ScaleType`, `ScaleSpec`, `Scale`, `ScaleBundle`, `AxisModel`, `LegendModel`, `SeriesDescriptor`, `Mark` and its payloads, `MarkSet` |
| `layout.ts` | SPEC 18.6: `LayoutContext`, `TextMetrics`, `GlyphMetrics`, `IdFactory`, `Size`, `Rect`, `Insets` |
| `resolved.ts` | SPEC 18.2: `ResolvedDocument`, `ResolvedBlock` |
| `diagnostics.ts` | The `Diagnostic` re-export plus `createDiagnostic`, `applyStrict`, `atLeast`, `compareDiagnostics`, `isBlocking` |

`src/registry.ts` — **the chart-type contract.** `ChartType`, `EncodeInput`,
`EncodeResult`, `ChartLayoutResult`, `PaletteAllocator`, `DirectLabel`,
`ChartHitRegion`, `ChartFamily`, `ChartTypeRegistry`, `createChartRegistry`. The
prose at the top of that file states which side owns the plot frame, the axes,
the legend and the a11y tree, and which side owns the marks. **`@mdv/charts` and
`packages/core/src/layout/` are both written against it — read it in full.**

`src/index.ts` — the SPEC 21 surface: `parse`/`toMarkdown` re-exports, `resolve`,
`resolveSync`, `layoutBlock`, `validateBlock`, `createLayoutContext`,
`createTableMetrics`, `Renderer`, `RenderHandle`, `Mdv`, `MdvInstance`,
`BlockHandle`, `HtmlOptions`, `PdfOptions`, `CORE_VERSION`.

Directories inside core that other agents own: `src/data/`, `src/transform/`,
`src/expr/`, `src/scale/`, `src/encode/`, `src/layout/`, `src/a11y/`
(SPEC Appendix F.1). Create the one you own; do not create the others.

*Note:* core's `tsconfig.json` enables the `DOM` lib. That is for **types only** —
`HTMLElement` and `Blob` appear in the `Mdv` facade's signatures (SPEC 21) and are
passed straight through to a renderer. Calling a DOM API from core is a bug and
eslint will fail you for it.

### `@mdv/charts` — `packages/charts/`

One module per block type, each exporting a `ChartType`. Depends on `@mdv/core`.
Public API: `builtinChartTypes`, `chartTypesForLevel(level)`, and the per-type
named exports. Tree-shakeable: importing one type must not pull in another.

### `@mdv/render-svg` — `packages/render-svg/`

Scene → SVG. Depends on `@mdv/core`. Public API: `toSvgString`, `toSvgElement`,
`toReactElements`, `createSvgRenderer`, `attachInteraction`, `stylesheet`,
`errorCardString`. Makes **no layout decisions**.

### `@mdv/render-pdf` — `packages/render-pdf/`

Scene + document flow → PDF. Depends on `@mdv/core`, `pdf-lib`,
`@pdf-lib/fontkit`. Public API: `exportPdf`, `drawSceneOnPage`, `tracePdf`,
`createFontkitMetrics`; types `EmbeddedFont`, `PdfExportContext`, `PdfTrace`.

### `@mdv/themes` — `packages/themes/`

Built-in themes and the executable palette validator. Depends on `@mdv/core`
(types only). Public API: `getBuiltinTheme`, `listBuiltinThemes`, `resolveTheme`,
`validatePalette`, `contrastRatio`, `deltaEOklab`, and the palette constants
`CATEGORICAL_LIGHT`, `CATEGORICAL_DARK`, `SEQUENTIAL_BLUE`, `DIVERGING_MID`.

### `@mdv/react` — `packages/react/`

Depends on `@mdv/core`, `@mdv/charts`, `@mdv/render-svg`, `@mdv/themes`; `react`
and `react-dom` are peers. Public API: `MdvProvider`, `MdvDocument`, `MdvBlock`,
`useMdv`, `useMdvScene`, `useMdvTheme`, `useElementSize`. React 18+, function
components, `StrictMode`-clean.

### `@mdv/cli` — `packages/cli/`

Depends on every other package. Public API: `run(argv, io)`, the per-command
functions, `EXIT_CODES`, `GlobalFlags`. `src/bin.ts` is the `mdv` binary and is
the only file permitted to call `process.exit`.

### `@mdv/editor` — `apps/editor/`

Vite + React SPA. **Fully static: no SSR, no server, no API routes.**
`pnpm --filter @mdv/editor build` writes `apps/editor/dist/index.html`.

- `src/main.tsx`, `src/App.tsx` — the shell (foundation-owned; keep thin).
- `src/engine/` — document state and the incremental pipeline. **Owned by another agent.**
- `src/ui/` — panes, source editor, preview, diagnostics list. **Owned by another agent.**

### `mdv` (VS Code) — `apps/vscode/`

`main` is `dist/extension.js`, bundled by esbuild with `vscode` external.
`activationEvents` are `onLanguage:mdv` and `onLanguage:markdown`. The
`contributes` block is deliberately minimal — grammar, snippets, commands,
settings and the custom editor are filled in per SPEC 29.2.

### Not scaffolded

`@mdv/render-canvas` (SPEC 23.2) and `@mdv/lsp` (SPEC 29.4) are in the spec's
package table but are out of scope for this pass. Whoever adds one must also add
it to the three alias tables in §2 and to `pnpm-workspace.yaml`'s glob (already
covered by `packages/*`).

---

## 4. Commands

```bash
pnpm exec tsc --noEmit                 # typecheck the whole tree from source
pnpm exec tsc --noEmit -p packages/X/tsconfig.json   # just your package
pnpm exec vitest run                   # every test
pnpm exec vitest run packages/X        # just your package's tests
pnpm -r build                          # per-package tsc -b, topological
pnpm --filter @mdv/editor build        # the SPA
pnpm exec eslint .                     # lint
pnpm exec prettier --check .           # formatting
```

Test files go in `packages/<pkg>/test/**/*.test.ts`. Test **only your own
package**; stub or fixture anything another agent owns. No cross-package
integration tests — a later phase does that.

Cross-package type errors coming out of packages that are still stubs are
expected right now. Errors inside *your* files are not.

---

## 5. Working around a bad contract

If a shared type is genuinely wrong or insufficient:

1. Implement the smallest local workaround — a local interface, a cast at one
   boundary, a `// CONTRACT:` comment naming the file and the field.
2. Keep going. Do not redesign a shared type unilaterally; four other agents are
   compiling against it this minute.
3. Report it in your summary as `NEEDS FROM OTHERS`, with the exact file, the
   exact member, and what it should be.
