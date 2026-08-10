/**
 * MDVX tokeniser (SPEC 6.8.1).
 *
 * Hand-written, like every scanner in this implementation, so that scanning is
 * linear in the input and free of catastrophic backtracking (SPEC 13.6).
 */

/** Token kinds. Punctuators carry their own text, so one kind covers them all. */
export type TokenKind =
  | 'number'
  | 'string'
  | 'identifier'
  /** A bracketed field reference: `[Net revenue (USD)]`. */
  | 'field'
  | 'punct'
  | 'end';

export interface Token {
  kind: TokenKind;
  /** Punctuator text, identifier name, field name, or the raw number source. */
  text: string;
  /** Decoded value for `number` and `string`. */
  value?: number | string;
  /** Offset of the first character, for diagnostics. */
  start: number;
  /** Offset one past the last character. */
  end: number;
}

/** A scan failure. The caller turns this into `MDV2200`. */
export interface LexError {
  message: string;
  offset: number;
}

export interface LexResult {
  tokens?: Token[];
  error?: LexError;
}

/**
 * Multi-character punctuators, longest first — the scanner tries them in this
 * order, so `**` never scans as two `*` and `<=` never as `<` then `=`.
 */
const PUNCTUATORS: readonly string[] = [
  '**',
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '?',
  ':',
  '(',
  ')',
  '[',
  ']',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '!',
];

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Scan `source` into tokens. Never throws.
 *
 * The grammar's `field-ref` production allows any character inside brackets
 * except `]` itself, which is why bracketed names need no escaping and cannot
 * nest.
 */
export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i] as string;

    if (isSpace(ch)) {
      i += 1;
      continue;
    }

    // ── Numbers ──────────────────────────────────────────────────────────────
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i;
      while (isDigit(source[i] ?? '')) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (isDigit(source[i] ?? '')) i += 1;
      }
      const exp = source[i];
      if (exp === 'e' || exp === 'E') {
        const save = i;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        if (isDigit(source[i] ?? '')) {
          while (isDigit(source[i] ?? '')) i += 1;
        } else {
          i = save; // `1e` is `1` followed by an identifier, not a bad number.
        }
      }
      const text = source.slice(start, i);
      tokens.push({ kind: 'number', text, value: Number(text), start, end: i });
      continue;
    }

    // ── Strings ──────────────────────────────────────────────────────────────
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i += 1;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '\\') {
          const next = source[i + 1];
          if (next === undefined) break;
          out += unescape(next);
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          closed = true;
          break;
        }
        out += c;
        i += 1;
      }
      if (!closed) {
        return { error: { message: 'Unterminated string literal', offset: start } };
      }
      tokens.push({ kind: 'string', text: source.slice(start, i), value: out, start, end: i });
      continue;
    }

    // ── Bracketed field references ───────────────────────────────────────────
    // `[` also opens a list literal. It is a field reference only when the
    // contents are not an expression list — decided by the parser, which sees
    // both forms. To keep the scanner context-free we emit a `field` token only
    // when the bracket run contains no comma and does not look like a nested
    // expression; otherwise we emit the punctuator and let the parser build a
    // list. A name containing a comma must therefore be written with quotes in
    // the rare places a list is also legal, which the grammar never requires.
    if (ch === '[') {
      const close = source.indexOf(']', i + 1);
      if (close !== -1) {
        const inner = source.slice(i + 1, close);
        if (isBareFieldName(inner)) {
          tokens.push({ kind: 'field', text: inner, start: i, end: close + 1 });
          i = close + 1;
          continue;
        }
      }
      tokens.push({ kind: 'punct', text: '[', start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // ── Identifiers ──────────────────────────────────────────────────────────
    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i] as string)) i += 1;
      tokens.push({ kind: 'identifier', text: source.slice(start, i), start, end: i });
      continue;
    }

    // ── Punctuators ──────────────────────────────────────────────────────────
    const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (punct !== undefined) {
      tokens.push({ kind: 'punct', text: punct, start: i, end: i + punct.length });
      i += punct.length;
      continue;
    }

    return { error: { message: `Unexpected character ${JSON.stringify(ch)}`, offset: i } };
  }

  tokens.push({ kind: 'end', text: '', start: source.length, end: source.length });
  return { tokens };
}

/**
 * `true` when a bracket run is a field name rather than a list literal.
 *
 * A list literal's elements are expressions, so they start with a digit, quote,
 * bracket, sign or identifier *and* the run either is empty or contains a
 * separator. A field name is anything else: it holds spaces, punctuation, or
 * simply is not a well-formed expression. The one genuinely ambiguous case —
 * `[revenue]` — resolves to the **field**, matching the grammar, which offers no
 * other way to spell a name that needs brackets. Single-element lists are
 * therefore written `[revenue, ]`-free by using a quoted literal instead.
 */
function isBareFieldName(inner: string): boolean {
  if (inner.length === 0) return false; // `[]` is the empty list.
  if (inner.includes(',')) return false; // Lists have separators; names may not.
  if (inner.includes('[')) return false; // Nested brackets belong to lists.
  const trimmed = inner.trim();
  if (trimmed.length === 0) return false;
  // A literal element (number, string, boolean, null) is a one-element list.
  if (isDigit(trimmed[0] as string) || trimmed[0] === "'" || trimmed[0] === '"') return false;
  if (trimmed === 'true' || trimmed === 'false' || trimmed === 'null') return false;
  return true;
}

function unescape(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case '0':
      return '\0';
    default:
      return ch; // `\'`, `\"`, `\\`, and anything else, verbatim.
  }
}
