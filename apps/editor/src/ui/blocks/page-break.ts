/**
 * The editor's page-break affordance (SPEC 28.4).
 *
 * A `:::mdv-page` container arrives in the UI as a `raw` block: the engine keeps
 * every container verbatim so that nothing inside is reinterpreted, and writes
 * it back byte for byte (`engine/io/read.ts`). Drawing a page break as a slab of
 * source is honest and useless — the one thing an author wants to see is where
 * the page ends — so the *view* recognises the directive and draws a page rule
 * while the *document* keeps the original bytes.
 *
 * The recognition is a pure function over the block's text, which is why it
 * lives here rather than inside the component: the rule is specified by tests,
 * and `BlockView` only decides what to draw with the answer.
 *
 * Nothing here rewrites the source. An unreadable or unrecognised directive
 * returns `null` and falls back to the raw view, which is the safe direction to
 * fail in — the author still sees, and can still fix, exactly what they wrote.
 */

/** Where the break falls, per SPEC 28.4. */
export type PageBreakEdge = 'before' | 'after' | 'avoid';

/** What the view needs to draw a `:::mdv-page` directive. */
export interface PageBreakView {
  /** The `break` attribute, or `null` when absent or unrecognised (SPEC 15.2). */
  readonly edge: PageBreakEdge | null;
  /** The `orientation` attribute, or `null` when absent or unrecognised. */
  readonly orientation: 'portrait' | 'landscape' | null;
  /** The `size` attribute verbatim (any `pdf.pageSize` value), or `null`. */
  readonly size: string | null;
  /** The source between the markers, `''` for the marker form. */
  readonly body: string;
  /** `true` when the directive wraps content — the form `break=avoid` needs. */
  readonly wrapping: boolean;
  /** A one-line summary for the rule's label and its accessible name. */
  readonly label: string;
}

/** `:::mdv-page`, with the optional label and attribute block of SPEC 9.1. */
const OPEN = /^(:{3,})mdv-page(?:\[[^\]]*\])?[ \t]*(?:\{([^}]*)\})?[ \t]*$/;

/**
 * Read the attribute block. Quotes are honoured because the grammar allows them
 * (`size="US Legal"`); bare tokens without a `=` are skipped rather than
 * guessed at, and a repeated key takes its last value, both matching the parser.
 */
function attributes(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
    if (index >= text.length) break;
    const key = /^([A-Za-z][A-Za-z0-9_-]*)=/.exec(text.slice(index));
    if (!key || key[1] === undefined) {
      while (index < text.length && !/\s/.test(text[index] ?? '')) index += 1;
      continue;
    }
    index += key[0].length;
    const quote = text[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let value = '';
      while (index < text.length && text[index] !== quote) {
        if (quote === '"' && text[index] === '\\' && text[index + 1] !== undefined) {
          value += text[index + 1];
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      index += 1;
      out.set(key[1], value);
      continue;
    }
    let end = index;
    while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1;
    out.set(key[1], text.slice(index, end));
    index = end;
  }
  return out;
}

/** Sentence case, for a label that may begin with an attribute value. */
function capitalise(text: string): string {
  return text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

function describe(view: Omit<PageBreakView, 'label'>): string {
  const parts: string[] = [];
  if (view.edge === 'before') parts.push('Page break');
  if (view.edge === 'after') parts.push('Page break after');
  // `avoid` says nothing about a marker with no content to keep (SPEC 28.4).
  if (view.edge === 'avoid' && view.wrapping) parts.push('Keep together');
  const geometry = [view.size, view.orientation].filter((part) => part !== null).join(' ');
  if (geometry !== '') parts.push(`${capitalise(geometry)} from here`);
  return parts.length === 0 ? 'Page' : parts.join(' · ');
}

/**
 * Recognise a `:::mdv-page` raw block, or return `null` for anything else.
 *
 * An unclosed directive — the opening line alone, which is what the reader hands
 * over when the close is missing — is still a page break: the author has typed
 * enough to mean one, and refusing to draw it would punish them mid-keystroke.
 */
export function readPageBreak(text: string): PageBreakView | null {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const open = OPEN.exec(first);
  if (!open) return null;

  const marker = open[1] ?? ':::';
  const last = lines.length > 1 ? (lines[lines.length - 1] ?? '') : '';
  const closed = lines.length > 1 && new RegExp(`^:{${String(marker.length)},}[ \t]*$`).test(last);
  const body = closed ? lines.slice(1, -1).join('\n') : lines.slice(1).join('\n');

  const attrs = attributes(open[2] ?? '');
  const edge = attrs.get('break');
  const orientation = attrs.get('orientation');
  const size = attrs.get('size');
  // Annotated, not inferred: narrowing a `string` still widens back to `string`
  // in a fresh object literal, and the closed sets are the whole point here.
  const shape: Omit<PageBreakView, 'label'> = {
    edge: edge === 'before' || edge === 'after' || edge === 'avoid' ? edge : null,
    orientation: orientation === 'portrait' || orientation === 'landscape' ? orientation : null,
    size: size === undefined || size === '' ? null : size,
    body,
    wrapping: body.trim() !== '',
  };
  return { ...shape, label: describe(shape) };
}
