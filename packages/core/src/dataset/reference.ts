/**
 * Dataset ids and `@` references (SPEC 6.3).
 *
 * ```yaml
 * data: "@sales"
 * data: "@sales[date, revenue]"
 * ```
 *
 * Parsing lives apart from the registry because a reference is a *syntactic*
 * thing: it can be read, validated and keyed long before anyone knows whether
 * the dataset it names exists. That separation is what makes two-pass resolution
 * possible — a block records what it asked for, and the lookup happens later.
 */

/** `id` MUST match this (SPEC 6.3). */
export const DATASET_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

/**
 * Synthetic ids for inline data sections are `#block-3` (SPEC 6.1, `TableRef`).
 * They cannot collide with an author's id because `#` is not a legal first
 * character.
 */
export const SYNTHETIC_ID_PATTERN = /^#[A-Za-z0-9_-]+$/u;

/** `true` when `id` is a legal author-written dataset id. */
export function isDatasetId(id: string): boolean {
  return DATASET_ID_PATTERN.test(id);
}

/** `true` when `id` is either an author id or a generated one. */
export function isUsableId(id: string): boolean {
  return isDatasetId(id) || SYNTHETIC_ID_PATTERN.test(id);
}

/** A parsed `@id[projection]`. */
export interface DatasetReference {
  id: string;
  /** Field projection, in the listed order. Absent when none was written. */
  projection?: readonly string[];
}

/** `true` when a `data:` value looks like a reference rather than inline data. */
export function isReference(text: string): boolean {
  return text.trimStart().startsWith('@');
}

/**
 * Parse `@sales`, `@sales[date, revenue]` or `@sales[[Net revenue (USD)]]`.
 *
 * A field name that contains a comma or a bracket is written bracketed, the same
 * escape SPEC 6.1.2 gives field references elsewhere; scanning tracks depth so
 * the inner brackets do not end the projection.
 *
 * @returns `undefined` when the text is not a well-formed reference. The caller
 * emits `MDV2142` — this function never reports, so it can also be used to *ask*
 * whether something is a reference.
 */
export function parseReference(text: string): DatasetReference | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('@')) return undefined;

  const open = trimmed.indexOf('[');
  if (open === -1) {
    const id = trimmed.slice(1);
    return isUsableId(id) ? { id } : undefined;
  }

  const id = trimmed.slice(1, open).trim();
  if (!isUsableId(id)) return undefined;
  if (!trimmed.endsWith(']')) return undefined;

  const inner = trimmed.slice(open + 1, trimmed.length - 1);
  const projection = splitProjection(inner);
  if (projection === undefined || projection.length === 0) return undefined;
  return { id, projection };
}

/** Split on top-level commas, honouring bracket nesting. */
function splitProjection(inner: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (char === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return undefined;
  parts.push(inner.slice(start));

  const names: string[] = [];
  for (const part of parts) {
    const name = unbracket(part.trim());
    if (name === '') return undefined;
    names.push(name);
  }
  return names;
}

/** `[Net revenue (USD)]` → `Net revenue (USD)`; anything else is returned as-is. */
function unbracket(text: string): string {
  if (text.length >= 2 && text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** Render a reference back to its source form; `parseReference` round-trips it. */
export function formatReference(ref: DatasetReference): string {
  if (ref.projection === undefined || ref.projection.length === 0) return `@${ref.id}`;
  const fields = ref.projection.map((name) => (/[,[\]]/u.test(name) ? `[${name}]` : name));
  return `@${ref.id}[${fields.join(', ')}]`;
}
