/**
 * `mdv.*` → `MdvFeatureSettings`: what the language server of SPEC 29.4 is
 * started with, and how it survives the trip.
 *
 * The server runs in another process (or another worker), so it cannot read
 * `vscode.workspace.getConfiguration`. Everything it needs has to be carried
 * across as data — an argv element for the node host, a URL query parameter for
 * the browser one — and this module owns both ends of that: {@link serverArgv}
 * and {@link serverQuery} write it, {@link settingsFromArgv} and
 * {@link settingsFromQuery} read it back, and {@link featureSettings} turns the
 * result into the feature set. One module, so the two ends cannot drift.
 *
 * **What crosses, and what does not.** Only settings that change a *server*
 * answer are carried. The rest are client-side and stay here, because a payload
 * field the server cannot honour is a lie that reads like a promise:
 *
 * | Setting | Where it lives |
 * |---|---|
 * | `mdv.validate.level`, `.strict` | carried — the conformance level a block is judged at |
 * | `mdv.security.allowExternal`, `.allowedOrigins` | carried — whether a remote `src:` resolves |
 * | `mdv.format.attributeOrder` | carried — the formatter's attribute order |
 * | `mdv.validate.enable` | client: it stops asking, and clears what it published |
 * | `mdv.format.enable` | client: it withholds the formatting request |
 * | `mdv.codeLens.enable` | client: it withholds the code lens request |
 * | `mdv.preview.*`, `mdv.export.*`, `mdv.completion.columnNames` | client only — the server neither previews nor exports |
 * | `mdv.trace.server` | client: LSP's own `trace` on `initialize` |
 *
 * The validation debounce is **not** carried either: `mdv.preview.debounceMs` is
 * the preview's re-render delay, and SPEC 29.4's is a different 300 ms that
 * `@mdv/lsp` already defaults to. Reusing one for the other would tie the
 * problem list's latency to a preview setting nobody meant to point at it.
 *
 * The payload is plain JSON and readable in a process list. Nothing in it is
 * secret — it is the same workspace configuration the repository can already
 * see — but it *is* security-relevant: `allowExternal` arrives this way, so a
 * server started without a payload falls back to the safe side of every switch
 * rather than to whatever a partial parse happened to leave behind.
 */

import type { CodeLensCommands, MdvFeatureSettings } from '@mdv/lsp';

import { COMMANDS } from '../commands/ids.js';
import { mdvConfig } from '../pipeline/config.js';
import type { AttributeOrderSetting, MdvSettings } from '../settings.js';

/** The argv flag the node server reads its settings from. */
export const SETTINGS_FLAG = '--mdv-settings';

/** The query parameter the worker server reads its settings from. */
export const SETTINGS_PARAM = 'settings';

/**
 * Everything the server is told about the host's configuration.
 *
 * Deliberately flat and JSON-shaped: it is written by `JSON.stringify` and read
 * back by a parser that trusts none of it.
 */
export interface ServerSettings {
  /** SPEC 16.1 conformance level; `mdv.validate.level`. */
  readonly level: 1 | 2 | 3;
  /** SPEC 14.3: promotes warnings to errors. `mdv.validate.strict`. */
  readonly strict: boolean;
  /** `mdv.security.allowExternal`. */
  readonly allowExternal: boolean;
  /** `mdv.security.allowedOrigins`. */
  readonly allowedOrigins: readonly string[];
  /** `mdv.format.attributeOrder`. */
  readonly attributeOrder: AttributeOrderSetting;
}

/**
 * What a server assumes when it was told nothing.
 *
 * The safe side of both security switches, and the defaults `package.json`
 * declares for the rest — so a server started by hand behaves like a server
 * started by a host whose settings are all untouched.
 */
export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  level: 2,
  strict: false,
  allowExternal: false,
  allowedOrigins: [],
  attributeOrder: 'canonical',
};

/** The slice of `mdv.*` the server is given. */
export function serverSettings(settings: MdvSettings): ServerSettings {
  return {
    level: settings.validate.level,
    strict: settings.validate.strict,
    allowExternal: settings.security.allowExternal,
    allowedOrigins: settings.security.allowedOrigins,
    attributeOrder: settings.format.attributeOrder,
  };
}

/**
 * The lens commands the server should name.
 *
 * `@mdv/lsp` has no opinion about a host's command ids, so it is told this
 * extension's — the same ones `codelens.ts` uses in-process, which is what
 * makes the switch to the server invisible to a user who clicks one.
 *
 * `exportPng: false` for the reason the in-process row omits it: PNG block
 * export is not implemented in this build, and a lens that only ever explains
 * itself is worse than no lens.
 */
const LENS_COMMANDS: CodeLensCommands = {
  preview: COMMANDS.showPreviewToSide,
  exportPng: false,
  exportSvg: COMMANDS.exportBlock,
  showData: COMMANDS.showData,
};

/** The feature set a server built from `payload` runs. */
export function featureSettings(payload: ServerSettings): MdvFeatureSettings {
  return {
    config: mdvConfig(payload),
    commands: LENS_COMMANDS,
    format: () => ({ attrOrder: payload.attributeOrder }),
  };
}

/** The payload, as the single argv element `SETTINGS_FLAG` introduces. */
export function serverArgv(payload: ServerSettings): readonly string[] {
  return [SETTINGS_FLAG, JSON.stringify(payload)];
}

/** The payload, as a query string for a worker's script URL. */
export function serverQuery(payload: ServerSettings): string {
  return new URLSearchParams({ [SETTINGS_PARAM]: JSON.stringify(payload) }).toString();
}

/** Read the payload out of a node server's arguments. */
export function settingsFromArgv(argv: readonly string[]): ServerSettings {
  const at = argv.indexOf(SETTINGS_FLAG);
  return decodeServerSettings(at === -1 ? undefined : argv[at + 1]);
}

/** Read the payload out of a worker script URL's `?search`. */
export function settingsFromQuery(search: string): ServerSettings {
  return decodeServerSettings(new URLSearchParams(search).get(SETTINGS_PARAM) ?? undefined);
}

function isLevel(value: unknown): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_SERVER_SETTINGS.allowedOrigins;
  return Object.freeze(value.filter((item): item is string => typeof item === 'string'));
}

function attributeOrder(value: unknown): AttributeOrderSetting {
  return value === 'alphabetical' || value === 'preserve' || value === 'canonical'
    ? value
    : DEFAULT_SERVER_SETTINGS.attributeOrder;
}

/**
 * Parse a payload, field by field, falling back per field.
 *
 * Never throws. A server that refused to start because its arguments were
 * malformed would take the whole language experience down with it, and the host
 * would have nowhere to show why; one that starts with defaults reports
 * something, and the something is on the safe side of `allowExternal`.
 */
export function decodeServerSettings(text: string | undefined): ServerSettings {
  if (text === undefined || text === '') return DEFAULT_SERVER_SETTINGS;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_SERVER_SETTINGS;
  }
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SERVER_SETTINGS;

  const seen = raw as Partial<Record<keyof ServerSettings, unknown>>;
  return {
    level: isLevel(seen.level) ? seen.level : DEFAULT_SERVER_SETTINGS.level,
    strict: bool(seen.strict, DEFAULT_SERVER_SETTINGS.strict),
    allowExternal: bool(seen.allowExternal, DEFAULT_SERVER_SETTINGS.allowExternal),
    allowedOrigins: strings(seen.allowedOrigins),
    attributeOrder: attributeOrder(seen.attributeOrder),
  };
}
