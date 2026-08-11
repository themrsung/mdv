import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalAst, parse, sameDocument, toMarkdown } from '@mdv/parser';

const appendixE = readFileSync(
  fileURLToPath(new URL('./fixtures/appendix-e.mdv', import.meta.url)),
  'utf8',
);

/**
 * The round-trip corpus. Every entry is parsed, serialised, re-parsed and
 * re-serialised; the two serialisations must be byte-identical and the two ASTs
 * must agree on everything except where in the file things ended up.
 */
const CORPUS: Record<string, string> = {
  'appendix E': appendixE,

  'plain commonmark': [
    '# Title',
    '',
    'A paragraph with *emphasis*, **strong**, `code` and a [link](https://example.com).',
    '',
    '- one',
    '- two',
    '  - nested',
    '',
    '> quoted',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
  ].join('\n'),

  'front matter only': ['---', 'mdv: "1.0"', 'title: T', 'extra: kept', '---', ''].join('\n'),

  'block with header and data': [
    '```mdv bar height=200',
    'title: Revenue',
    'y: [revenue, profit]',
    'axis:',
    '  y: {title: USD, format: ",.0f"}',
    '---',
    'quarter | revenue | profit',
    'Q1      |    1240 |    310',
    '```',
    '',
  ].join('\n'),

  'block with no separator': ['```mdv metric', 'label: Revenue', 'value: 10', '```', ''].join('\n'),

  'block with an empty header': ['```mdv pie', '---', 'a | 1', 'b | 2', '```', ''].join('\n'),

  'header with comments and blank lines': [
    '```mdv line',
    '# leading comment',
    '',
    'x: date    # trailing',
    '',
    'y: value',
    '```',
    '',
  ].join('\n'),

  'block scalars': [
    '```mdv bar',
    'literal: |',
    '  one',
    '  two',
    'folded: >',
    '  one',
    '  two',
    '```',
    '',
  ].join('\n'),

  'tilde fence holding backticks': ['~~~mdv bar title="a `b` c"', 'x: 1', '~~~', ''].join('\n'),

  directives: [
    ':::mdv-grid{cols=3 gap=16}',
    '',
    '::mdv-page{break=before}',
    '',
    'Text with :mdv-metric[1284000]{format="$~s"} and :mdv-badge[Beta]{type=note}.',
    '',
    ':::',
    '',
  ].join('\n'),

  'container with no blank lines': [':::mdv-callout{type=note}', 'Body.', ':::', ''].join('\n'),

  'gfm table attributes': [
    '| region | revenue |',
    '| ------ | ------: |',
    '| APAC   |   42100 |',
    '{.mdv-table sortable=true total="revenue:sum"}',
    '',
  ].join('\n'),

  'block inside a list': ['- item', '', '  ```mdv bar', '  x: a', '  ```', ''].join('\n'),

  'block inside a block quote': ['> ```mdv bar', '> x: a', '> ---', '> a|b', '> ```', ''].join(
    '\n',
  ),

  'malformed block': ['```mdv', '\tbad: [1,', 'stray line', '```', ''].join('\n'),
};

describe('SPEC 19 — toMarkdown round-trips', () => {
  it.each(Object.keys(CORPUS))('%s', (name) => {
    const source = CORPUS[name] as string;
    const first = parse(source);
    const printed = toMarkdown(first);
    const second = parse(printed);
    const reprinted = toMarkdown(second);

    // Formatting is a fixed point: `mdv fmt` run twice changes nothing.
    expect(reprinted).toBe(printed);
    // And the document itself is unchanged, positions aside — they necessarily
    // move when the formatter normalises whitespace.
    expect(canonicalAst(second, { positions: false })).toBe(
      canonicalAst(first, { positions: false }),
    );
    // Diagnostics must not appear or vanish across a format.
    expect(second.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      first.diagnostics.map((diagnostic) => diagnostic.code),
    );
  });

  it('keeps an already-canonical document byte-identical, positions included', () => {
    const canonical = toMarkdown(parse(appendixE));
    const once = parse(canonical);
    expect(toMarkdown(once)).toBe(canonical);
    expect(canonicalAst(parse(toMarkdown(once)))).toBe(canonicalAst(once));
  });

  it('escapes text that would otherwise become a directive on re-parse', () => {
    const source = 'literal \\:mdv-ref[x] stays text\n';
    const document = parse(source);
    const printed = toMarkdown(document);
    expect(printed).toContain('\\:mdv-ref');
    const again = parse(printed);
    expect(canonicalAst(again, { positions: false })).toBe(
      canonicalAst(document, { positions: false }),
    );
  });
});

