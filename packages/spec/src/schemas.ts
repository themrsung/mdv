/**
 * The Appendix D JSON Schemas, published as values rather than as files.
 *
 * SPEC Appendix D says the schemas in `schemas/` are "the single source of truth
 * for attribute validation, LSP completion, and the attribute documentation in
 * this appendix". A file on disk is only the first of those three: a language
 * server running in a browser worker has no disk, and a bundler has no reason to
 * copy a `.json` nobody imports. So the block schema is imported here and the
 * three things a tool asks of it — which keys exist, which values are closed,
 * and what one key means — are answered by accessors.
 *
 * The rendering is deliberate. {@link attrDoc} returns MDV's own attribute
 * syntax, not JSON: an author reading a hover is looking at `padding: {top: 16}`
 * in their editor, and a doc that answered `{"top":16}` would be describing a
 * different language. Doing it here rather than in `@mdv/lsp` is what lets that
 * server stay a translator (SPEC 29.4) — and what makes the CLI's `explain` and
 * the appendix generator agree with it by construction.
 *
 * There is still no logic here in the sense SPEC 17.2 forbids: nothing decides
 * anything about a document. These functions read a data file out loud.
 */

import rawBlockSchema from '../schemas/common/block.json';
import type { AttrDoc, BlockSchema, SchemaNode } from './types.js';

/** `schemas/common/block.json`: the attributes every block type accepts. */
export const BLOCK_SCHEMA: BlockSchema = rawBlockSchema as unknown as BlockSchema;

const PROPERTIES: Readonly<Record<string, SchemaNode>> = BLOCK_SCHEMA.properties;

/** The basename of a sibling reference: `"./dimension.json"` → `"dimension"`. */
const REF_NAME = /([A-Za-z0-9-]+)\.json$/u;

/**
 * A scalar that needs no quoting in a header line. Deliberately narrow — a
 * value with a `:`, a `#` or a leading `[` is quoted rather than reasoned about,
 * because a doc comment is a bad place to discover an edge of the syntax.
 *
 * Both patterns sit above {@link CLOSED_VALUES} because that constant renders
 * values as it is initialised, and a `const` below it would not exist yet.
 */
const PLAIN = /^[A-Za-z0-9_.+%/=-]+(?: [A-Za-z0-9_.+%/=-]+)*$/u;

/**
 * Every common attribute, in schema order.
 *
 * Schema order is Appendix D's order, which groups the keys the way an author
 * writes them — identity, then data, then size, then style — so a completion
 * list that keeps it is already sorted usefully.
 */
export const COMMON_ATTRS: readonly string[] = Object.freeze(Object.keys(PROPERTIES));

/** The subschema for one common attribute, or `undefined` if there is no such key. */
export function attrSchema(name: string): SchemaNode | undefined {
  return Object.hasOwn(PROPERTIES, name) ? PROPERTIES[name] : undefined;
}

/**
 * The attributes whose value comes from a closed set, mapped to that set.
 *
 * A boolean counts: it is an enum of two, and an author completing `animate:`
 * wants `true` and `false` offered like any other pair of words. Values are
 * rendered as they are written in a header, so the boolean `false` in `legend`'s
 * enum and the string `"false"` would both read `false` — which is exactly the
 * distinction an author does not have to make.
 */
export const CLOSED_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PROPERTIES).flatMap(([name, node]) => {
      const values = closedValuesOf(node);
      return values === undefined ? [] : [[name, values] as [string, readonly string[]]];
    }),
  ),
);

/**
 * Appendix D's documentation for one attribute: its type, its default, its
 * prose, and one line showing it written down.
 *
 * @returns `undefined` for a key the schema does not define — including an `x-`
 * extension key, which the schema allows precisely because it says nothing
 * about what it means.
 */
export function attrDoc(name: string): AttrDoc | undefined {
  const node = attrSchema(name);
  if (node === undefined) return undefined;
  const values = CLOSED_VALUES[name];
  const example = node.examples?.[0];
  return {
    name,
    type: typeText(node),
    ...(values === undefined ? {} : { values }),
    ...(node.default === undefined ? {} : { default: inlineText(node.default) }),
    ...(node.description === undefined ? {} : { description: node.description }),
    ...(example === undefined ? {} : { example: `${name}: ${inlineText(example)}` }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function refName(ref: string): string {
  return REF_NAME.exec(ref)?.[1] ?? ref;
}

function unionText(parts: readonly string[]): string {
  return [...new Set(parts)].join(' | ');
}

/** How a value is written in a header: bare when it can be, quoted when not. */
function scalarText(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  return PLAIN.test(value) ? value : `'${value.replaceAll("'", "''")}'`;
}

/** A whole value on one line, in the flow form a header attribute takes. */
function inlineText(value: unknown): string {
  if (Array.isArray(value)) return `[${(value as readonly unknown[]).map(inlineText).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const pairs = Object.entries(value).map(([key, member]) => `${key}: ${inlineText(member)}`);
    return `{${pairs.join(', ')}}`;
  }
  return scalarText(value);
}

/** The type of a node, named the way the schema names it. */
function typeText(node: SchemaNode): string {
  if (node.$ref !== undefined) return refName(node.$ref);
  if (node.enum !== undefined) return unionText(node.enum.map(scalarText));
  if (node.const !== undefined) return scalarText(node.const);
  const branches = node.oneOf ?? node.anyOf;
  if (branches !== undefined) return unionText(branches.map(typeText));
  if (node.type === 'array') {
    const items = node.items === undefined ? 'any' : typeText(node.items);
    // `(a | b)[]` — an array of a union is not a union of an array.
    return items.includes(' | ') ? `(${items})[]` : `${items}[]`;
  }
  if (typeof node.type === 'string') return node.type;
  return node.type === undefined ? 'any' : unionText(node.type);
}

/**
 * Every literal this node accepts, or `undefined` when it accepts open values.
 * Branches are searched one level deep, which is as deep as Appendix D nests a
 * closed set.
 */
function closedValuesOf(node: SchemaNode): readonly string[] | undefined {
  const values: string[] = [];
  const collect = (branch: SchemaNode): void => {
    if (branch.enum !== undefined) values.push(...branch.enum.map(scalarText));
    if (branch.type === 'boolean') values.push('true', 'false');
  };
  collect(node);
  for (const branch of node.oneOf ?? []) collect(branch);
  for (const branch of node.anyOf ?? []) collect(branch);
  return values.length === 0 ? undefined : Object.freeze([...new Set(values)]);
}
