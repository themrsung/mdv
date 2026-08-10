/**
 * MDV attribute notation (SPEC 5.3) — the visual block header language.
 *
 * This is a *deliberately small* deterministic subset of YAML 1.2, specified so
 * that a full YAML parser is not required. The engine implements it directly
 * for two reasons: zero dependencies, and because an editor needs the parse to
 * be **non-destructive** — the authoritative representation of a header stays
 * the verbatim source, and this module only produces a read-only view of it
 * plus surgical single-key edits.
 *
 * Supported (SPEC 5.3.1): mapping entries, nested mappings at exactly two
 * spaces per level, block sequences, flow sequences, flow mappings, plain and
 * quoted scalars, literal (`|`) and folded (`>`) multiline scalars, whole-line
 * and trailing comments, `null`/`~`/empty, `true`/`false` only, JSON numbers.
 *
 * Explicitly unsupported (SPEC 5.3.2): anchors and aliases, tags, multiple
 * documents, complex keys, octal and sexagesimal literals. Each is reported as
 * a diagnostic rather than being silently misparsed.
 */

/** A value expressible in MDV attribute notation. */
export type AttrValue = string | number | boolean | null | readonly AttrValue[] | AttrMap;

/** A mapping of attribute keys to values, in source order. */
export interface AttrMap {
  readonly [key: string]: AttrValue;
}

/** A problem found while parsing a header section. */
export interface AttrDiagnostic {
  /** Specification diagnostic code, e.g. `MDV1210`. */
  readonly code: string;
  readonly message: string;
  /** 1-based line number within the header section. */
  readonly line: number;
}

/** Result of {@link parseAttributes}. */
export interface AttrParseResult {
  readonly value: AttrMap;
  readonly diagnostics: readonly AttrDiagnostic[];
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
  readonly tabbed: boolean;
}

function scanLines(source: string): readonly Line[] {
  const out: Line[] = [];
  const raw = source.split('\n');
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index] ?? '';
    const match = /^[ \t]*/.exec(line);
    const lead = match ? match[0] : '';
    out.push({
      indent: lead.length,
      text: line.slice(lead.length),
      number: index + 1,
      tabbed: lead.includes('\t'),
    });
  }
  return out;
}

/** Strip a trailing comment: `#` at line start, or preceded by whitespace, outside quotes. */
export function stripComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\' && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(text[index - 1] ?? ''))) {
      return text.slice(0, index).replace(/\s+$/, '');
    }
  }
  return text;
}

/** Parse a scalar according to SPEC 5.3.3 spelling rules. */
export function parseScalar(raw: string, diagnostics: AttrDiagnostic[], line: number): AttrValue {
  const text = raw.trim();
  if (text === '' || text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;

  const first = text[0];
  if (first === '"' || first === "'") {
    return parseQuoted(text, first, diagnostics, line);
  }
  if (first === '[') return parseFlowSequence(text, diagnostics, line);
  if (first === '{') return parseFlowMapping(text, diagnostics, line);
  if (first === '&' || first === '*') {
    diagnostics.push({
      code: 'MDV1211',
      message: 'anchors and aliases are not part of MDV attribute notation',
      line,
    });
    return text;
  }
  if (text.startsWith('!!')) {
    diagnostics.push({ code: 'MDV1211', message: 'YAML tags are not supported', line });
    return text;
  }
  if (JSON_NUMBER.test(text)) return Number(text);
  if (/^0[0-7]+$/.test(text) || /^\d+:\d+/.test(text)) {
    diagnostics.push({
      code: 'MDV1211',
      message: 'octal and sexagesimal literals are not supported; quote the value',
      line,
    });
    return text;
  }
  return text;
}

function parseQuoted(
  text: string,
  quote: string,
  diagnostics: AttrDiagnostic[],
  line: number,
): string {
  let out = '';
  let closed = false;
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quote === '"' && character === '\\') {
      const next = text[index + 1];
      if (next !== undefined) {
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        index += 1;
        continue;
      }
    }
    if (character === quote) {
      closed = true;
      break;
    }
    out += character;
  }
  if (!closed) {
    diagnostics.push({ code: 'MDV1212', message: 'unterminated quoted scalar', line });
  }
  return out;
}

/** Split a flow collection body on commas that are not inside nested brackets or quotes. */
function splitFlow(body: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (quote) {
      current += character;
      if (character === '\\' && quote === '"') {
        const next = body[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        }
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '[' || character === '{') depth += 1;
    if (character === ']' || character === '}') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim() !== '' || parts.length > 0) parts.push(current);
  return parts;
}

