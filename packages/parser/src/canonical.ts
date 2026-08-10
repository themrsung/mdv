/**
 * Canonical AST serialisation (SPEC 19).
 *
 * > For test fixtures the AST is serialised with sorted object keys, `position`
 * > reduced to `[startOffset, endOffset]`, and floats formatted to 6 significant
 * > digits, so `expected.ast.json` diffs are meaningful.
 *
 * The three rules exist to make the fixture corpus a usable review artefact: key
 * order stops being an accident of construction, positions stop dominating the
 * diff, and a float whose last bits differ between engines stops failing a test
 * that is not about floats.
 */

import { compareStrings } from './internal/source.js';

/** Keys whose whole value is source coordinates, dropped when positions are off. */
const POSITIONAL: ReadonlySet<string> = new Set(['range', 'attrsPosition', 'mdvAttrsPosition']);

/** Options for {@link canonicalAst}. */
export interface CanonicalOptions {
  /**
   * Include `position`, reduced to `[startOffset, endOffset]`.
   *
   * @defaultValue true — the SPEC 19 form. Pass `false` to compare two trees
   * that describe the same document but were laid out differently, which is how
   * the round-trip property is checked.
   */
  positions?: boolean;
  /**
   * Indentation for the emitted JSON.
   *
   * @defaultValue 2
   */
  indent?: number;
}

/** Serialise any AST node or document to the canonical JSON form of SPEC 19. */
export function canonicalAst(value: unknown, options: CanonicalOptions = {}): string {
  const positions = options.positions ?? true;
  const indent = options.indent ?? 2;
  return JSON.stringify(canonicalValue(value, positions), null, indent);
}

/** The canonical form as data, for structural comparison without re-parsing. */
export function canonicalValue(value: unknown, positions = true): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return canonicalNumber(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, positions));
  if (typeof value !== 'object') return String(value);

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort(compareStrings)) {
    const entry = source[key];
    if (entry === undefined) continue;
    if (key === 'position') {
      if (!positions) continue;
      out[key] = canonicalPosition(entry);
      continue;
    }
    // Every other carrier of source coordinates: `Diagnostic.range`,
    // `FrontMatter.range`, the per-key maps on blocks and directives, and the
    // `data.mdvAttrsPosition` a GFM table carries (SPEC 10.2).
    if (!positions && POSITIONAL.has(key)) continue;
    out[key] = canonicalValue(entry, positions);
  }
  return out;
}

/** `position` collapses to `[startOffset, endOffset]` (SPEC 19). */
function canonicalPosition(value: unknown): unknown {
  const position = value as
    { start?: { offset?: unknown }; end?: { offset?: unknown } } | null | undefined;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number') return null;
  return [start, end];
}

/**
 * Floats to six significant digits; integers are left exact.
 *
 * `toPrecision` then `Number` rather than string formatting, so the value stays
 * a JSON number and `1.5` does not become `"1.50000"`.
 */
function canonicalNumber(value: number): number | string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value;
  return Number(value.toPrecision(6));
}