describe('SPEC 27 — attribute order', () => {
  // Source order is deliberately none of the three answers, and `id` sits in
  // the middle so the `#id` shorthand has to survive being moved around.
  const source = '::mdv-callout{zebra=1 title=T alpha=2 id=hero desc=D}\n';

  const attrsOf = (text: string): Record<string, unknown> => {
    const directive = parse(text).children.find((child) => child.type === 'mdvDirective');
    return (directive as { attrs: Record<string, unknown> }).attrs;
  };

  it('defaults to canonical: the fixed prefix in spec order, then alphabetical', () => {
    expect(toMarkdown(parse(source))).toBe('::mdv-callout{#hero title=T desc=D alpha=2 zebra=1}\n');
    expect(toMarkdown(parse(source), { attrOrder: 'canonical' })).toBe(toMarkdown(parse(source)));
  });

  it('sorts every key alphabetically when asked, prefix included', () => {
    expect(toMarkdown(parse(source), { attrOrder: 'alphabetical' })).toBe(
      '::mdv-callout{alpha=2 desc=D #hero title=T zebra=1}\n',
    );
  });

  it('leaves the author’s order untouched when asked to preserve it', () => {
    // Order is preserved; spelling is not part of the order, so `id` still
    // takes the `#` shorthand where it stands.
    expect(toMarkdown(parse(source), { attrOrder: 'preserve' })).toBe(
      '::mdv-callout{zebra=1 title=T alpha=2 #hero desc=D}\n',
    );
  });

  it('changes only the order — never the attributes themselves', () => {
    const expected = attrsOf(source);
    for (const attrOrder of ['canonical', 'alphabetical', 'preserve'] as const) {
      const printed = toMarkdown(parse(source), { attrOrder });
      expect(attrsOf(printed)).toEqual(expected);
      // Each mode is still a fixed point of itself.
      expect(toMarkdown(parse(printed), { attrOrder })).toBe(printed);
    }
  });
});

describe('SPEC 24.3 — determinism', () => {
  it('produces byte-identical output for the same input', () => {
    const a = canonicalAst(parse(appendixE));
    const b = canonicalAst(parse(appendixE));
    expect(b).toBe(a);
    expect(toMarkdown(parse(appendixE))).toBe(toMarkdown(parse(appendixE)));
  });

  it('keeps attribute iteration order in source order', () => {
    const block = parse('```mdv bar\nzebra: 1\nalpha: 2\nmiddle: 3\n```\n').children.find(
      (child) => child.type === 'mdvBlock',
    );
    expect(Object.keys((block as { attrs: Record<string, unknown> }).attrs)).toEqual([
      'zebra',
      'alpha',
      'middle',
      'type',
    ]);
  });
});

