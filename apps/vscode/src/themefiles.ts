/**
 * The workspace's theme files, read through VS Code (SPEC 11.6).
 *
 * This is the host half of `pipeline/themefile.ts`: that module knows what a
 * theme file *means* and never touches an API, this one knows how to get the
 * bytes and never parses them. The join between them is
 * {@link ThemeFileReader}, a synchronous question — "what do you have for this
 * URI right now?" — because layout cannot await.
 *
 * The answer is `pending` the first time, which starts a
 * `vscode.workspace.fs.readFile`. When the text lands the cache is filled, the
 * shared {@link ThemeFiles} store is invalidated (bumping the revision that
 * every block's render key carries) and {@link WorkspaceThemeFiles.onDidChange}
 * fires so the host can re-validate and repaint. A file that is later edited
 * takes the same path via its watcher, so `theme: ./brand.yaml` updates as you
 * type in `brand.yaml`.
 *
 * ## Restricted mode
 *
 * In an untrusted workspace nothing is read. A theme file is chosen by the
 * folder, not by the user who opened it, and following a path out of the
 * workspace on the folder's say-so is exactly the class of action restricted
 * mode exists to withhold — `mdv.security.*` is already gated the same way in
 * `settings.ts`. Blocks degrade to the preview theme and say why.
 */

import * as vscode from 'vscode';
import { ThemeFiles, type ThemeFileRead, type ThemeFileReader } from './pipeline/index.js';
import { describeError, log } from './log.js';

/** What one URI's read has produced so far. */
type Entry =
  | { readonly status: 'pending' }
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'error'; readonly message: string };

/** UTF-8, per SPEC 3.2. `fatal: false` so a mangled byte is a replacement char, not a throw. */
const decoder = new TextDecoder('utf-8');

/** Strip a UTF-8 BOM: `JSON.parse` rejects one, and it is invisible in the editor. */
function decode(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * A theme file's directory and name, for a non-recursive watcher.
 *
 * `RelativePattern` wants a base *folder*; `Uri.joinPath(uri, '..')` is the
 * portable way to drop the last segment, including for the virtual filesystems
 * (`vscode-vfs:`, `vscode-remote:`) a web or remote workspace uses.
 */
function watchPattern(uri: vscode.Uri): vscode.RelativePattern | undefined {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  if (name.length === 0) return undefined;
  return new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name);
}

/**
 * The reader the extension installs, plus the store it feeds.
 *
 * One instance per extension host, created in `activate` and registered on the
 * context's subscriptions. Everything the pipeline sees is the plain
 * {@link ThemeFiles} on {@link WorkspaceThemeFiles.store}, which is what unit
 * tests build by hand with a fake reader.
 */
export class WorkspaceThemeFiles implements ThemeFileReader, vscode.Disposable {
  readonly store = new ThemeFiles();
  readonly #entries = new Map<string, Entry>();
  readonly #watchers = new Map<string, vscode.Disposable>();
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #subscriptions: vscode.Disposable[] = [];
  #disposed = false;

