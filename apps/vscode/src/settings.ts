/**
 * The `mdv.*` configuration of SPEC 29.6, read once into a typed snapshot.
 *
 * Every setting declared in `package.json` is read here and honoured somewhere
 * downstream; a setting that only existed in the manifest would be a lie. The
 * map from setting to consumer is:
 *
 * | Setting | Honoured by |
 * |---|---|
 * | `preview.theme` | `preview/manager.ts` — chooses the MDV theme, `auto` follows `window.activeColorTheme` |
 * | `preview.scrollSync` | `preview/panel.ts` — installs (or not) both scroll listeners |
 * | `preview.debounceMs` | `preview/panel.ts` — the edit→re-render delay |
 * | `preview.openOnStartup` | `extension.ts` — opens the preview for an `.mdv` editor at activation |
 * | `validate.enable` | `diagnostics/inprocess.ts` — clears the collection when off |
 * | `validate.level` | pipeline — the conformance level a block is judged at |
 * | `validate.strict` | pipeline — promotes warnings to errors (SPEC 14.3) |
 * | `format.enable` | `format.ts` — registers or withholds the formatting provider |
 * | `format.attributeOrder` | `format.ts` — passed to `toMarkdown` |
 * | `security.allowExternal` | pipeline — enables `src:` fetching |
 * | `security.allowedOrigins` | pipeline — the fetch allowlist |
 * | `export.pdf.pageSize` | `commands/exports.ts` |
 * | `export.defaultDirectory` | `commands/exports.ts` |
 * | `completion.columnNames` | `completion.ts` — offers data-aware column completions |
 * | `codeLens.enable` | `codelens.ts` |
 * | `trace.server` | `log.ts` consumers — verbosity of the diagnostics engine log |
 *
 * **Security posture (SPEC 29.6).** `mdv.security.*` MUST NOT be settable from a
 * workspace `.vscode/settings.json` without the workspace-trust prompt: a
 * repository must not be able to turn on network access for its own documents.
 * Two mechanisms enforce that, and both are needed:
 *
 * 1. `capabilities.untrustedWorkspaces.restrictedConfigurations` in
 *    `package.json`, which makes VS Code itself ignore the workspace value.
 * 2. {@link readSettings}, which re-derives the security slice from
 *    `inspect()` and takes only the user/machine values whenever the workspace
 *    is untrusted — belt and braces, and it keeps the rule true even if the
 *    manifest is edited.
 */

import * as vscode from 'vscode';

/** SPEC 29.6 `mdv.preview.theme`. */
export type PreviewThemeSetting = 'auto' | 'light' | 'dark' | 'high-contrast';

/** SPEC 29.6 `mdv.format.attributeOrder`. */
export type AttributeOrderSetting = 'canonical' | 'alphabetical' | 'preserve';

/** SPEC 29.6 `mdv.trace.server`. */
export type TraceSetting = 'off' | 'messages' | 'verbose';

/** An immutable snapshot of `mdv.*`. Re-read on every configuration change. */
export interface MdvSettings {
  readonly preview: {
    readonly theme: PreviewThemeSetting;
    readonly scrollSync: boolean;
    readonly debounceMs: number;
    readonly openOnStartup: boolean;
  };
  readonly validate: {
    readonly enable: boolean;
    /** SPEC 16.1 conformance level. */
    readonly level: 1 | 2 | 3;
    readonly strict: boolean;
  };
  readonly format: {
    readonly enable: boolean;
    readonly attributeOrder: AttributeOrderSetting;
  };
  readonly security: {
    readonly allowExternal: boolean;
    readonly allowedOrigins: readonly string[];
    /**
     * `true` when the values above came from a trusted scope. An untrusted
     * workspace can still *ask*; the preview shows the banner and the answer is
     * a user action, never a document's or a repository's.
     */
    readonly trusted: boolean;
  };
  readonly exportSettings: {
    readonly pdfPageSize: string;
    /** Attach the `.mdv` source to an exported PDF (SPEC 28.9). */
    readonly pdfEmbedSource: boolean;
    readonly defaultDirectory: string;
  };
  readonly completion: { readonly columnNames: boolean };
  readonly codeLens: { readonly enable: boolean };
  readonly trace: TraceSetting;
}

