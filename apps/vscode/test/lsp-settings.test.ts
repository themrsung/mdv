/**
 * The settings that reach the language server (SPEC 29.4).
 *
 * The server runs in another process, so this module is the only thing standing
 * between a user's configuration and a server that silently disagrees with the
 * preview about what is valid. Two properties matter and neither is visible from
 * either end alone: that what is written comes back unchanged, and that what
 * cannot be read falls to the *safe* side rather than to whatever a partial
 * parse left behind.
 */

import { describe, expect, it } from 'vitest';

import { COMMANDS } from '../src/commands/ids.js';
import {
  DEFAULT_SERVER_SETTINGS,
  SETTINGS_FLAG,
  SETTINGS_PARAM,
  decodeServerSettings,
  featureSettings,
  serverArgv,
  serverQuery,
  serverSettings,
  settingsFromArgv,
  settingsFromQuery,
} from '../src/lsp/settings.js';
import type { ServerSettings } from '../src/lsp/settings.js';
import { DEFAULT_SETTINGS } from './fixtures.js';

/** A payload with every field away from its default, so a lost one shows. */
const LOADED: ServerSettings = {
  level: 3,
  strict: true,
  allowExternal: true,
  allowedOrigins: ['https://data.example.com'],
  attributeOrder: 'alphabetical',
};

describe('serverSettings', () => {
  it('carries the five settings the server can act on', () => {
    expect(serverSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SERVER_SETTINGS);
  });

  it('reads each one from its own section', () => {
    const payload = serverSettings({
      ...DEFAULT_SETTINGS,
      validate: { enable: true, level: 3, strict: true },
      format: { enable: true, attributeOrder: 'preserve' },
      security: { allowExternal: true, allowedOrigins: ['https://a.example'], trusted: true },
    });

    expect(payload).toEqual({
      level: 3,
      strict: true,
      allowExternal: true,
      allowedOrigins: ['https://a.example'],
      attributeOrder: 'preserve',
    });
  });

  it('leaves the client-only settings behind', () => {
    // `validate.enable`, `format.enable`, `codeLens.enable`, `preview.*` and
    // `export.*` change what the client *asks for*, not what the server answers.
    const payload = serverSettings({
      ...DEFAULT_SETTINGS,
      validate: { enable: false, level: 2, strict: false },
      format: { enable: false, attributeOrder: 'canonical' },
      codeLens: { enable: false },
      preview: { theme: 'dark', scrollSync: false, debounceMs: 900, openOnStartup: true },
    });

    expect(payload).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(Object.keys(payload).sort()).toEqual([
      'allowExternal',
      'allowedOrigins',
      'attributeOrder',
      'level',
      'strict',
    ]);
  });
});

describe('the argv round trip', () => {
  it('returns what it was given', () => {
    expect(settingsFromArgv(serverArgv(LOADED))).toEqual(LOADED);
    expect(settingsFromArgv(serverArgv(DEFAULT_SERVER_SETTINGS))).toEqual(DEFAULT_SERVER_SETTINGS);
  });

  it('writes the payload as one flag and one argument', () => {
    const argv = serverArgv(LOADED);

    expect(argv).toHaveLength(2);
    expect(argv[0]).toBe(SETTINGS_FLAG);
    expect(JSON.parse(argv[1] ?? '')).toEqual(LOADED);
  });

  it('finds the payload among the other arguments a host passes', () => {
    expect(settingsFromArgv(['--node-ipc', ...serverArgv(LOADED), '--clientProcessId=42'])).toEqual(
      LOADED,
    );
  });

  it('defaults when the flag is absent, last, or empty', () => {
    expect(settingsFromArgv([])).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(settingsFromArgv(['--stdio'])).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(settingsFromArgv([SETTINGS_FLAG])).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(settingsFromArgv([SETTINGS_FLAG, ''])).toEqual(DEFAULT_SERVER_SETTINGS);
  });
});

describe('the query round trip', () => {
  it('returns what it was given', () => {
    expect(settingsFromQuery(serverQuery(LOADED))).toEqual(LOADED);
  });

  it('survives being pasted onto a worker script URL', () => {
    // The extension host builds the worker's URL, so the payload has to come
    // back out of a real `?search` — quotes, braces, slashes and all.
    const url = new URL(`https://host.vscode-cdn.net/web/server.js?${serverQuery(LOADED)}`);

    expect(url.searchParams.get(SETTINGS_PARAM)).not.toBeNull();
    expect(settingsFromQuery(url.search)).toEqual(LOADED);
  });

  it('defaults when the parameter is missing or empty', () => {
    expect(settingsFromQuery('')).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(settingsFromQuery('?foo=bar')).toEqual(DEFAULT_SERVER_SETTINGS);
    expect(settingsFromQuery(`?${SETTINGS_PARAM}=`)).toEqual(DEFAULT_SERVER_SETTINGS);
  });
});

