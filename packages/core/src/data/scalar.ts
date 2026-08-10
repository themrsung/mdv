/**
 * Scalar notation (SPEC 5.3.1) and the JSON number grammar (SPEC 6.1.1 step 3).
 *
 * Two deliberate omissions, both load-bearing:
 *
 * - only the spellings `true` and `false` are booleans, so `yes`/`no`/`on`/`off`
 *   stay strings (the "Norway problem");
 * - numbers follow the **JSON** number grammar, so `1,240`, `12%` and `$5` are
 *   not numbers under inference. Declaring a type plus a `parse` format is how
 *   an author accepts those.
 */

import type { RawCell } from './raw.js';

/**
 * Scan a JSON number.
 *
 * `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?` — hand-written, so there is no regular
 * expression to backtrack (SPEC 13.6).
 *
 * @returns the numeric value, or `undefined` when `text` is not exactly a JSON
 * number. Leading and trailing whitespace must already be removed.
 */
export function parseJsonNumber(text: string): number | undefined {
  const n = text.length;
  if (n === 0) return undefined;
  let i = 0;
  if (text[i] === '-') i += 1;

  const intStart = i;
  if (text[i] === '0') {
    i += 1;
  } else {
    while (i < n && isDigit(text.charCodeAt(i))) i += 1;
  }
  if (i === intStart) return undefined;

  if (text[i] === '.') {
    i += 1;
    const fracStart = i;
    while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    if (i === fracStart) return undefined;
  }

  if (text[i] === 'e' || text[i] === 'E') {
    i += 1;
    if (text[i] === '+' || text[i] === '-') i += 1;
    const expStart = i;
    while (i < n && isDigit(text.charCodeAt(i))) i += 1;
    if (i === expStart) return undefined;
  }

  if (i !== n) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * A relaxed number reader for **declared** numeric fields (SPEC 6.1.1 step 3
 * names what inference rejects; a declaration is the author saying "accept it").
 *
 * Accepts grouping separators, a leading currency symbol, a trailing `%`
 * (divided by 100), parentheses for negatives, and surrounding whitespace.
 */
export function parseLooseNumber(text: string): number | undefined {
  let s = text.trim();
  if (s === '') return undefined;

  let sign = 1;
  if (s.startsWith('(') && s.endsWith(')')) {
    sign = -1;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  }

  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trimEnd();
  }

  // Strip one leading currency symbol or ISO code.
  s = s.replace(/^[$\u20AC\u00A3\u00A5\u20A9\u20B9\u00A4]\s*/u, '');
  s = s.replace(/\s*[$\u20AC\u00A3\u00A5\u20A9\u20B9\u00A4]$/u, '');

  // Grouping separators, but only in the integer part.
  const dot = s.indexOf('.');
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const rest = dot < 0 ? '' : s.slice(dot);
  const compact = intPart.replace(/[,'\u00A0\u202F\u2009 ]/gu, '') + rest;

  if (compact === '') return undefined;
  const value = Number(compact);
  if (!Number.isFinite(value)) return undefined;
  return sign * (percent ? value / 100 : value);
}

/**
 * Read one scalar token in attribute notation: a quoted string, `true`/`false`,
 * `null`, a JSON number, or a bare string.
 */
export function parseScalarToken(text: string): RawCell {
  const s = text.trim();
  if (s === '') return '';
  const first = s[0];
  if ((first === '"' || first === "'") && s.length >= 2 && s[s.length - 1] === first) {
    return unescape(s.slice(1, -1), first);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  const num = parseJsonNumber(s);
  return num === undefined ? s : num;
}

function unescape(body: string, quote: string): string {
  if (quote === "'") return body.replace(/''/gu, "'");
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    i += 1;
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        out += next === undefined ? '\\' : `\\${next}`;
    }
  }
  return out;
}
