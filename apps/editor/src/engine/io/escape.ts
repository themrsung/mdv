/**
 * Inline escaping and unescaping.
 *
 * The writer escapes exactly what CommonMark would otherwise reinterpret, and
 * no more: over-escaping (`foo\_bar\_baz`) makes the `.mdv` file unpleasant to
 * read in a plain text editor, which defeats the point of a text format.
 *
 * The rules below are the inverse of the reader's backslash handling, so
 * `read(write(x))` is stable for any run text whatsoever, including text that
 * looks like markup.
 */

/** Context that changes what must be escaped. */
export interface EscapeContext {
  /** The text begins a line, so line-leading constructs must be neutralised. */
  readonly atLineStart: boolean;
  /** The text sits inside a GFM table cell, where `|` ends the cell. */
  readonly inTable: boolean;
}

const ENTITY = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

function isAlphanumeric(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[\p{L}\p{N}]/u.test(character);
}

/**
 * Escape run text for emission inside a paragraph, heading or table cell.
 *
 * Always escaped: `\`, `` ` ``, `*`, `[`, `]`, `<`.
 * Conditionally escaped: `_` (only when it could open or close emphasis, i.e.
 * not between two alphanumerics), `~` (only in a run of two or more), `!` (only
 * before `[`), `&` (only when it starts a character reference), `|` (only in a
 * table), and the line-leading block starters.
 */
export function escapeInline(text: string, context: EscapeContext): string {
  let out = '';
  let lineStart = context.atLineStart;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;

    if (character === '\n') {
      out += '\n';
      lineStart = true;
      continue;
    }

    if (lineStart) {
      const escaped = escapeLineStart(text, index);
      if (escaped !== null) {
        out += escaped.text;
        index += escaped.consumed - 1;
        lineStart = false;
        continue;
      }
    }

    switch (character) {
      case '\\':
      case '`':
      case '*':
      case '[':
      case ']':
      case '<':
        out += `\\${character}`;
        break;
      case '_':
        out += isAlphanumeric(text[index - 1]) && isAlphanumeric(text[index + 1]) ? '_' : '\\_';
        break;
      case '~':
        out += text[index + 1] === '~' || text[index - 1] === '~' ? '\\~' : '~';
        break;
      case '!':
        out += text[index + 1] === '[' ? '\\!' : '!';
        break;
      case '&':
        out += ENTITY.test(text.slice(index)) ? '\\&' : '&';
        break;
      case '|':
        out += context.inTable ? '\\|' : '|';
        break;
      case '$':
        // `$…$` is MDV math (SPEC 4). Escape a `$` that could open a span.
        out += text.includes('$', index + 1) ? '\\$' : '$';
        break;
      default:
        out += character;
    }
    if (character !== ' ' && character !== '\t') lineStart = false;
  }

  return out;
}

/**
 * If a block construct starts at `index`, return its escaped spelling and how
 * many source characters it consumed. Otherwise `null`.
 */
function escapeLineStart(text: string, index: number): { text: string; consumed: number } | null {
  const character = text[index];
  if (character === undefined) return null;
  if (character === '#' || character === '>' || character === '=') {
    return { text: `\\${character}`, consumed: 1 };
  }
  if (character === '-' || character === '+') {
    return { text: `\\${character}`, consumed: 1 };
  }
  if (character === ':' && text.startsWith(':::', index)) {
    return { text: '\\:::', consumed: 3 };
  }
  const ordered = /^(\d{1,9})([.)])/.exec(text.slice(index));
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
    return { text: `${ordered[1]}\\${ordered[2]}`, consumed: ordered[0].length };
  }
  return null;
}

/** ASCII punctuation that CommonMark allows a backslash to escape. */
const ESCAPABLE = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

/** Resolve backslash escapes in reader input. */
export function unescapeInline(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === '\\') {
      const next = text[index + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        out += next;
        index += 1;
        continue;
      }
    }
    out += character;
  }
  return out;
}

/** Escape text for a fenced code block's info string or an image title. */
export function escapeQuoted(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape a link or image destination.
 *
 * Angle-bracket form is used when the destination contains a space or an
 * unbalanced parenthesis; `data:` URIs never need it, which is the common case
 * here because images are embedded.
 */
export function escapeDestination(destination: string): string {
  if (destination === '') return '<>';
  let depth = 0;
  let balanced = true;
  for (const character of destination) {
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth < 0) balanced = false;
    }
  }
  if (depth !== 0) balanced = false;
  if (!/[\s<>]/.test(destination) && balanced) return destination;
  return `<${destination.replace(/([<>\\])/g, '\\$1')}>`;
}
