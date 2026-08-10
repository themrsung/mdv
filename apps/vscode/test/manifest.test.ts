/**
 * The manifest and the static assets (SPEC 29.2).
 *
 * A `package.json` that names a command no menu can invoke, a grammar that
 * includes a repository rule nobody defined, or a snippet that expands into a
 * document the parser rejects are all *installation-time* failures: they cannot
 * be caught by compiling, and in a VS Code host they fail quietly. So they are
 * checked here, against the files on disk.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parse } from '@mdv/parser';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readJson(relative: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, relative), 'utf8')) as Record<string, unknown>;
}

function exists(relative: string): boolean {
  try {
    readFileSync(join(root, relative));
    return true;
  } catch {
    return false;
  }
}

/** How many `mdvBlock` nodes a parsed document contains, at any depth. */
function countBlocks(node: unknown): number {
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as { type?: unknown; children?: unknown };
  const self = record.type === 'mdvBlock' ? 1 : 0;
  if (!Array.isArray(record.children)) return self;
  return record.children.reduce<number>((total, child) => total + countBlocks(child), self);
}

interface Manifest {
  main: string;
  browser: string;
  activationEvents: string[];
  capabilities: {
    untrustedWorkspaces: { supported: string; restrictedConfigurations: string[] };
  };
  contributes: {
    languages: {
      id: string;
      extensions?: string[];
      configuration?: string;
      icon?: Record<string, string>;
    }[];
    grammars: { language?: string; scopeName: string; path: string; injectTo?: string[] }[];
    snippets: { language: string; path: string }[];
    customEditors: { viewType: string; selector: { filenamePattern: string }[] }[];
    commands: { command: string; title: string; category?: string }[];
    keybindings: { command: string; key: string; mac?: string; when?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    configuration: {
      properties: Record<
        string,
        { type?: string | string[]; default?: unknown; enum?: string[]; scope?: string }
      >;
    };
  };
}

const manifest = readJson('package.json') as unknown as Manifest;
const contributes = manifest.contributes;

/** The settings SPEC 29.6 lists, spelled as the manifest must spell them. */
const SPEC_SETTINGS = [
  'mdv.preview.theme',
  'mdv.preview.scrollSync',
  'mdv.preview.debounceMs',
  'mdv.preview.openOnStartup',
  'mdv.validate.enable',
  'mdv.validate.level',
  'mdv.validate.strict',
  'mdv.format.enable',
  'mdv.format.attributeOrder',
  'mdv.security.allowExternal',
  'mdv.security.allowedOrigins',
  'mdv.export.pdf.pageSize',
  'mdv.export.pdf.embedSource',
  'mdv.export.defaultDirectory',
  'mdv.completion.columnNames',
  'mdv.codeLens.enable',
  'mdv.trace.server',
] as const;

describe('package.json: activation and entry points', () => {
  it('activates on .mdv, on markdown and on the reader', () => {
    expect(manifest.activationEvents).toEqual([
      'onLanguage:mdv',
      'onLanguage:markdown',
      'onCustomEditor:mdv.reader',
    ]);
    // No `*`: SPEC 29.8 budgets activation, and an unconditional activation
    // spends it on every window.
    expect(manifest.activationEvents).not.toContain('*');
  });

  it('points at the bundles esbuild produces', () => {
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.browser).toBe('./dist/web/extension.js');
  });

  it('restricts exactly the two settings that can reach the network', () => {
    const { supported, restrictedConfigurations } = manifest.capabilities.untrustedWorkspaces;
    expect(supported).toBe('limited');
    expect([...restrictedConfigurations].sort()).toEqual([
      'mdv.security.allowExternal',
      'mdv.security.allowedOrigins',
    ]);
  });
});

