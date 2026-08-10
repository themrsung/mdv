/**
 * Loading a block's `theme:` when it names a file rather than a built-in
 * (SPEC 11.6).
 *
 * ## Why this is not just `await readFile`
 *
 * Layout is synchronous. `#renderBlock` picks a theme in the middle of a
 * `layoutBlock` call and cannot suspend, so the read cannot happen there. The
 * seam is therefore a *synchronous* {@link ThemeFileReader} over an
 * asynchronous host: it answers `pending` for a URI it has not read yet, starts
 * the read, and tells the store when the text lands. The store bumps
 * {@link ThemeFiles.revision}, the revision is part of every block's cache key,
 * and the next run — which the host schedules on the same signal — renders with
 * the real theme. A block shows the preview theme for one frame instead of
 * blocking the extension host for a disk seek.
 *
 * ## Why the cache lives here and not per document
 *
 * A theme file is shared: ten documents in a workspace naming
 * `./corporate.yaml` are one file, one parse and one palette validation. Keying
 * by `uri + scheme` also means the light and dark resolutions of the same file
 * coexist, because `extends: default` resolves against a different base in each
 * (SPEC 11.6) — a single-entry memo would thrash between two open previews.
 *
 * ## What this does not do
 *
 * It does not fetch. An `http(s):` theme is external data and stays behind
 * `mdv.security.allowExternal` (`MDV4002`); even with that on, the reader the
 * extension installs is `vscode.workspace.fs`, which speaks to the workspace,
 * not the network. Relative `src:` data files are a *separate* gap — the
 * pipeline hands `@mdv/core` no `readFile` capability at all (see
 * `capabilities.ts`) — and nothing here changes that.
 */

import type { ColorScheme, Theme } from '@mdv/core';
import { themeFileFormat, themeFromText, type ThemeFileFormat } from '@mdv/themes';

/**
 * What a reader can say about one URI *right now*, without awaiting.
 *
 * `pending` is not an error and must not produce a diagnostic: it means "ask
 * again after the change event", and a diagnostic would flash in the Problems
 * panel on every first paint.
 */
export type ThemeFileRead =
  | { readonly status: 'ok'; readonly text: string }
  | { readonly status: 'pending' }
  | { readonly status: 'error'; readonly message: string };

/**
 * The host's synchronous view of the filesystem.
 *
 * The extension implements this over `vscode.workspace.fs` plus a cache and a
 * file watcher (`../themefiles.ts`); tests implement it over a `Map`.
 */
export interface ThemeFileReader {
  /** @param uri - absolute, already resolved against the document */
  read(uri: string): ThemeFileRead;
}

/** A diagnostic a theme-file load wants the pipeline to emit, Appendix C code and all. */
export interface ThemeFileProblem {
  /** `MDV1502` unloadable/unknown, `MDV3080` bad palette, `MDV4002` external and disabled. */
  readonly code: 'MDV1502' | 'MDV3080' | 'MDV4002';
  readonly message: string;
  readonly detail: string | undefined;
}

/** The outcome of resolving one `theme:` value against the filesystem. */
export interface LoadedTheme {
  /** The loaded theme, or `undefined` when the caller should keep its fallback. */
  readonly theme: Theme | undefined;
  readonly problems: readonly ThemeFileProblem[];
  /** `true` while the read is in flight: fallback now, real theme next run. */
  readonly pending: boolean;
  /**
   * Cache discriminator. Two loads with the same key produced the same theme
   * and the same problems, so a block memoised under it is still valid.
   */
  readonly key: string;
}

/**
 * Turn a `theme:` value into an absolute URI, resolved against the document.
 *
 * `new URL` does the work, which gets `./x.yaml`, `../shared/x.json`, a bare
 * `x.yml` and an absolute `file:` URI right for free. The one thing it gets
 * *wrong* is a Windows path: `C:\themes\brand.json` parses as the scheme `c:`
 * with an opaque path, so drive letters are converted to a `file:` URI first.
 *
 * @returns `undefined` when the value cannot be a URI at all
 */
export function resolveThemeUri(setting: string, baseUri: string): string | undefined {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(setting);
  const target =
    drive?.[1] !== undefined && drive[2] !== undefined
      ? `file:///${drive[1]}:/${drive[2].replace(/\\/g, '/')}`
      : setting.replace(/\\/g, '/');
  try {
    return new URL(target, baseUri).toString();
  } catch {
    return undefined;
  }
}

/** `true` for a URI this extension must not read without `mdv.security.allowExternal`. */
function isExternal(uri: string): boolean {
  return uri.startsWith('http:') || uri.startsWith('https:');
}

/** Recognised theme-file extensions, for the message that lists them. */
const EXTENSIONS = '.json, .jsonc, .yaml, .yml';

const BUILTINS = 'default, dark, high-contrast, print';

function unloadable(message: string, detail: string, key: string): LoadedTheme {
  return {
    theme: undefined,
    problems: [{ code: 'MDV1502', message, detail }],
    pending: false,
    key,
  };
}

