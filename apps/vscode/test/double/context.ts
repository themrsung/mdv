/**
 * The `ExtensionContext` the host hands to `activate`.
 *
 * This file imports `vscode` exactly the way the extension does: the types
 * come from `@types/vscode`, and vitest's alias makes the runtime value the
 * double in `./vscode.ts`. So everything here is checked against the real API
 * the extension is compiled against - if the double drifts out of shape, this
 * file stops compiling, which is the point of typing it rather than casting
 * it wholesale.
 */

import * as vscode from 'vscode';

/**
 * A context member the extension has never used.
 *
 * Typed as `T` so the enclosing object genuinely is an `ExtensionContext`,
 * but it throws the moment anything reads it: "unused" is allowed to become
 * "used", quietly becoming "wrong" is not.
 */
function unspecified<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`vscode double: ${name}.${String(property)} is not specified`);
      },
    },
  ) as T;
}

class MemoryMemento implements vscode.Memento {
  readonly #store = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.#store.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.#store.has(key) ? (this.#store.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.#store.delete(key);
    else this.#store.set(key, value);
    return Promise.resolve();
  }
}

class SyncedMemento extends MemoryMemento {
  readonly synced: string[] = [];

  setKeysForSync(keys: readonly string[]): void {
    this.synced.splice(0, this.synced.length, ...keys);
  }
}

class MemorySecrets implements vscode.SecretStorage {
  readonly #store = new Map<string, string>();

  readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = () => ({
    dispose: () => {},
  });

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.#store.keys()]);
  }

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.#store.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.#store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.#store.delete(key);
    return Promise.resolve();
  }
}

/** What a test can vary about the installed extension. */
export interface FakeContextOptions {
  /** Where the extension is installed. Defaults to `/ext`. */
  readonly extensionPath?: string;
  readonly extensionMode?: vscode.ExtensionMode;
}

/** Build the `ExtensionContext` an activation is given. */
export function fakeExtensionContext(options: FakeContextOptions = {}): vscode.ExtensionContext {
  const extensionPath = options.extensionPath ?? '/ext';
  const extensionUri = vscode.Uri.file(extensionPath);
  const storage = vscode.Uri.file(`${extensionPath}/.storage`);

  return {
    subscriptions: [],
    workspaceState: new MemoryMemento(),
    globalState: new SyncedMemento(),
    secrets: new MemorySecrets(),
    extensionUri,
    extensionPath,
    environmentVariableCollection: unspecified('environmentVariableCollection'),
    asAbsolutePath: (relativePath: string) => `${extensionPath}/${relativePath}`,
    storageUri: storage,
    storagePath: storage.fsPath,
    globalStorageUri: storage,
    globalStoragePath: storage.fsPath,
    logUri: storage,
    logPath: storage.fsPath,
    extensionMode: options.extensionMode ?? vscode.ExtensionMode.Test,
    extension: unspecified('extension'),
    languageModelAccessInformation: unspecified('languageModelAccessInformation'),
  };
}

/** Dispose everything an activation registered, the way shutdown does. */
export function disposeAll(context: vscode.ExtensionContext): void {
  for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
}