describe('package.json: commands and menus', () => {
  const declared = new Set(contributes.commands.map((c) => c.command));

  it('declares every command under the mdv namespace with a category', () => {
    for (const command of contributes.commands) {
      expect(command.command.startsWith('mdv.')).toBe(true);
      expect(command.category).toBe('MDV');
      expect(command.title.length).toBeGreaterThan(0);
    }
    expect(declared.size).toBe(contributes.commands.length);
  });

  it('never references a command it did not declare', () => {
    for (const [menu, entries] of Object.entries(contributes.menus)) {
      for (const entry of entries) {
        expect(declared, `${menu} → ${entry.command}`).toContain(entry.command);
      }
    }
    for (const binding of contributes.keybindings) {
      expect(declared).toContain(binding.command);
    }
  });

  it('guards every menu entry with a `when`', () => {
    for (const entries of Object.values(contributes.menus)) {
      for (const entry of entries) {
        expect(entry.when ?? '').not.toBe('');
        expect(entry.when).toContain('editorLangId');
      }
    }
  });

  it('hides the exports that need a Node host behind the host context key', () => {
    const palette = contributes.menus['commandPalette'] ?? [];
    // Only PNG is left: it needs a canvas backend (SPEC 23.2), which is the one
    // export in this tree that cannot run in a browser host.
    for (const id of ['mdv.export.png']) {
      const entry = palette.find((e) => e.command === id);
      expect(entry?.when).toContain('mdv.hostHasNode');
    }
    // …and the ones that draw with `@mdv/*` alone are not. PDF belongs here now
    // that `@mdv/render-pdf` writes the bytes itself (SPEC 28.1) — no headless
    // browser, no `node:`, so it works in `vscode.dev` like the rest.
    for (const id of ['mdv.export.svg', 'mdv.export.html', 'mdv.export.pdf']) {
      expect(palette.find((e) => e.command === id)?.when).not.toContain('hostHasNode');
    }
  });

  it('gives both preview keybindings a mac chord and an editor guard', () => {
    for (const binding of contributes.keybindings) {
      expect(binding.mac ?? '').toMatch(/^cmd\+/);
      expect(binding.when).toBe('editorLangId == mdv');
    }
  });
});

describe('package.json: configuration', () => {
  const properties = contributes.configuration.properties;

  it('declares every setting SPEC 29.6 lists, and no others', () => {
    expect(Object.keys(properties).sort()).toEqual([...SPEC_SETTINGS].sort());
  });

  it('gives every setting a default of its declared type', () => {
    for (const [key, schema] of Object.entries(properties)) {
      expect(schema.default, key).toBeDefined();
      const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
      if (type === 'boolean') expect(typeof schema.default).toBe('boolean');
      if (type === 'number') expect(typeof schema.default).toBe('number');
      if (type === 'string') expect(typeof schema.default).toBe('string');
      if (type === 'array') expect(Array.isArray(schema.default)).toBe(true);
      if (schema.enum !== undefined) expect(schema.enum).toContain(schema.default);
    }
  });

  it('defaults to the safe side for the two security settings', () => {
    expect(properties['mdv.security.allowExternal']?.default).toBe(false);
    expect(properties['mdv.security.allowedOrigins']?.default).toEqual([]);
    // `machine-overridable`, so a repository cannot set them for the reader.
    expect(properties['mdv.security.allowExternal']?.scope).toBe('machine-overridable');
    expect(properties['mdv.security.allowedOrigins']?.scope).toBe('machine-overridable');
  });
});