/**
 * The workspace's theme files: read once, parsed once, shared by every document.
 *
 * One instance lives in the extension host (see `../themefiles.ts`). Unit tests
 * make their own with a fake reader, which is why the reader is a constructor
 * argument rather than something this module reaches for.
 */
export class ThemeFiles {
  #reader: ThemeFileReader | undefined;
  readonly #cache = new Map<string, LoadedTheme>();
  #revision = 0;

  constructor(reader?: ThemeFileReader) {
    this.#reader = reader;
  }

  /**
   * Changes whenever a load could now answer differently — a file changed, a
   * pending read landed, the reader was swapped. Fold it into a render cache
   * key and the memo invalidates itself.
   */
  get revision(): number {
    return this.#revision;
  }

  /** Install (or remove) the host's reader. Drops everything read through the old one. */
  setReader(reader: ThemeFileReader | undefined): void {
    if (this.#reader === reader) return;
    this.#reader = reader;
    this.invalidate();
  }

  /** Forget one URI's parse, or all of them. Always bumps {@link revision}. */
  invalidate(uri?: string): void {
    if (uri === undefined) {
      this.#cache.clear();
    } else {
      // Every scheme's resolution of this file, since the key carries the scheme.
      for (const key of [...this.#cache.keys()]) {
        if (key.slice(0, key.indexOf('\u0000')) === uri) this.#cache.delete(key);
      }
    }
    this.#revision += 1;
  }

  /**
   * Resolve one `theme:` value that is not a built-in name.
   *
   * Never throws and never rejects: an author's theme file is content, so every
   * failure degrades to `theme: undefined` plus problems the caller reports
   * against the block (SPEC 14.1, SPEC 15.2).
   *
   * @param setting - the raw `theme:` attribute value
   * @param baseUri - the document's URI, for a relative path
   * @param scheme - the scheme in force, for the base an `extends:` resolves against
   * @param allowExternal - `mdv.security.allowExternal`
   */
  load(setting: string, baseUri: string, scheme: ColorScheme, allowExternal: boolean): LoadedTheme {
    const format = themeFileFormat(setting);
    if (format === undefined) {
      return unloadable(
        `Theme ${JSON.stringify(setting)} is not a built-in and is not a theme file`,
        `Use a built-in (${BUILTINS}) or a path ending in ${EXTENSIONS} (SPEC 11.6).`,
        `bad-ext\u0000${setting}`,
      );
    }

    const uri = resolveThemeUri(setting, baseUri);
    if (uri === undefined) {
      return unloadable(
        `Theme file ${JSON.stringify(setting)} is not a usable path`,
        'It could not be resolved against the document, so there is nothing to read.',
        `bad-uri\u0000${setting}`,
      );
    }

    if (isExternal(uri) && !allowExternal) {
      return {
        theme: undefined,
        problems: [
          {
            code: 'MDV4002',
            message: `Theme file ${JSON.stringify(setting)} is external data and external data is disabled`,
            detail:
              'Turn on `mdv.security.allowExternal` to let this document load over the network.',
          },
        ],
        pending: false,
        key: `blocked\u0000${uri}`,
      };
    }

    const reader = this.#reader;
    if (reader === undefined) {
      return unloadable(
        `Theme ${JSON.stringify(setting)} is not a built-in and cannot be loaded here`,
        `Only the built-in themes (${BUILTINS}) resolve without the filesystem capability.`,
        `no-reader\u0000${setting}`,
      );
    }

    const cacheKey = `${uri}\u0000${scheme}`;
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const read = reader.read(uri);
    if (read.status === 'pending') {
      // Deliberately not cached: the whole point is to ask again next run.
      return { theme: undefined, problems: [], pending: true, key: `pending\u0000${uri}` };
    }

    const loaded =
      read.status === 'error'
        ? unloadable(
            `Theme file ${JSON.stringify(setting)} could not be read`,
            read.message,
            `${cacheKey}\u0000${this.#revision}`,
          )
        : this.#parse(setting, read.text, scheme, format, cacheKey);
    this.#cache.set(cacheKey, loaded);
    return loaded;
  }

  /** Shape, resolve and validate the text `themeFromText` was handed (SPEC 11.6). */
  #parse(
    setting: string,
    text: string,
    scheme: ColorScheme,
    format: ThemeFileFormat,
    cacheKey: string,
  ): LoadedTheme {
    const result = themeFromText(text, scheme, format);
    const problems: ThemeFileProblem[] = [];

    if (result.errors.length > 0) {
      problems.push({
        code: 'MDV1502',
        message: `Theme file ${JSON.stringify(setting)} is not a usable theme`,
        detail: result.errors.join(' '),
      });
    }
    // SPEC 11.2 rule 4: a custom categorical palette MUST be validated, and its
    // failures MUST be reported as `MDV3080` — accepting one silently is exactly
    // what specifying a palette was supposed to prevent.
    for (const warning of result.warnings) {
      problems.push({
        code: 'MDV3080',
        message: `Theme file ${JSON.stringify(setting)}: ${warning}`,
        detail: undefined,
      });
    }

    return {
      theme: result.theme,
      problems,
      pending: false,
      key: `${cacheKey}\u0000${this.#revision}`,
    };
  }
}