describe('SPEC 19 — canonical form', () => {
  it('sorts keys, reduces position to offsets and rounds floats', () => {
    const json = canonicalAst({
      position: {
        start: { line: 1, column: 1, offset: 3 },
        end: { line: 1, column: 4, offset: 9 },
      },
      b: 1,
      a: 1 / 3,
      type: 'x',
    });
    expect(json).toBe(
      [
        '{',
        '  "a": 0.333333,',
        '  "b": 1,',
        '  "position": [',
        '    3,',
        '    9',
        '  ],',
        '  "type": "x"',
        '}',
      ].join('\n'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 14.1 / 15 — malformed input never throws and never loses source
// ─────────────────────────────────────────────────────────────────────────────

/** A tiny deterministic PRNG; `Math.random` is banned in library and test alike. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const ADVERSARIAL = [
  '',
  '\n',
  '\r\n\r\n',
  '---',
  '---\n',
  '---\n---',
  '...\n',
  '```mdv',
  '```mdv\n',
  '```mdv bar',
  '~~~mdv',
  '```mdv bar\n---',
  '```mdv bar\n---\n',
  '`'.repeat(400),
  ':'.repeat(400),
  ':::mdv-',
  ':::mdv-a{',
  ':::mdv-a{x=',
  ':::mdv-a[',
  '::mdv-a[]{}',
  ':mdv-a[[[[[',
  ':::'.repeat(200),
  '```mdv bar\n' + 'a:\n'.repeat(500) + '```\n',
  '```mdv bar\n' + '  '.repeat(200) + 'a: 1\n```\n',
  '```mdv bar\ny: ' + '['.repeat(300) + '\n```\n',
  '```mdv bar\ny: ' + '{'.repeat(300) + '\n```\n',
  '```mdv bar\ntitle: "unterminated\n```\n',
  '```mdv bar\n\t\t\t\ta: 1\n```\n',
  '> '.repeat(100) + '```mdv bar\nx: 1\n```\n',
  '- '.repeat(100) + '```mdv bar\nx: 1\n```\n',
  '---\nmdv: [\n---\n',
  '---\n' + 'a: &x\n'.repeat(50) + '---\n',
  String.fromCharCode(0) + '```mdv bar\n```',
  '\uFEFF\uFEFF\uFEFF',
];

describe('SPEC 14.1 — malformed input is data, not an exception', () => {
  it.each(ADVERSARIAL.map((source, index) => [index, source] as const))(
    'survives adversarial input #%i',
    (_index, source) => {
      const document = parse(source);
      expect(document.type).toBe('root');
      expect(Array.isArray(document.diagnostics)).toBe(true);
      // Serialising whatever came out must be safe too.
      expect(() => toMarkdown(document)).not.toThrow();
    },
  );

  it('survives every truncation of the worked example', () => {
    for (let end = 0; end <= appendixE.length; end += 7) {
      const source = appendixE.slice(0, end);
      expect(() => toMarkdown(parse(source))).not.toThrow();
    }
  });

  it('survives deterministic byte soup', () => {
    const random = lcg(20260810);
    const alphabet = [...'`~:{}[]#-|>\n "\'&*!?%\\0123456789abz'];
    for (let iteration = 0; iteration < 300; iteration += 1) {
      let source = '';
      const length = 1 + Math.floor(random() * 120);
      for (let i = 0; i < length; i += 1) {
        source += alphabet[Math.floor(random() * alphabet.length)] as string;
      }
      expect(() => toMarkdown(parse(source))).not.toThrow();
    }
  });

  it('never loses the text of a block it cannot understand', () => {
    const source = '```mdv bar\n? complex\n&anchor\nstray | row\n```\n';
    const document = parse(source);
    const block = document.children.find((child) => child.type === 'mdvBlock');
    const raw = (block as { raw: { header: string } }).raw.header;
    expect(raw).toBe('? complex\n&anchor\nstray | row\n');
    expect(document.diagnostics.length).toBeGreaterThan(0);
  });
});

/**
 * The comparison `mdv fmt` and the language server run before they write. It is
 * the round-trip property above, packaged: a formatter is allowed to move text
 * and nothing else.
 */
describe('SPEC 27 — sameDocument', () => {
  it.each(Object.keys(CORPUS))('holds across a format of %s', (name) => {
    const source = CORPUS[name] as string;
    const document = parse(source);
    expect(sameDocument(parse(toMarkdown(document)), document)).toBe(true);
  });

  it('ignores where in the file things are', () => {
    // Same document, laid out differently: the formatter's whole job.
    const loose = parse('#    Title\n\n\n*   one\n*   two\n');
    const tight = parse('# Title\n\n- one\n- two\n');
    expect(sameDocument(loose, tight)).toBe(true);
    // ...which is only interesting because the positions really do differ.
    expect(canonicalAst(loose)).not.toBe(canonicalAst(tight));
  });

  it('notices a lost block', () => {
    const document = parse('# Title\n\ntext\n');
    const shortened = { ...document, children: document.children.slice(0, 1) };
    expect(sameDocument(shortened, document)).toBe(false);
  });

  it('notices reordering', () => {
    const document = parse('one\n\ntwo\n');
    const reversed = { ...document, children: [...document.children].reverse() };
    expect(reversed.children).toHaveLength(2);
    expect(sameDocument(reversed, document)).toBe(false);
  });

  it('notices a changed block body, which has no children to compare', () => {
    const before = parse('```mdv bar\ntitle: A\n---\nq | v\nQ1 | 1\n```\n');
    const after = parse('```mdv bar\ntitle: A\n---\nq | v\nQ1 | 2\n```\n');
    expect(sameDocument(before, after)).toBe(false);
  });

  it('notices a diagnostic appearing', () => {
    const clean = parse('```mdv bar\ntitle: A\n```\n');
    const broken = parse('```mdv bar\n\tbad: [1,\n```\n');
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    expect(sameDocument(clean, broken)).toBe(false);
  });
});

/**
 * SPEC 5.2 / SPEC 19 - a formatter is only allowed to rewrite an info string it
 * managed to read completely. The parser recovers what it can from a malformed
 * one so the rest of the document still renders, but those recovered attributes
 * are a partial reading: rebuilding the line from them would delete the text the
 * parser rejected, and the diagnostic pointing at it would vanish on the next
 * parse. Every case below is a line `parseInfoString` reports on.
 */
describe('SPEC 5.2 - malformed info strings survive formatting', () => {
  const MALFORMED: Record<string, string> = {
    'the spec template itself': '```mdv <type> [key=value …]\n```\n',
    'a bare word after the type': '```mdv bar oops\ntitle: T\n```\n',
    'an unclosed quote': '```mdv bar title="unclosed\n```\n',
    'a key with no value': '```mdv bar title=\n```\n',
    'punctuation where a type goes': '```mdv !!!\n```\n',
  };

  it.each(Object.keys(MALFORMED))('reports on %s', (name) => {
    const document = parse(MALFORMED[name] as string);
    expect(document.diagnostics.length).toBeGreaterThan(0);
  });

  it.each(Object.keys(MALFORMED))('echoes %s verbatim', (name) => {
    const source = MALFORMED[name] as string;
    const printed = toMarkdown(parse(source));
    const infoLine = (text: string): string => text.split('\n')[0] as string;
    expect(infoLine(printed)).toBe(infoLine(source));
  });

  it.each(Object.keys(MALFORMED))('still reaches a fixed point on %s', (name) => {
    const source = MALFORMED[name] as string;
    const once = toMarkdown(parse(source));
    expect(toMarkdown(parse(once))).toBe(once);
    expect(sameDocument(parse(once), parse(source))).toBe(true);
  });

  it('keeps canonicalising info strings it did read', () => {
    const source = '```mdv bar zeta=1 alpha=2\ntitle: T\n```\n';
    expect(toMarkdown(parse(source))).toContain('```mdv bar alpha=2 zeta=1');
  });
});