describe('package.json: static assets', () => {
  it('ships every file it references', () => {
    for (const language of contributes.languages) {
      if (language.configuration !== undefined) expect(exists(language.configuration)).toBe(true);
      for (const icon of Object.values(language.icon ?? {})) expect(exists(icon)).toBe(true);
    }
    for (const grammar of contributes.grammars) expect(exists(grammar.path)).toBe(true);
    for (const snippet of contributes.snippets) expect(exists(snippet.path)).toBe(true);
  });

  it('owns the .mdv extension and offers the reader for it', () => {
    const mdv = contributes.languages.find((l) => l.id === 'mdv');
    expect(mdv?.extensions).toContain('.mdv');
    expect(contributes.customEditors[0]?.selector[0]?.filenamePattern).toBe('*.mdv');
  });

  it('draws its file icons without fetching anything', () => {
    for (const icon of ['icons/mdv-light.svg', 'icons/mdv-dark.svg']) {
      const svg = readFileSync(join(root, icon), 'utf8');
      expect(svg).not.toMatch(/<script|href=|url\(|<image/i);
      expect(svg).toContain('viewBox="0 0 32 32"');
    }
  });
});

describe('the TextMate grammars', () => {
  const grammar = readJson('syntaxes/mdv.tmLanguage.json') as unknown as {
    scopeName: string;
    patterns: unknown[];
    repository: Record<string, unknown>;
  };
  const injection = readJson('syntaxes/mdv-injection.json') as unknown as {
    scopeName: string;
    injectionSelector: string;
    patterns: unknown[];
  };

  /** Every `{"include": "#name"}` anywhere in the tree. */
  function includes(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const item of node) includes(item, out);
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'include' && typeof value === 'string' && value.startsWith('#')) {
          out.push(value.slice(1));
        } else {
          includes(value, out);
        }
      }
    }
    return out;
  }

  it('matches the scope names the manifest registered', () => {
    const scopes = contributes.grammars.map((g) => g.scopeName);
    expect(scopes).toContain(grammar.scopeName);
    expect(scopes).toContain(injection.scopeName);
    expect(grammar.scopeName).toBe('text.html.markdown.mdv');
  });

  it('resolves every repository reference it makes', () => {
    const defined = new Set(Object.keys(grammar.repository));
    for (const name of includes(grammar.patterns).concat(includes(grammar.repository))) {
      expect(defined, `#${name}`).toContain(name);
    }
  });

  it('reaches every rule it defines', () => {
    const reachable = new Set(includes(grammar.patterns).concat(includes(grammar.repository)));
    for (const name of Object.keys(grammar.repository)) {
      expect(reachable, `#${name} is defined but never included`).toContain(name);
    }
  });

  it('injects into markdown without re-injecting into itself', () => {
    expect(injection.injectionSelector).toContain('L:text.html.markdown');
    expect(injection.injectionSelector).toContain('-text.html.markdown.mdv');
    expect(contributes.grammars.find((g) => g.scopeName === injection.scopeName)?.injectTo).toEqual(
      ['text.html.markdown'],
    );
  });

  it('compiles every pattern as a regular expression', () => {
    const bad: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'match' || key === 'begin' || key === 'end') && typeof value === 'string') {
          // Oniguruma is a superset of JavaScript's syntax; `\h`, `\A` and the
          // like would throw here, so the grammar avoids them deliberately.
          try {
            new RegExp(value);
          } catch {
            bad.push(value);
          }
        } else {
          walk(value);
        }
      }
    };
    walk([grammar.patterns, grammar.repository, injection.patterns]);
    expect(bad).toEqual([]);
  });
});

describe('the snippets', () => {
  const snippets = readJson('snippets/mdv.json') as Record<
    string,
    { prefix?: string | string[]; description?: string; body?: string[] }
  >;
  const entries = Object.entries(snippets).filter(([name]) => name !== '//');

  it('has a described, prefixed, line-array body for each', () => {
    expect(entries.length).toBeGreaterThan(10);
    for (const [name, snippet] of entries) {
      expect(snippet.prefix, name).toBeDefined();
      expect(snippet.description, name).toBeDefined();
      expect(Array.isArray(snippet.body), name).toBe(true);
      for (const line of snippet.body ?? []) expect(typeof line).toBe('string');
    }
  });

  it('uses each prefix once', () => {
    const prefixes = entries.flatMap(([, s]) =>
      typeof s.prefix === 'string' ? [s.prefix] : (s.prefix ?? []),
    );
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('expands into a block the parser accepts, separator and all', () => {
    for (const [name, snippet] of entries) {
      const body = (snippet.body ?? []).join('\n');
      if (!body.includes('```mdv')) continue;

      // SPEC 5.1: a body with no `---` is entirely a header. So a block snippet
      // is well-formed in exactly one of two ways — it writes the separator and
      // some inline data, or it names a dataset with `data: "@…"` and has no
      // data section at all. A snippet that does neither expands into a chart
      // with nothing to draw.
      const inlineData = body.includes('\n---\n');
      const referencesDataset = /\bdata:\s*"@/.test(body);
      expect(inlineData !== referencesDataset, name).toBe(true);

      // Expand the way VS Code would for a user who tabbed straight through:
      // placeholders collapse to their default text.
      const expanded = body
        .replace(/\$\{\d+\|([^,|]+)[^|]*\|\}/g, '$1')
        .replace(/\$\{\d+:([^}]*)\}/g, '$1')
        .replace(/\$\d+/g, '');
      const document = parse(expanded);
      const errors = document.diagnostics.filter((d) => d.severity === 'error');
      expect(
        errors.map((d) => `${d.code}: ${d.message}`),
        name,
      ).toEqual([]);
      // A fence the parser did not recognise stays a plain Markdown `code`
      // node, so counting `mdvBlock` nodes is what distinguishes "parsed" from
      // "quietly ignored".
      expect(countBlocks(document), name).toBeGreaterThan(0);
    }
  });
});