function parseFlowSequence(
  text: string,
  diagnostics: AttrDiagnostic[],
  line: number,
): readonly AttrValue[] {
  const end = text.lastIndexOf(']');
  if (end < 0) {
    diagnostics.push({ code: 'MDV1212', message: 'unterminated flow sequence', line });
    return [];
  }
  const body = text.slice(1, end).trim();
  if (body === '') return [];
  return splitFlow(body).map((part) => parseScalar(part, diagnostics, line));
}

function parseFlowMapping(text: string, diagnostics: AttrDiagnostic[], line: number): AttrMap {
  const end = text.lastIndexOf('}');
  if (end < 0) {
    diagnostics.push({ code: 'MDV1212', message: 'unterminated flow mapping', line });
    return {};
  }
  const body = text.slice(1, end).trim();
  const out: Record<string, AttrValue> = {};
  if (body === '') return out;
  for (const part of splitFlow(body)) {
    const colon = findFlowColon(part);
    if (colon < 0) {
      diagnostics.push({
        code: 'MDV1213',
        message: `flow mapping entry without a key: ${part.trim()}`,
        line,
      });
      continue;
    }
    const key = part
      .slice(0, colon)
      .trim()
      .replace(/^["']|["']$/g, '');
    out[key] = parseScalar(part.slice(colon + 1), diagnostics, line);
  }
  return out;
}

function findFlowColon(part: string): number {
  let quote: string | null = null;
  for (let index = 0; index < part.length; index += 1) {
    const character = part[index];
    if (quote) {
      if (character === '\\' && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ':') return index;
  }
  return -1;
}

/**
 * Parse a header section into a structured, read-only view.
 *
 * Never throws: malformed input yields a best-effort map plus diagnostics, so
 * an editor can keep showing the block while flagging the problem.
 */
export function parseAttributes(source: string): AttrParseResult {
  const diagnostics: AttrDiagnostic[] = [];
  const lines = scanLines(source);
  const value = parseBlockMapping(lines, { index: 0 }, 0, diagnostics);
  return { value, diagnostics };
}

interface Cursor {
  index: number;
}

function isBlank(line: Line): boolean {
  return stripComment(line.text).trim() === '';
}

function parseBlockMapping(
  lines: readonly Line[],
  cursor: Cursor,
  indent: number,
  diagnostics: AttrDiagnostic[],
): AttrMap {
  const out: Record<string, AttrValue> = {};
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (!line) break;
    if (isBlank(line)) {
      cursor.index += 1;
      continue;
    }
    if (line.tabbed) {
      diagnostics.push({
        code: 'MDV1210',
        message: 'tabs are not permitted for indentation',
        line: line.number,
      });
    }
    if (line.indent < indent) break;
    if (line.indent > indent) {
      diagnostics.push({ code: 'MDV1210', message: 'unexpected indentation', line: line.number });
      cursor.index += 1;
      continue;
    }
    if (line.text.startsWith('- ') || line.text === '-') break;
    if (line.text.startsWith('? ')) {
      diagnostics.push({
        code: 'MDV1211',
        message: 'complex keys are not supported',
        line: line.number,
      });
      cursor.index += 1;
      continue;
    }

    const stripped = stripComment(line.text);
    const match = KEY.exec(stripped);
    if (!match || match[1] === undefined || match[2] === undefined) {
      diagnostics.push({
        code: 'MDV1213',
        message: `expected "key: value", found ${JSON.stringify(line.text)}`,
        line: line.number,
      });
      cursor.index += 1;
      continue;
    }

    const key = match[1];
    const rest = match[2].trim();
    cursor.index += 1;

    if (
      rest === '|' ||
      rest === '>' ||
      rest === '|-' ||
      rest === '>-' ||
      rest === '|+' ||
      rest === '>+'
    ) {
      out[key] = readMultiline(lines, cursor, indent + 2, rest);
      continue;
    }
    if (rest === '') {
      const nested = readNested(lines, cursor, indent, diagnostics);
      out[key] = nested;
      continue;
    }
    out[key] = parseScalar(rest, diagnostics, line.number);
  }
  return out;
}

function readNested(
  lines: readonly Line[],
  cursor: Cursor,
  indent: number,
  diagnostics: AttrDiagnostic[],
): AttrValue {
  let probe = cursor.index;
  while (probe < lines.length) {
    const line = lines[probe];
    if (!line) break;
    if (isBlank(line)) {
      probe += 1;
      continue;
    }
    break;
  }
  const next = lines[probe];
  if (!next || next.indent <= indent) {
    // `key:` with nothing beneath it is an explicit null (SPEC 5.3.1).
    if (next && next.indent === indent && (next.text.startsWith('- ') || next.text === '-')) {
      cursor.index = probe;
      return parseBlockSequence(lines, cursor, indent, diagnostics);
    }
    return null;
  }
  cursor.index = probe;
  if (next.text.startsWith('- ') || next.text === '-') {
    return parseBlockSequence(lines, cursor, next.indent, diagnostics);
  }
  return parseBlockMapping(lines, cursor, next.indent, diagnostics);
}

function parseBlockSequence(
  lines: readonly Line[],
  cursor: Cursor,
  indent: number,
  diagnostics: AttrDiagnostic[],
): readonly AttrValue[] {
  const out: AttrValue[] = [];
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (!line) break;
    if (isBlank(line)) {
      cursor.index += 1;
      continue;
    }
    if (line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break;
    const rest = stripComment(line.text === '-' ? '' : line.text.slice(2)).trim();
    cursor.index += 1;
    if (rest === '') {
      out.push(readNested(lines, cursor, indent, diagnostics));
      continue;
    }
    // `- key: value` starts an inline mapping whose continuation lines are
    // indented to the text column.
    const match = KEY.exec(rest);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      const entry: Record<string, AttrValue> = {};
      entry[match[1]] = parseScalar(match[2], diagnostics, line.number);
      const nested = parseBlockMapping(lines, cursor, indent + 2, diagnostics);
      out.push({ ...entry, ...nested });
      continue;
    }
    out.push(parseScalar(rest, diagnostics, line.number));
  }
  return out;
}

function readMultiline(
  lines: readonly Line[],
  cursor: Cursor,
  indent: number,
  style: string,
): string {
  const collected: string[] = [];
  let blockIndent = -1;
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (!line) break;
    const blank = line.text.trim() === '';
    if (!blank && line.indent < Math.max(indent, blockIndent < 0 ? indent : blockIndent)) break;
    if (!blank && blockIndent < 0) blockIndent = line.indent;
    collected.push(
      blank ? '' : ' '.repeat(line.indent - (blockIndent < 0 ? 0 : blockIndent)) + line.text,
    );
    cursor.index += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

  if (style.startsWith('|')) {
    const body = collected.join('\n');
    return style.endsWith('-') ? body : `${body}\n`;
  }
  // Folded: blank lines become paragraph breaks, other newlines become spaces.
  const folded = collected
    .reduce<string[]>((acc, current) => {
      if (current === '') {
        acc.push('');
        return acc;
      }
      const last = acc[acc.length - 1];
      if (last === undefined || last === '') acc.push(current);
      else acc[acc.length - 1] = `${last} ${current}`;
      return acc;
    }, [])
    .join('\n');
  return style.endsWith('-') ? folded : `${folded}\n`;
}

/* -------------------------------------------------------------------------- */
/* Surgical editing                                                            */
/* -------------------------------------------------------------------------- */

/** Render a value in the smallest safe attribute-notation spelling. */
export function formatScalar(value: AttrValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatScalar(item as AttrValue)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as AttrMap).map(
      ([key, item]) => `${key}: ${formatScalar(item)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return quoteIfNeeded(value);
}

/** Quote a string scalar when SPEC 5.3.1 requires it, otherwise leave it bare. */
export function quoteIfNeeded(value: string): string {
  const needsQuote =
    value === '' ||
    value === 'null' ||
    value === 'true' ||
    value === 'false' ||
    value === '~' ||
    JSON_NUMBER.test(value) ||
    /^[[{"'#]/.test(value) ||
    value.includes(': ') ||
    value.includes('\n') ||
    /\s#/.test(value) ||
    /\s$/.test(value) ||
    /^\s/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/**
 * Set one top-level key in a header section, preserving every other line
 * exactly — comments, ordering, quoting style and nested blocks included.
 *
 * If the key exists as a top-level scalar entry its line is rewritten in place.
 * If it exists as a nested mapping or multiline scalar the whole entry (its line
 * plus every more-indented line beneath it) is replaced. If it does not exist,
 * the entry is appended.
 *
 * Passing `undefined` as the value removes the entry.
 */
export function setHeaderAttribute(
  header: string,
  key: string,
  value: AttrValue | undefined,
): string {
  const lines = header === '' ? [] : header.split('\n');
  const replacement = value === undefined ? null : `${key}: ${formatScalar(value)}`;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const indentMatch = /^[ \t]*/.exec(line);
    if ((indentMatch ? indentMatch[0].length : 0) !== 0) continue;
    const match = KEY.exec(stripComment(line));
    if (!match || match[1] !== key) continue;

    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end] ?? '';
      if (next.trim() === '') {
        end += 1;
        continue;
      }
      const lead = /^[ \t]*/.exec(next);
      if ((lead ? lead[0].length : 0) === 0) break;
      end += 1;
    }
    const tail = lines.slice(end);
    const head = lines.slice(0, index);
    return [...head, ...(replacement === null ? [] : [replacement]), ...tail].join('\n');
  }

  if (replacement === null) return header;
  if (lines.length === 0) return replacement;
  return `${header}\n${replacement}`;
}