const SECTION = 'mdv';

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A finite, non-negative integer; anything else falls back. */
function count(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) if (typeof item === 'string' && item.length > 0) out.push(item);
  return Object.freeze(out);
}

/**
 * Read a security value from **trusted scopes only** when the workspace is not
 * trusted.
 *
 * `inspect()` reports the value each scope contributed. In an untrusted
 * workspace we deliberately ignore `workspaceValue` and
 * `workspaceFolderValue` — which is exactly the repository-authored
 * `.vscode/settings.json` the spec is protecting against — and fall back
 * through the user and machine scopes to the manifest default.
 */
function trustedValue<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
  trusted: boolean,
): T | undefined {
  if (trusted) return config.get<T>(key);
  const seen = config.inspect<T>(key);
  if (seen === undefined) return undefined;
  // Deliberately skips workspaceValue and workspaceFolderValue.
  return seen.globalValue ?? seen.defaultValue;
}

/** Read the current configuration for `scope` (a document, usually). */
export function readSettings(scope?: vscode.ConfigurationScope): MdvSettings {
  const config = vscode.workspace.getConfiguration(SECTION, scope);
  const trusted = vscode.workspace.isTrusted;

  return Object.freeze({
    preview: Object.freeze({
      theme: oneOf(
        config.get('preview.theme'),
        ['auto', 'light', 'dark', 'high-contrast'] as const,
        'auto',
      ),
      scrollSync: bool(config.get('preview.scrollSync'), true),
      // Floored at 16 ms (one frame): a zero debounce would re-render on every
      // keystroke and make the preview the slowest thing in the editor.
      debounceMs: count(config.get('preview.debounceMs'), 150, 16, 5000),
      openOnStartup: bool(config.get('preview.openOnStartup'), false),
    }),
    validate: Object.freeze({
      enable: bool(config.get('validate.enable'), true),
      level: count(config.get('validate.level'), 2, 1, 3) as 1 | 2 | 3,
      strict: bool(config.get('validate.strict'), false),
    }),
    format: Object.freeze({
      enable: bool(config.get('format.enable'), true),
      attributeOrder: oneOf(
        config.get('format.attributeOrder'),
        ['canonical', 'alphabetical', 'preserve'] as const,
        'canonical',
      ),
    }),
    security: Object.freeze({
      allowExternal: bool(trustedValue<boolean>(config, 'security.allowExternal', trusted), false),
      allowedOrigins: stringList(
        trustedValue<readonly string[]>(config, 'security.allowedOrigins', trusted),
      ),
      trusted,
    }),
    exportSettings: Object.freeze({
      pdfPageSize: oneOf(
        config.get('export.pdf.pageSize'),
        ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid'] as const,
        'A4',
      ),
      pdfEmbedSource: bool(config.get('export.pdf.embedSource'), true),
      defaultDirectory:
        typeof config.get('export.defaultDirectory') === 'string'
          ? (config.get<string>('export.defaultDirectory') ?? '')
          : '',
    }),
    completion: Object.freeze({ columnNames: bool(config.get('completion.columnNames'), true) }),
    codeLens: Object.freeze({ enable: bool(config.get('codeLens.enable'), true) }),
    trace: oneOf(config.get('trace.server'), ['off', 'messages', 'verbose'] as const, 'off'),
  });
}

/**
 * A live view of the settings that re-reads on change and on trust grant.
 *
 * One instance is created in `activate` and shared, so a change is read once
 * rather than once per consumer, and every consumer sees the same snapshot.
 */
export class SettingsStore implements vscode.Disposable {
  #current: MdvSettings;
  readonly #emitter = new vscode.EventEmitter<MdvSettings>();
  readonly #subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.#current = readSettings();
    this.#subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(SECTION)) return;
        this.#reload();
      }),
      // Granting trust changes what `mdv.security.*` is allowed to say.
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.#reload();
      }),
    );
  }

  get current(): MdvSettings {
    return this.#current;
  }

  /** Fires with the new snapshot whenever any `mdv.*` value changes. */
  get onDidChange(): vscode.Event<MdvSettings> {
    return this.#emitter.event;
  }

  #reload(): void {
    this.#current = readSettings();
    this.#emitter.fire(this.#current);
  }

  dispose(): void {
    for (const item of this.#subscriptions) item.dispose();
    this.#subscriptions.length = 0;
    this.#emitter.dispose();
  }
}
