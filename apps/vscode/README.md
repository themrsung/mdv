# MDV for Visual Studio Code

The reference editor integration for **MDV** — Markdown Data Visualization. It
implements SPEC 29 (`Editor Integration`) against `@mdv/core`, `@mdv/parser`,
`@mdv/charts`, `@mdv/render-svg` and `@mdv/themes` from this monorepo.

> **The language server is not implemented.** SPEC 29.4 specifies a full
> `@mdv/lsp` server; that is milestone M7 and is out of scope for this pass.
> Everything the server would provide is either computed in-process here or
> absent, and both cases are listed under [Known gaps](#known-gaps).

---

## Install from source

There is no published `.vsix`. Build the bundle in-tree and point VS Code at the
folder.

```sh
# from the repository root, once
pnpm install

# build the three bundles
pnpm --filter mdv run build
```

That produces:

| File                    | Host                     | Notes                                 |
| ----------------------- | ------------------------ | ------------------------------------- |
| `dist/extension.js`     | desktop (`main`)         | CommonJS, `node20`, `vscode` external |
| `dist/web/extension.js` | `vscode.dev` (`browser`) | no Node builtins at all               |
| `dist/webview.js`       | preview webview          | IIFE, loaded under a nonce            |

The bundles are self-contained: esbuild inlines the sibling packages **from
source**, resolved through the `paths` map in `tsconfig.base.json`, so the only
module required at runtime is `vscode` itself (plus `buffer`/`process` in the
desktop bundle).

### Run it

Either

- **Extension Development Host** — open `apps/vscode` in VS Code and press
  <kbd>F5</kbd>; or
- **Side-load** — symlink or copy the folder into your extensions directory and
  reload the window:

  ```sh
  ln -s "$PWD/apps/vscode" ~/.vscode/extensions/mdv-vscode-dev
  ```

  Only `package.json`, `dist/`, `syntaxes/`, `snippets/`, `icons/` and the two
  `*language-configuration.json` files are needed at run time; `src/` and
  `test/` are not.

While iterating, `pnpm --filter mdv run watch` rebuilds the desktop
bundle unminified with a source map on every save.

---

## What it does

### Activation

`onLanguage:mdv`, `onLanguage:markdown` and `onCustomEditor:mdv.reader`. There is
deliberately no `*`: opening an unrelated project does not load MDV.

### Language contributions (SPEC 29.2)

`.mdv` is registered as the `mdv` language, with light and dark file icons and a
bracket/comment configuration. A second language id, `mdv-block`, carries its own
configuration and is named as the `embeddedLanguages` target for the inside of a
visual block, so auto-closing and comment toggling behave differently in a block
header than in the surrounding prose. A `mdv.reader` custom editor is offered at
`priority: "option"`, so double-clicking a `.mdv` file still opens the text
editor.

### Live preview (SPEC 29.3)

A webview panel, at most one per document, restored after a window reload by a
`WebviewPanelSerializer`.

- **Incremental.** The pipeline memoises each stage — parse, data resolution,
  per-block layout — and re-runs only the stages whose inputs changed. A block's
  memo key hashes its source text, a fingerprint of the resolved table, its
  position, and the width/theme/level/strict inputs, so editing one chart in a
  fifty-chart document lays out exactly one block. The panel then diffs the
  rendered SVG strings and posts only what differs.
- **Survives rapid editing.** Renders are debounced by
  `mdv.preview.debounceMs` _and_ serialised: an edit arriving mid-run sets a
  dirty flag instead of starting a second run, so results cannot land out of
  order.
- **Bidirectional scroll sync**, guarded in both directions so the editor and
  the preview cannot chase each other.
- **Strict CSP.** `default-src 'none'; img-src ${cspSource} data:; style-src
${cspSource} 'nonce-…'; script-src 'nonce-…'` — no remote content of any kind,
  no inline handlers, no `eval`. The nonce is 128 bits from
  `crypto.getRandomValues`, fresh per panel load. `localResourceRoots` is the
  extension bundle plus the document's own folder, nothing else.
- **Never kills the extension host.** Every listener, timer and command goes
  through the `safe`/`safeCommand` wrappers in `src/log.ts`; a pipeline failure
  is logged and leaves the last good picture on screen. There is no `await` in
  this extension whose rejection can reach the host unhandled.

### Diagnostics (SPEC 29.4, in-process)

Diagnostics are computed by calling `@mdv/core` directly and published to a
`DiagnosticCollection`. All of that sits behind `DiagnosticService` in
`src/diagnostics/service.ts` — a four-member interface (`kind`, `revalidate`,
`revalidateAll`, `dispose`). Swapping in a `vscode-languageclient` that lets a
real server publish is one line in `extension.ts`; nothing else in the extension
knows which engine is running.

Code lenses, completion and formatting are likewise computed in-process from the
same memoised pipeline rather than by a server.

### Commands (SPEC 29.5)

`mdv.showPreview`, `mdv.showPreviewToSide`, `mdv.export.{pdf,html,svg,png}`,
`mdv.exportBlock`, `mdv.insertChart`, `mdv.tableToChart`, `mdv.pasteData`,
`mdv.showData`, `mdv.validateTheme`, `mdv.togglePreviewTheme`,
`mdv.allowExternalForWorkspace`. Exports report progress with `withProgress`,
are cancellable, and write beside the source file unless a path is chosen. All
file I/O goes through `vscode.workspace.fs`, never `node:fs`, so the same code
runs on `vscode.dev`.

Keybindings: <kbd>Ctrl/Cmd+Shift+V</kbd> (preview) and
<kbd>Ctrl/Cmd+K V</kbd> (preview to the side), both `when`-guarded to MDV
editors.

### Settings (SPEC 29.6)

All sixteen `mdv.*` settings are declared **and read at runtime**; the table in
`src/settings.ts` names the consumer of each one. Security defaults are safe
(`allowExternal: false`, empty `allowedOrigins`) and both are `machine-overridable`
and listed in `capabilities.untrustedWorkspaces.restrictedConfigurations`.
`readSettings` additionally re-derives the security slice from `inspect()` and
ignores workspace values while the workspace is untrusted, so a repository
cannot turn on network access for its own documents even if the manifest is
edited.

### Syntax highlighting (SPEC 29.7)

`syntaxes/mdv.tmLanguage.json` colours YAML front matter, the ` ```mdv ` fence
and its info string, the header section, the `---` separator and the data
section, and embeds Markdown everywhere else.
`syntaxes/mdv-injection.json` injects the same block grammar into plain
Markdown files, so an MDV fence inside a `.md` is highlighted too.

### Markdown preview integration

`markdown.markdownItPlugins` / `extendMarkdownIt`: MDV fences in the _built-in_
Markdown preview render as `<div class="mdv-block" role="figure" aria-label="…">`
containing the SVG. The plugin never trusts the host's `escapeHtml` for
attribute values — it escapes `"` itself — and a failure anywhere falls back to
the host's fence renderer rather than throwing, because a throw from a renderer
rule blanks the entire preview.

---

## Known gaps

| Gap                                         | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language server**                         | SPEC 29.4's `@mdv/lsp` is **not implemented** (milestone M7). Diagnostics, completion, code lenses and formatting are in-process; hover, code actions, symbols, folding, rename, inlay hints and semantic tokens are absent. `mdv.trace.server` currently controls the verbosity of the in-process engine's log.                                                                                                                                                                                                                                                                               |
| **PDF export**                              | `mdv.export.pdf` reports that it is unavailable. `@mdv/render-pdf`'s `exportPdf` is a stub in this tree (SPEC 28). The command is also `when`-gated on `mdv.hostHasNode`.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **PNG export**                              | `mdv.export.png` reports that it is unavailable: rasterising needs a canvas backend (`@mdv/render-canvas`, SPEC 23.2) that does not exist here. `mdv.exportBlock` therefore writes SVG.                                                                                                                                                                                                                                                                                                                                                                                                        |
| **`format.attributeOrder: "alphabetical"`** | Has no `FormatOptions` counterpart in `@mdv/parser`; it degrades to `canonical` and says so once in the log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **`@mdv/core`'s `resolve()`**               | Both `resolve()` and `resolveSync()` throw `not implemented` in this tree, so `src/pipeline/` composes the SPEC 18 stages itself — front-matter defaults, the SPEC 5.5 attribute cascade, the SPEC 7.1 encoding lift, then `layoutBlock` and `toSvgString`. When core's `resolve()` lands, `pipeline.ts` should call it and `cascade.ts` should shrink to nothing.                                                                                                                                                                                                                             |
| **`@mdv/core` subpath imports**             | `src/pipeline/pipeline.ts` deep-imports `resolveDocumentData`, `resolveDocumentDataSync`, `visualBlocks` and `dataOptionsFrom` from `@mdv/core/resolve.js`, and `src/pipeline/cascade.ts` re-exports the cascade from `@mdv/core/cascade.js`. Both resolve in-tree through `tsconfig.base.json` `paths`, but neither subpath is in `packages/core/src/index.ts` or in `packages/core/package.json`'s `exports` map, so a consumer of the published package could not do the same. Core should re-export both from its index and widen `exports`; these become root imports the moment it does. |
| **Theme files**                             | A block naming a theme file (`theme: ./corporate.yaml`) degrades to the preview theme and reports the name it could not load; only the four built-ins resolve.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Integration tests**                       | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Testing

```sh
pnpm exec tsc --noEmit -p apps/vscode/tsconfig.json
pnpm exec vitest run apps/vscode
pnpm --filter mdv run build
```

**No VS Code integration test host was available in this environment**, so
nothing here has been exercised inside a real extension host — no
`@vscode/test-electron` run, no manual smoke test of the preview. What _is_
verified is:

- the whole package type-checks under `strict` with `exactOptionalPropertyTypes`
  and `noUncheckedIndexedAccess`;
- all three esbuild bundles build;
- 75 unit tests covering the pipeline and its incrementality (asserting the
  exact `PipelineStats` for a re-render, an edit to one chart, and an edit to a
  shared dataset), the attribute cascade and encoding lift, theme selection, the
  markdown-it plugin, and the manifest and static assets — activation events,
  every menu/keybinding command being declared, the sixteen settings, asset
  existence, icon safety, grammar `#include` resolution and regex validity, and
  every snippet expanding into a document the parser accepts.

The unit tests deliberately import **nothing** that reaches the `vscode` module,
which is why logging is dependency-injected (`LogSink` in `src/log.ts`, with
`src/channel.ts` as the only file that touches `vscode.window.createOutputChannel`).
The VS Code-facing half — panel lifecycle, command registration, the custom
editor — is therefore covered by compilation only.
