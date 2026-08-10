/**
 * Theme files (SPEC 11.6): which extension picks which reader, what each reader
 * accepts, and what an unusable file reports instead of throwing (SPEC 14.1).
 */

import { describe, expect, it } from 'vitest';

import { themeFileFormat, themeFromText } from '../src/index.js';

describe('themeFileFormat', () => {
  it('routes each recognised extension to its reader', () => {
    expect(themeFileFormat('brand.json')).toBe('json');
    expect(themeFileFormat('brand.jsonc')).toBe('jsonc');
    expect(themeFileFormat('brand.yaml')).toBe('yaml');
    expect(themeFileFormat('brand.yml')).toBe('yaml');
  });

  it('ignores the case of the extension, not of the name', () => {
    expect(themeFileFormat('./Brand.YAML')).toBe('yaml');
    expect(themeFileFormat('./Brand.JsonC')).toBe('jsonc');
  });

  it('reads the last dot, so a versioned name is still a file', () => {
    expect(themeFileFormat('./brand.v2.json')).toBe('json');
    expect(themeFileFormat('../themes/2024.brand.yaml')).toBe('yaml');
  });

  it('calls anything else a built-in name, for the registry to judge', () => {
    // The CLI bug this replaces: `corporate.toml` looked up as a built-in.
    expect(themeFileFormat('dark')).toBeUndefined();
    expect(themeFileFormat('high-contrast')).toBeUndefined();
    expect(themeFileFormat('brand.toml')).toBeUndefined();
    expect(themeFileFormat('brand.')).toBeUndefined();
    expect(themeFileFormat('')).toBeUndefined();
  });
});

describe('themeFromText', () => {
  it('reads the same theme from JSON and from YAML', () => {
    const json = themeFromText('{"tokens": {"surface": "#010203"}}', 'light', 'json');
    const yaml = themeFromText("tokens:\n  surface: '#010203'\n", 'light', 'yaml');
    expect(json.errors).toEqual([]);
    expect(yaml.errors).toEqual([]);
    expect(json.theme?.tokens.surface).toBe('#010203');
    expect(yaml.theme?.tokens.surface).toBe(json.theme?.tokens.surface);
  });

  it('takes the scheme from the caller when the file names no base', () => {
    const text = "tokens:\n  surface: '#010203'\n";
    expect(themeFromText(text, 'light', 'yaml').theme?.scheme).toBe('light');
    expect(themeFromText(text, 'dark', 'yaml').theme?.scheme).toBe('dark');
  });

  it('lets an explicit `extends` outrank the caller’s scheme', () => {
    // The author named `default`; honouring the request would hand them a base
    // they did not ask for and quietly change every token they inherited.
    expect(themeFromText('extends: default\n', 'dark', 'yaml').theme?.scheme).toBe('light');
    expect(themeFromText('extends: dark\n', 'light', 'yaml').theme?.scheme).toBe('dark');
  });

  describe('json', () => {
    it('refuses a comment, and says where comments are allowed', () => {
      const result = themeFromText('// brand\n{"tokens": {}}', 'light', 'json');
      expect(result.theme).toBeUndefined();
      expect(result.errors[0]).toContain('JSON has no comments');
      expect(result.errors[0]).toContain('.jsonc');
    });

    it('does not mistake a URL in a string for a comment', () => {
      const result = themeFromText('{"name": "https://x.example", }', 'light', 'json');
      // Still a syntax error — the trailing comma — but not blamed on a comment.
      expect(result.errors[0]).not.toContain('JSON has no comments');
    });
  });

  describe('jsonc', () => {
    const text = `{
  // the surface everything else sits on
  "tokens": { "surface": "#010203" }, /* and nothing else */
  "categorical": [
    "#2563eb",
    "#f97316", // orange
  ],
}`;

    it('accepts the comments and trailing commas its name promises', () => {
      const result = themeFromText(text, 'light', 'jsonc');
      expect(result.errors).toEqual([]);
      expect(result.theme?.tokens.surface).toBe('#010203');
      expect(result.theme?.categorical).toEqual(['#2563eb', '#f97316']);
    });

    it('keeps a `//` that is inside a string', () => {
      const result = themeFromText('{"name": "https://x.example/t"}', 'light', 'jsonc');
      expect(result.errors).toEqual([]);
      expect(result.theme?.name).toBe('https://x.example/t');
    });

    it('keeps a comma that is inside a string', () => {
      const result = themeFromText('{"name": "a, b"}', 'light', 'jsonc');
      expect(result.errors).toEqual([]);
      expect(result.theme?.name).toBe('a, b');
    });

    it('does not eat a comma that separates two members', () => {
      const result = themeFromText('{"name": "a", "scheme": "dark"}', 'light', 'jsonc');
      expect(result.errors).toEqual([]);
      expect(result.theme?.scheme).toBe('dark');
    });

    it('reports a real syntax error at the author’s own line', () => {
      const result = themeFromText('{\n  // a note\n  "tokens": \n}', 'light', 'jsonc');
      expect(result.theme).toBeUndefined();
      expect(result.errors[0]).toContain('JSON syntax error');
    });

    it('survives an unterminated block comment', () => {
      const result = themeFromText('{"tokens": {}} /* forever', 'light', 'jsonc');
      expect(result.errors).toEqual([]);
    });
  });

  describe('yaml', () => {
    it('reports a syntax error with a line and column', () => {
      const result = themeFromText('tokens:\n  surface: "#fff\n', 'light', 'yaml');
      expect(result.theme).toBeUndefined();
      expect(result.errors[0]).toMatch(/YAML syntax error at line \d+, column \d+/u);
    });

    it('will not guess at a recovered document', () => {
      // `yaml` recovers from this; a theme that silently lost its palette is
      // worse than one that says it could not be read.
      const result = themeFromText('tokens: {surface: "#010203"\n', 'light', 'yaml');
      expect(result.theme).toBeUndefined();
    });
  });

  it('names every rejection in one pass rather than stopping at the first', () => {
    const result = themeFromText(
      'tokens:\n  surface: 7\n  nonsense: "#fff"\ncategorical: 7\n',
      'light',
      'yaml',
    );
    expect(result.theme).toBeUndefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('reports a file that is not a mapping without throwing', () => {
    for (const text of ['[]', '"dark"', '7', 'null']) {
      const result = themeFromText(text, 'light', 'json');
      expect(result.theme, text).toBeUndefined();
      expect(result.errors[0], text).toContain('must be a mapping');
    }
  });

  it('warns on a palette that fails validation but still resolves it', () => {
    // Two slots no normal-vision reader can separate: SPEC 11.2 rule 4.
    const result = themeFromText('{"categorical": ["#1f77b4", "#1f77b5"]}', 'light', 'json');
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.theme?.categorical).toEqual(['#1f77b4', '#1f77b5']);
  });
});