  constructor() {
    this.store.setReader(this);
    this.#subscriptions.push(
      // Trust can only be granted, never revoked in a running window, so this
      // fires exactly once and only ever unblocks reads.
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.#forgetAll();
      }),
    );
  }

  /** Fires when a load could now answer differently: a read landed, a file changed. */
  get onDidChange(): vscode.Event<void> {
    return this.#emitter.event;
  }

  /**
   * The synchronous half of the seam. Never awaits, never throws.
   *
   * @param uri - absolute, already resolved against the document
   */
  read(uri: string): ThemeFileRead {
    const known = this.#entries.get(uri);
    if (known !== undefined) return known;

    if (!vscode.workspace.isTrusted) {
      return this.#settle(uri, {
        status: 'error',
        message:
          'The workspace is not trusted, so theme files are not read. ' +
          'Run “Workspaces: Manage Workspace Trust” to load them.',
      });
    }
    if (uri.startsWith('http:') || uri.startsWith('https:')) {
      return this.#settle(uri, {
        status: 'error',
        message:
          'The extension reads theme files from the workspace, not over the network. ' +
          'Save the theme next to the document and point `theme:` at it.',
      });
    }

    let target: vscode.Uri;
    try {
      target = vscode.Uri.parse(uri, true);
    } catch (error) {
      return this.#settle(uri, { status: 'error', message: describeError(error) });
    }

    this.#entries.set(uri, { status: 'pending' });
    this.#start(uri, target);
    return { status: 'pending' };
  }

  /** Begin the read. Resolution and rejection both end in {@link #land}. */
  #start(uri: string, target: vscode.Uri): void {
    void Promise.resolve(vscode.workspace.fs.readFile(target)).then(
      (bytes) => {
        this.#land(uri, { status: 'ok', text: decode(bytes) });
      },
      (error: unknown) => {
        this.#land(uri, { status: 'error', message: describeError(error) });
      },
    );
    this.#watch(uri, target);
  }

  /** Record a read that finished after `read` had already answered `pending`. */
  #land(uri: string, entry: Entry): void {
    if (this.#disposed) return;
    this.#entries.set(uri, entry);
    this.store.invalidate(uri);
    this.#emitter.fire();
  }

  /** Answer now *and* remember, for a refusal that needs no I/O. */
  #settle(uri: string, entry: Entry): Entry {
    this.#entries.set(uri, entry);
    return entry;
  }

  /**
   * Watch one theme file, once.
   *
   * Non-recursive watchers outside the workspace folders are supported and
   * cheap, which matters: a shared `../../brand/theme.yaml` is the normal case
   * and would otherwise go stale until the window reloaded.
   */
  #watch(uri: string, target: vscode.Uri): void {
    if (this.#watchers.has(uri)) return;
    const pattern = watchPattern(target);
    if (pattern === undefined) return;

    let watcher: vscode.FileSystemWatcher;
    try {
      watcher = vscode.workspace.createFileSystemWatcher(pattern);
    } catch (error) {
      // A filesystem provider that cannot watch is not a failure to render; the
      // file was still read, it just will not live-update.
      log(`theme file watcher unavailable for ${uri}: ${describeError(error)}`);
      return;
    }
    // Forget rather than re-read: the next run asks again, and a file nobody
    // renders any more should not be re-read on every save.
    const changed = (): void => {
      if (this.#disposed) return;
      this.#entries.delete(uri);
      this.store.invalidate(uri);
      this.#emitter.fire();
    };
    this.#watchers.set(
      uri,
      vscode.Disposable.from(
        watcher.onDidChange(changed),
        watcher.onDidCreate(changed),
        watcher.onDidDelete(changed),
        watcher,
      ),
    );
  }

  /** Drop every cached read — used when trust is granted mid-session. */
  #forgetAll(): void {
    this.#entries.clear();
    this.store.invalidate();
    this.#emitter.fire();
  }

  dispose(): void {
    this.#disposed = true;
    this.store.setReader(undefined);
    for (const watcher of this.#watchers.values()) watcher.dispose();
    this.#watchers.clear();
    for (const item of this.#subscriptions) item.dispose();
    this.#subscriptions.length = 0;
    this.#entries.clear();
    this.#emitter.dispose();
  }
}

/**
 * The one store the commands reach for.
 *
 * A module-level singleton rather than another constructor argument threaded
 * through four `inputsFor` call sites: there is exactly one filesystem per
 * extension host, and the alternative was to widen the signature of every
 * command helper for a value none of them have an opinion about. Tests never
 * touch this — they pass their own {@link ThemeFiles} in `PipelineInputs`.
 */
let active: WorkspaceThemeFiles | undefined;

/** Install the host's store. Called once, by `activate`. */
export function setActiveThemeFiles(files: WorkspaceThemeFiles | undefined): void {
  active = files;
}

/** The host's theme-file cache, or `undefined` outside a running extension host. */
export function activeThemeFiles(): ThemeFiles | undefined {
  return active?.store;
}
