/**
 * A small, forgiving HTML parser.
 *
 * The engine cannot use `DOMParser`: it must run in Node for tests and must not
 * depend on the host document. It also cannot use a library, because the engine
 * has no dependencies. So it parses the HTML itself.
 *
 * This is *not* an HTML5-conformant parser and does not try to be. It is a
 * tokeniser plus a stack with the handful of implied-end-tag rules that real
 * clipboard payloads actually exercise, which is enough to read what Word,
 * Google Docs, Notion, GitHub and every CMS on earth put on the clipboard.
 * Anything it cannot make sense of degrades to text rather than throwing.
 *
 * Notably handled, because the real world contains them:
 * - comments, including Word's `<!--[if gte mso 9]>` conditional blocks;
 * - `<style>` and `<script>` bodies, which are raw text and must not be parsed;
 * - unclosed `<p>` and `<li>`, which are the norm rather than the exception;
 * - stray close tags, which are ignored instead of unwinding the tree;
 * - namespaced Word tags such as `<o:p>`.
 */

/** A parsed element. Attribute names are lower-cased; values are decoded. */
export interface HtmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly HtmlNode[];
}

/** A run of character data, with entities already decoded. */
export interface HtmlText {
  readonly kind: 'text';
  readonly text: string;
}

/** A node in the parsed tree. */
export type HtmlNode = HtmlElement | HtmlText;

/** Elements that never have children and never need a close tag. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'basefont',
  'br',
  'col',
  'command',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'isindex',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Elements whose content is raw text, not markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

/** Elements dropped wholesale, content and all. */
const DISCARDED_ELEMENTS = new Set([
  'script',
  'style',
  'head',
  'meta',
  'link',
  'title',
  'noscript',
]);

/**
 * Implied end tags: opening the key closes any of the values still open,
 * searching no further up than a boundary element.
 */
const IMPLIED_END: Readonly<Record<string, readonly string[]>> = {
  p: ['p'],
  li: ['li', 'p'],
  dt: ['dt', 'dd', 'p'],
  dd: ['dt', 'dd', 'p'],
  td: ['td', 'th', 'p'],
  th: ['td', 'th', 'p'],
  tr: ['td', 'th', 'tr', 'p'],
  thead: ['td', 'th', 'tr', 'p'],
  tbody: ['td', 'th', 'tr', 'thead', 'p'],
  tfoot: ['td', 'th', 'tr', 'thead', 'tbody', 'p'],
  option: ['option', 'p'],
  optgroup: ['option', 'optgroup'],
  // Block-level openers close an open paragraph, per the HTML5 parser.
  div: ['p'],
  blockquote: ['p'],
  pre: ['p'],
  ul: ['p'],
  ol: ['p'],
  table: ['p'],
  h1: ['p'],
  h2: ['p'],
  h3: ['p'],
  h4: ['p'],
  h5: ['p'],
  h6: ['p'],
  hr: ['p'],
  section: ['p'],
  article: ['p'],
  aside: ['p'],
  header: ['p'],
  footer: ['p'],
  nav: ['p'],
  main: ['p'],
  figure: ['p'],
  form: ['p'],
  address: ['p'],
  fieldset: ['p'],
  dl: ['p'],
};

/** Elements an implied close is not allowed to escape from. */
const SCOPE_BOUNDARY = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'ul',
  'ol',
  'li',
  'blockquote',
]);

/**
 * An element while it is still being filled in.
 *
 * Structurally an {@link HtmlElement} — the discriminant included, so that a
 * finished node really does answer `kind === 'element'` and not merely satisfy
 * a cast.
 */
interface MutableElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly children: HtmlNode[];
}

/**
 * Parse an HTML fragment.
 *
 * Never throws. Returns the top-level nodes; `<html>`, `<body>` and Word's
 * fragment markers are preserved as ordinary elements and unwrapped later by
 * the converter, which is the layer that knows what to do with them.
 */
