/** The standalone YAML reader (SPEC 3.4's dialect, applied to a theme file). */

import { describe, expect, it } from 'vitest';
import { parseYamlValue } from '../src/index.js';
import { parse } from '../src/index.js';

describe('SPEC 3.4 — parseYamlValue', () => {
  it('reads a mapping', () => {
    const { value, errors } = parseYamlValue('extends: dark\ntokens:\n  surface: "#111827"\n');
    expect(errors).toEqual([]);
    expect(value).toEqual({ extends: 'dark', tokens: { surface: '#111827' } });
  });

  it('reads JSON, because YAML 1.2 is a superset of it', () => {
    const json = '{"extends":"dark","tokens":{"surface":"#111827"},"categorical":["#2563eb"]}';
    expect(parseYamlValue(json).value).toEqual({
      extends: 'dark',
      tokens: { surface: '#111827' },
      categorical: ['#2563eb'],
    });
    expect(parseYamlValue(json).errors).toEqual([]);
  });

  it('agrees with front matter on every scalar', () => {
    // The point of sharing the reader: one dialect, not two. YAML 1.2's core
    // schema, so `#abc` is a string, `on` and `yes` are strings and only
    // `true` is a boolean, `0x10` is 16 — the same in both places.
    const body = 'a: "#abcdef"\nb: on\nc: 13\nd: null\ne: [1, two]\nf: true\ng: 0x10\n';
    const doc = parse(`---\nmdv: "1.0"\n${body}---\n`);
    expect(doc.frontmatter?.extra).toEqual(parseYamlValue(body).value);
    expect(parseYamlValue(body).value).toEqual({
      a: '#abcdef',
      b: 'on',
      c: 13,
      d: null,
      e: [1, 'two'],
      f: true,
      g: 16,
    });
  });

  it('keeps the last of a duplicated key, as YAML says', () => {
    expect(parseYamlValue('scheme: light\nscheme: dark\n').value).toEqual({ scheme: 'dark' });
  });

  it('returns null for an empty or comment-only text', () => {
    for (const text of ['', '\n', '# just a note\n', '---\n']) {
      const result = parseYamlValue(text);
      expect(result.value, text).toBeNull();
      expect(result.errors, text).toEqual([]);
    }
  });

  it('locates a syntax error instead of throwing', () => {
    const result = parseYamlValue('tokens:\n  surface: "#fff\n');
    expect(result.errors.length).toBeGreaterThan(0);
    const [first] = result.errors;
    expect(first?.message).not.toContain('\n');
    expect(first?.start).toBeGreaterThanOrEqual(0);
    expect(first?.end).toBeGreaterThanOrEqual(first?.start ?? 0);
  });

  it('is more forgiving than JSON, in both the ways that bite', () => {
    // Pinned because callers rely on knowing it, not because it is desirable.
    // A trailing comma is accepted where `JSON.parse` refuses it:
    expect(parseYamlValue('{"a": 1,}')).toEqual({ value: { a: 1 }, errors: [] });
    // ...and `//` is not a comment, so a JSONC file silently loses a key into
    // one long plain scalar instead of failing. This is why a host that offers
    // `.json` to authors reads it with `JSON.parse` instead (`themeFromText`).
    expect(parseYamlValue('{\n  // a note\n  "a": 1\n}')).toEqual({
      value: { '// a note "a"': 1 },
      errors: [],
    });
  });

  it('flattens what JSON cannot carry', () => {
    // Non-finite numbers become strings: the canonical AST is JSON (SPEC 24.3),
    // so nothing may enter the tree that would not survive it.
    expect(parseYamlValue('n: .inf\nm: .nan\n').value).toEqual({ n: 'Infinity', m: 'NaN' });
    // A bare date is a *string* under the 1.2 core schema — no timestamp tag,
    // so no `Date` ever reaches `toAttrValue` from this path, and a theme
    // file's `2026-01-02` stays the text the author typed.
    expect(parseYamlValue('when: 2026-01-02\n').value).toEqual({ when: '2026-01-02' });
    // An integer too large for a double is already lossy before we see it;
    // it stays a number rather than pretending otherwise.
    expect(parseYamlValue('big: 123456789012345678901234567890\n').value).toEqual({
      big: 1.2345678901234568e29,
    });
  });

  it('never throws, whatever it is handed', () => {
    const hostile = [
      'a: &x [*x]\n',
      '*missing\n',
      '\u0000\u0000\u0000',
      '['.repeat(500),
      '- '.repeat(5000),
      '?'.repeat(100),
      '\uFEFFa: 1\n',
      'a:\n\t- tab indent\n',
    ];
    for (const text of hostile) {
      expect(() => parseYamlValue(text), JSON.stringify(text.slice(0, 20))).not.toThrow();
    }
  });

  it('caps alias expansion rather than expanding a billion laughs', () => {
    const bomb =
      'a: &a ["x","x","x","x","x","x","x","x","x"]\n' +
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]\n' +
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]\n' +
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]\n' +
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]\n';
    const result = parseYamlValue(bomb);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/alias/i);
  });

  it('turns a self-referential anchor into an error, not a stack overflow', () => {
    // `yaml` throws a RangeError here rather than reporting it; the catch is
    // load-bearing, and this is the input that proves it.
    const result = parseYamlValue('a: &x [*x]\n');
    expect(result.value).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const text = 'extends: default\ncategorical: ["#2563eb", "#f97316"]\n';
    expect(parseYamlValue(text)).toEqual(parseYamlValue(text));
  });
});
