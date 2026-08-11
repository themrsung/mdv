# MDV for Visual Studio Code

The reference editor integration for **MDV** — Markdown Data Visualization. It
implements SPEC 29 (`Editor Integration`) against `@mdv/core`, `@mdv/parser`,
`@mdv/charts`, `@mdv/render-svg` and `@mdv/themes` from this monorepo.

> **The language server runs out of process.** SPEC 29.4's `@mdv/lsp` is wired
> in: the desktop bundle forks `dist/server.cjs`, the web bundle starts
> `dist/web/server.js` in a worker, and the extension keeps a complete
> in-process engine as the fallback for hosts where neither can start. Which one
> answered is in the log line `activate` writes, and in
> [Known gaps](#known-gaps).

---

## Install from source

There is no published `.vsix`. Build the bundle in-tree and point VS Code at the
folder.

```sh
# from the repository root, once
pnpm install

# build the five bundles
pnpm --filter mdv run build
```

That produces:

| File                    | Entry                      | Host                     | Notes                                     |
| ----------------------- | -------------------------- | ------------------------ | ----------------------------------------- |
| `dist/extension.js`     | `src/extension-node.ts`    | desktop (`main`)         | CommonJS, `node20`, `vscode` external     |
| `dist/web/extension.js` | `src/extension-web.ts`     | `vscode.dev` (`browser`) | no Node builtins at all                   |
| `dist/server.cjs`       | `src/lsp/server-node.ts`   | forked by the desktop    | `@mdv/lsp` over stdio; no `vscode` import |
| `dist/web/server.js`    | `src/lsp/server-worker.ts` | worker, in the browser   | IIFE, started from the extension URI      |
| `dist/webview.js`       | `src/webview/main.ts`      | preview webview          | IIFE, loaded under a nonce                |

Five bundles from five entries, because each one is loaded by something that
cannot load the others: the two hosts differ over `vscode-languageclient`, and
the two servers over how they reach a message channel. The bundles are
self-contained — esbuild inlines the sibling packages **from source**, resolved
through the `paths` map in `tsconfig.base.json` — so the only module required at
runtime is `vscode` itself (plus `buffer`/`process` in the desktop bundle), and
the server bundles do not require even that.

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

### Theme files (SPEC 11.6)

A block's `theme:` is a built-in name (`default`, `dark`, `high-contrast`,
`print`) or a path to a `.json`, `.jsonc`, `.yaml` or `.yml` file, resolved
relative to the document. `themeFileFormat()` in `@mdv/themes` picks the reader
from the extension, so a `corporate.yaml` mistaken for a name is reported as an
unknown theme rather than as a YAML syntax error. `.jsonc` means what it means
in VS Code — comments and trailing commas are read, and the same file named
`.json` is refused with a message naming the two extensions that would take it.

Reads go through `vscode.workspace.fs` — the virtual filesystem, so themes work
the same in `vscode-vfs:` and remote workspaces — behind a synchronous seam,
because layout cannot suspend. `ThemeFiles` in `src/pipeline/themefile.ts`
answers `pending` for a URI it has not read yet, starts the read, and bumps a
revision when the text lands; the revision is part of every block's memo key, so
the next run resolves the theme and re-renders just the blocks that name it.
`pending` is not a diagnostic — a block shows the preview theme for one frame
instead of flashing an error into the Problems panel on every first paint.

One store lives in the extension host, shared by every open document: ten
documents naming `../brand/theme.yaml` cost one read and one palette
validation, keyed by URI **and** colour scheme so light and dark resolutions of
the same file coexist. A non-recursive `FileSystemWatcher` per file invalidates
on change, and granting workspace trust mid-session drops every cached refusal.

Untrusted workspaces read nothing (`MDV4002`); a file that is missing, cannot be
parsed, or is not a usable theme reports `MDV1502` and degrades to the preview
theme. A palette that loads but fails validation is a warning (`MDV3080`), never
a silent substitution — SPEC 11.2 rule 4.

### Diagnostics (SPEC 29.4)

Two engines produce the same diagnostics, and both sit behind `DiagnosticService`
in `src/diagnostics/service.ts` — a four-member interface (`kind`, `revalidate`,
`revalidateAll`, `dispose`). Nothing else in the extension knows which one is
running; the choice is made once, in `activate`, and read back off `kind`.

- **`language-server`** — the default. `@mdv/lsp` runs in a forked process
  (desktop) or a worker (web) and publishes into VS Code's diagnostic store
  itself, so the extension never calls `@mdv/core` to validate. It also answers
  completion, code lenses and formatting, which is why the extension registers
  no provider of its own while the server is up: VS Code merges providers rather
  than choosing between them, so a second registration would double every
  completion item and every lens.
- **`in-process`** — the fallback, used when no client can be built for the
  host. `@mdv/core` is called directly and the results are published to a
  `DiagnosticCollection` owned here.

Which host builds which client is the only thing `src/extension-node.ts` and
`src/extension-web.ts` do; `src/extension.ts` imports neither half of
`vscode-languageclient`, because esbuild follows imports rather than runtime
branches and a shared entry would drag `node:child_process` into the web bundle.

A settings change, a colour-theme change or a theme file landing re-validates
through the same interface either way — over `workspace/didChangeConfiguration`
for the server, by re-running the pipeline for the in-process engine.

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

All seventeen `mdv.*` settings are declared **and read at runtime**; the table in
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

| Gap                   | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Language server**   | Complete over LSP: SPEC 29.4's twelve features all run. The **in-process fallback** is narrower — diagnostics, completion, code lenses and formatting only, with hover, signature help, code actions, symbols, definition, rename, inlay hints and semantic tokens absent — so a host that cannot start the server loses those eight. `mdv.trace.server` sets the client's LSP trace level, and the in-process engine's log verbosity when it is the one running. |
| **PNG export**        | `mdv.export.png` reports that it is unavailable: rasterising needs a canvas backend (`@mdv/render-canvas`, SPEC 23.2) that does not exist here. `mdv.exportBlock` therefore writes SVG.                                                                                                                                                                                                                                                                           |
| **Remote themes**     | `theme: https://…` is never fetched. `mdv.security.allowExternal` gates it as external data, and even with the setting on the reader is `vscode.workspace.fs`, which speaks to the workspace, not the network. Such a block reports `MDV4002` and renders on the preview theme.                                                                                                                                                                                   |
| **Integration tests** | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
- 102 unit tests covering the pipeline and its incrementality (asserting the
  exact `PipelineStats` for a re-render, an edit to one chart, and an edit to a
  shared dataset), the attribute cascade and encoding lift, theme selection and
  theme-file loading (URI resolution, the read cache, and the invalidation that
  a file watcher drives), the markdown-it plugin, and the manifest and static
  assets — activation events,
  every menu/keybinding command being declared, the seventeen settings, asset
  existence, icon safety, grammar `#include` resolution and regex validity, and
  every snippet expanding into a document the parser accepts.

The unit tests deliberately import **nothing** that reaches the `vscode` module,
which is why logging is dependency-injected (`LogSink` in `src/log.ts`, with
`src/channel.ts` as the only file that touches `vscode.window.createOutputChannel`).
The VS Code-facing half — panel lifecycle, command registration, the custom
editor — is therefore covered by compilation only.