export function parseHtml(source: string): readonly HtmlNode[] {
  const root: MutableElement = { kind: 'element', name: '#root', attrs: {}, children: [] };
  const stack: MutableElement[] = [root];
  const top = (): MutableElement => stack[stack.length - 1] ?? root;

  let index = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end <= textStart) return;
    const text = decodeEntities(source.slice(textStart, end));
    if (text !== '') top().children.push({ kind: 'text', text });
  };

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt < 0) break;

    // A `<` that cannot start a tag is literal text; leave it in the run.
    const next = source[lt + 1];
    if (
      next === undefined ||
      !(isNameStart(next) || next === '/' || next === '!' || next === '?')
    ) {
      index = lt + 1;
      continue;
    }

    flushText(lt);

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      index = end < 0 ? source.length : end + 3;
      textStart = index;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = source.indexOf('>', lt);
      index = end < 0 ? source.length : end + 1;
      textStart = index;
      continue;
    }

    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      const stop = end < 0 ? source.length : end;
      const name = normalizeName(source.slice(lt + 2, stop));
      closeElement(stack, name);
      index = end < 0 ? source.length : end + 1;
      textStart = index;
      continue;
    }

    const tag = readTag(source, lt);
    if (!tag) {
      index = lt + 1;
      continue;
    }
    index = tag.end;
    textStart = index;

    const { name, attrs, selfClosing } = tag;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeTag = `</${name}`;
      const close = indexOfInsensitive(source, closeTag, index);
      const body = source.slice(index, close < 0 ? source.length : close);
      if (!DISCARDED_ELEMENTS.has(name)) {
        top().children.push({
          kind: 'element',
          name,
          attrs,
          children: [{ kind: 'text', text: body }],
        });
      }
      if (close < 0) {
        index = source.length;
      } else {
        const gt = source.indexOf('>', close);
        index = gt < 0 ? source.length : gt + 1;
      }
      textStart = index;
      continue;
    }

    for (const closable of IMPLIED_END[name] ?? []) {
      closeIfOpen(stack, closable);
    }

    if (selfClosing || VOID_ELEMENTS.has(name)) {
      if (!DISCARDED_ELEMENTS.has(name)) {
        top().children.push({ kind: 'element', name, attrs, children: [] });
      }
      continue;
    }

    const element: MutableElement = { kind: 'element', name, attrs, children: [] };
    top().children.push(freezeLater(element));
    stack.push(element);
  }

  flushText(source.length);
  return root.children;
}

/** Concatenated text of a node and its descendants, entities already decoded. */
export function textContent(node: HtmlNode): string {
  if (node.kind === 'text') return node.text;
  let out = '';
  for (const child of node.children) out += textContent(child);
  return out;
}

/** Concatenated text of a list of nodes. */
export function nodesText(nodes: readonly HtmlNode[]): string {
  let out = '';
  for (const node of nodes) out += textContent(node);
  return out;
}

/**
 * Parse an inline `style` attribute into a lower-cased property map.
 *
 * Values keep their case (font families and URLs need it) but are trimmed.
 * Malformed declarations are skipped rather than poisoning the whole map.
 */
export function parseStyle(style: string | undefined): Readonly<Record<string, string>> {
  if (!style) return {};
  const out: Record<string, string> = {};
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon <= 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (property === '') continue;
    out[property] = value;
  }
  return out;
}

/** Split a `class` attribute into its tokens. */
export function classList(element: HtmlElement): readonly string[] {
  const value = element.attrs['class'];
  if (!value) return [];
  return value.split(/\s+/).filter((token) => token !== '');
}

/* -------------------------------------------------------------------------- */

interface Tag {
  readonly name: string;
  readonly attrs: Record<string, string>;
  readonly selfClosing: boolean;
  readonly end: number;
}