describe('decodeServerSettings', () => {
  it('never throws, whatever it is handed', () => {
    for (const text of ['', '{', 'null', '[]', '"nope"', '17', 'undefined', '{"level":']) {
      expect(() => decodeServerSettings(text)).not.toThrow();
      expect(decodeServerSettings(text)).toEqual(DEFAULT_SERVER_SETTINGS);
    }
    expect(decodeServerSettings(undefined)).toEqual(DEFAULT_SERVER_SETTINGS);
  });

  it('keeps the fields it understands and defaults the ones it does not', () => {
    const decoded = decodeServerSettings(
      JSON.stringify({ level: 3, strict: 'yes', attributeOrder: 'sideways', extra: 1 }),
    );

    expect(decoded).toEqual({ ...DEFAULT_SERVER_SETTINGS, level: 3 });
  });

  it('rejects a level outside SPEC 16.1', () => {
    for (const level of [0, 4, 2.5, '2', null]) {
      expect(decodeServerSettings(JSON.stringify({ level })).level).toBe(2);
    }
  });

  it('falls to the safe side of allowExternal', () => {
    // A malformed payload must not be able to *grant* network access
    // (SPEC 25.2): every non-`true` value has to read as off.
    for (const allowExternal of [undefined, null, 0, 1, 'true', {}, []]) {
      expect(decodeServerSettings(JSON.stringify({ allowExternal })).allowExternal).toBe(false);
    }
    expect(decodeServerSettings(JSON.stringify({ allowExternal: true })).allowExternal).toBe(true);
  });

  it('drops non-string origins rather than the whole list', () => {
    const decoded = decodeServerSettings(
      JSON.stringify({ allowedOrigins: ['https://a.example', 7, null, 'https://b.example'] }),
    );

    expect(decoded.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(decodeServerSettings(JSON.stringify({ allowedOrigins: 'https://a.example' }))).toEqual(
      DEFAULT_SERVER_SETTINGS,
    );
  });

  it('accepts each attribute order the manifest offers', () => {
    for (const attributeOrder of ['canonical', 'alphabetical', 'preserve'] as const) {
      expect(decodeServerSettings(JSON.stringify({ attributeOrder })).attributeOrder).toBe(
        attributeOrder,
      );
    }
  });
});

describe('featureSettings', () => {
  it('builds the same configuration the preview and the exporter use', () => {
    const features = featureSettings(LOADED);

    expect(features.config.level).toBe(3);
    expect(features.config.strict).toBe(true);
    expect(features.config.security).toEqual({
      allowExternal: true,
      allowedOrigins: ['https://data.example.com'],
    });
    // The built-ins have to be there, or the server would report every chart
    // type as unknown while the preview drew it (SPEC 29.4: same answers).
    expect(features.config.plugins?.[0]?.chartTypes?.length ?? 0).toBeGreaterThan(0);
    expect(features.config.plugins?.[0]?.themes?.length ?? 0).toBeGreaterThan(0);
  });

  it('omits `strict` rather than setting it false', () => {
    // `exactOptionalPropertyTypes` makes absent and `false` different values,
    // and SPEC 14.3's default is written against absent.
    expect('strict' in featureSettings(DEFAULT_SERVER_SETTINGS).config).toBe(false);
  });

  it('grants the fetch capability only when external data is allowed', () => {
    expect(featureSettings(DEFAULT_SERVER_SETTINGS).config.capabilities?.fetch).toBeUndefined();
    expect(typeof featureSettings(LOADED).config.capabilities?.fetch).toBe('function');
  });

  it('names the lens commands this extension registers', () => {
    // The ids `codelens.ts` registers in-process, so clicking a lens does the
    // same thing whichever side produced it.
    expect(featureSettings(LOADED).commands).toEqual({
      preview: COMMANDS.showPreviewToSide,
      exportPng: false,
      exportSvg: COMMANDS.exportBlock,
      showData: COMMANDS.showData,
    });
  });

  it('offers no PNG lens, because block PNG export is not implemented', () => {
    expect(featureSettings(LOADED).commands?.exportPng).toBe(false);
  });

  it('formats with the configured attribute order', () => {
    expect(featureSettings(LOADED).format?.()).toEqual({ attrOrder: 'alphabetical' });
    expect(featureSettings(DEFAULT_SERVER_SETTINGS).format?.()).toEqual({
      attrOrder: 'canonical',
    });
  });

  it('leaves the SPEC 29.4 validation debounce to @mdv/lsp', () => {
    // `mdv.preview.debounceMs` is the preview's delay, not the problem list's.
    expect(featureSettings(LOADED)).not.toHaveProperty('debounceMs');
  });
});