function readTag(source: string, start: number): Tag | undefined {
  let index = start + 1;
  const nameStart = index;
  while (index < source.length && isNameChar(source[index] ?? '')) index += 1;
  if (index === nameStart) return undefined;
  const name = normalizeName(source.slice(nameStart, index));

  const attrs: Record<string, string> = {};
  let selfClosing = false;

  while (index < source.length) {
    while (index < source.length && isSpace(source[index] ?? '')) index += 1;
    const char = source[index];
    if (char === undefined) break;
    if (char === '>') {
      index += 1;
      break;
    }
    if (char === '/') {
      selfClosing = true;
      index += 1;
      continue;
    }

    const attrStart = index;
    while (
      index < source.length &&
      !isSpace(source[index] ?? '') &&
      source[index] !== '=' &&
      source[index] !== '>' &&
      source[index] !== '/'
    ) {
      index += 1;
    }
    if (index === attrStart) {
      index += 1;
      continue;
    }
    const attrName = source.slice(attrStart, index).toLowerCase();

    while (index < source.length && isSpace(source[index] ?? '')) index += 1;
    if (source[index] !== '=') {
      if (!(attrName in attrs)) attrs[attrName] = '';
      continue;
    }
    index += 1;
    while (index < source.length && isSpace(source[index] ?? '')) index += 1;

    const quote = source[index];
    let value: string;
    if (quote === '"' || quote === "'") {
      index += 1;
      const close = source.indexOf(quote, index);
      const stop = close < 0 ? source.length : close;
      value = source.slice(index, stop);
      index = close < 0 ? source.length : close + 1;
    } else {
      const valueStart = index;
      while (index < source.length && !isSpace(source[index] ?? '') && source[index] !== '>')
        index += 1;
      value = source.slice(valueStart, index);
    }
    if (!(attrName in attrs)) attrs[attrName] = decodeEntities(value);
  }

  return { name, attrs, selfClosing, end: index };
}

function closeElement(stack: MutableElement[], name: string): void {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    if (stack[i]?.name === name) {
      stack.length = i;
      return;
    }
  }
  // A close tag with no matching open is noise; dropping it is strictly better
  // than unwinding the tree, which is how naive parsers lose whole documents.
}

function closeIfOpen(stack: MutableElement[], name: string): void {
  for (let i = stack.length - 1; i > 0; i -= 1) {
    const current = stack[i];
    if (!current) return;
    if (current.name === name) {
      stack.length = i;
      return;
    }
    if (SCOPE_BOUNDARY.has(current.name)) return;
  }
}

/**
 * The mutable builder node and the frozen public node share an identity.
 *
 * Children are pushed after the parent has already been attached, so the
 * builder hands out the same object and simply relies on `HtmlElement`'s
 * `readonly` members to keep consumers honest.
 */
function freezeLater(element: MutableElement): HtmlElement {
  // A widening, not a lie: the mutable form is the same shape with a mutable
  // child list, which is still being appended to while parsing continues.
  return element;
}

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isNameStart(char: string): boolean {
  return /[A-Za-z]/.test(char);
}

function isNameChar(char: string): boolean {
  return /[A-Za-z0-9:._-]/.test(char);
}

function indexOfInsensitive(source: string, needle: string, from: number): number {
  return source.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/* -------------------------------------------------------------------------- */
/* Entities                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The named entities that actually appear in clipboard HTML.
 *
 * The full HTML5 table has 2231 entries and would be a kilobyte of dead weight
 * in every bundle. Unknown names are left verbatim, which is what a browser
 * does with an unterminated entity anyway.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  laquo: '«',
  raquo: '»',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  permil: '‰',
  larr: '←',
  uarr: '↑',
  rarr: '→',
  darr: '↓',
  harr: '↔',
  ne: '≠',
  le: '≤',
  ge: '≥',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  emsp: ' ',
  ensp: ' ',
  thinsp: ' ',
  shy: '­',
  zwnj: '‌',
  zwj: '‍',
  lrm: '‎',
  rlm: '‏',
};

/** Decode numeric and known named character references. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    /&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (match, body: string) => {
      if (body.startsWith('#')) {
        const isHex = body[1] === 'x' || body[1] === 'X';
        const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        // Surrogate halves are not valid scalar values; a browser substitutes
        // U+FFFD rather than producing a lone surrogate, and so do we.
        if (code >= 0xd800 && code <= 0xdfff) return '�';
        return String.fromCodePoint(code);
      }
      return ENTITIES[body] ?? match;
    },
  );
}

/** Escape text for insertion into HTML character data or a quoted attribute. */
export function escapeHtml(text: string): string {
  let out = '';
  for (const char of text) {
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '"') out += '&quot;';
    else out += char;
  }
  return out;
}
