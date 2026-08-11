/**
 * Where a block writes column names (SPEC 6.2, 6.7, 7.1.2).
 *
 * The counterpart of `dataset/locate.ts`: that file answers "where does this
 * document write this dataset id", this one answers "where does this block
 * write this column name". They exist for the same reason — a rename is
 * find-references with the answer written back, so the set of places has to be
 * decided once, by the package that owns the language, and not a second time by
 * every tool that offers the edit.
 *
 * A column name is written in two kinds of place:
 *
 * - **once** as a header cell in the data section, which is the declaration;
 * - **any number of times** as a reference — a channel binding, a transform
 *   argument, a field inside an expression.
 *
 * Between the two stands the pipeline, because a name only reaches a channel if
 * the transforms let it through: `select: [date]` drops `revenue`, `aggregate`
 * keeps only what it groups and what it aggregates, and `rename` gives the
 * column a different name from that step onward. So the reference half walks
 * the pipeline and stops at the step where the name stops meaning this column;
 * the channels are read only when it survives to the end. A reference after
 * that point names something else that happens to be spelled the same, and
 * rewriting it would be a bug with the author's name on it.
 *
 * The scope is one block, which is the scope SPEC 29.4's rename row gives:
 * "within a block, column names". A block whose rows come from `from:` or
 * `src:` has no header of its own to rename and reports nothing, because the
 * references that would have to move with it are in other blocks this file
 * cannot see.
 */

import type { AttrMap, AttrValue, MdvBlock, Range } from '@mdv/parser';

import { detectFormat } from './detect.js';
import { firstChar } from './parse-section.js';
import { isBlank, splitLines, stripBom } from './raw.js';
import { rangeOfNode } from './diag.js';
import { scanDelimited } from './csv.js';
import { splitPipeRow } from './table-format.js';
import { CHANNEL_NAMES } from '../cascade.js';
import { fieldRefs } from '../expr/locate.js';

/**
 * What kind of text a column name was written as, which decides what a
 * replacement is allowed to look like.
 */
export type ColumnSiteKind =
  /** A cell of the header row, in the data section. */
  | 'header'
  /** An attribute value: `y: revenue`, `select: [revenue]`, `sort: [-revenue]`. */
  | 'attribute'
  /** A bare identifier inside an expression, which only a bare name can replace. */
  | 'identifier'
  /** A bracketed `[Net revenue]` inside an expression, which can spell anything. */
  | 'bracket';

/**
 * One place a column name is written.
 *
 * The `{range, text, offset}` triple is {@link DatasetSite}'s, and means the
 * same thing: `text` is what to look for inside the source spanned by `range`,
 * and `offset` is where the name starts inside `text`. A negative `offset`
 * marks a site that is written somewhere the parser records no range for — a
 * mapping key — so an exact edit is impossible and the caller must decline
 * rather than guess.
 */
export interface ColumnSite {
  readonly name: string;
  readonly kind: ColumnSiteKind;
  /** The `attrsPosition` path, or `#header` for the header cell. */
  readonly path: string;
  readonly range: Range;
  readonly text: string;
  readonly offset: number;
}

/** Every place one header column is written, the header cell first. */
export interface ColumnLocation {
  readonly name: string;
  /** Index of the header cell, so a caller can order columns as written. */
  readonly index: number;
  readonly sites: readonly ColumnSite[];
}

/** The columns one block declares, and what a new name for one may look like. */
export interface ColumnMap {
  readonly columns: readonly ColumnLocation[];
  /**
   * The character that separates the header cells (`,`, a TAB, or `|`).
   *
   * A name containing it would split into two cells, so it is the one
   * forbidden character that depends on how the section is written.
   */
  readonly delimiter: string;
}

/** The header cell path: not an attribute, and not a path any attribute has. */
export const HEADER_PATH = '#header';

/**
 * What a path wears when the name is a mapping *key*: `transform[0].rename.x`
 * is where the new name is written, `transform[0].rename.x#key` is where the
 * old one is. The parser records ranges for values only, so the second never
 * resolves — which is the point, and why it must not be spelled like the first.
 */
export const KEY_PATH = '#key';

/** Bare names, as `lex.ts` scans them (SPEC 6.8). */
const BARE_NAME = /^[A-Za-z_$][A-Za-z_$0-9]*$/u;

/** Words the expression grammar reads as literals before it reads them as fields. */
const KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'null']);

/**
 * Every column this block declares in its own data section, and everywhere the
 * block writes each name.
 *
 * `undefined` when the block declares no columns anywhere this file can point
 * at: no data section, rows that come from somewhere else or that an `id:`
 * hands to the rest of the document, `header: false`,
 * names supplied by `columns:` rather than by the text, or a format whose names
 * are not all on one line (`json`, `ndjson`, `columns`) or absent entirely
 * (`matrix`).
 */
export function locateColumns(block: MdvBlock): ColumnMap | undefined {
  const header = readHeader(block);
  if (header === undefined) return undefined;

  // A name written twice in one header does not identify a column: the reader
  // de-duplicates them and a reference reaches only one. Neither cell is safe
  // to rewrite, so both are dropped.
  const seen = new Map<string, number>();
  for (const cell of header.cells) seen.set(cell.name, (seen.get(cell.name) ?? 0) + 1);

  const columns: ColumnLocation[] = [];
  for (const [index, cell] of header.cells.entries()) {
    if (cell.name === '') continue;
    if (seen.get(cell.name) !== 1) continue;
    const sites: ColumnSite[] = [
      {
        name: cell.name,
        kind: 'header',
        path: HEADER_PATH,
        range: header.range,
        text: header.line,
        offset: cell.offset,
      },
    ];
    collectReferences(block, cell.name, sites);
    columns.push({ name: cell.name, index, sites });
  }

  return { columns, delimiter: header.delimiter };
}

/**
 * Why `newName` cannot replace `name`, or `undefined` when it can.
 *
 * The rules are the grammar's, not an editor's: a name has to survive being
 * read back out of the header row, and out of every reference as it is written
 * — a bare identifier in an expression cannot become two words without also
 * gaining brackets, which is an edit this rename does not make.
 */
export function checkColumnName(map: ColumnMap, name: string, newName: string): string | undefined {
  const column = map.columns.find((entry) => entry.name === name);
  if (column === undefined) return `\`${name}\` is not a column of this block`;
  if (newName === name) return undefined;

  if (newName.length === 0) return 'A column name cannot be empty';
  if (newName.trim() !== newName) {
    return 'A column name cannot start or end with a space, because the header row is trimmed';
  }
  if (/[\r\n]/u.test(newName)) return 'A column name cannot contain a line break';
  if (newName.includes(map.delimiter)) {
    const shown = map.delimiter === '\t' ? 'a tab' : `\`${map.delimiter}\``;
    return `A column name cannot contain ${shown}, which separates the header cells`;
  }
  if (newName.includes('"') || newName.includes("'")) {
    return 'A column name cannot contain a quote';
  }
  if (map.columns.some((entry) => entry.name === newName)) {
    return `\`${newName}\` is already a column of this block`;
  }

  const bare = BARE_NAME.test(newName) && !KEYWORDS.has(newName);
  for (const site of column.sites) {
    if (site.kind === 'identifier' && !bare) {
      return `\`${name}\` is written as a bare name in an expression, so \`${newName}\` would have to be bracketed`;
    }
    if (site.kind === 'bracket' && (newName.includes('[') || newName.includes(']'))) {
      return `\`${name}\` is written as \`[${name}]\` in an expression, so \`${newName}\` cannot contain a bracket`;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The header row
// ─────────────────────────────────────────────────────────────────────────────

interface HeaderCell {
  readonly name: string;
  /** Where the name starts within the header line, or `-1` if not plainly in it. */
  readonly offset: number;
}

interface Header {
  readonly cells: readonly HeaderCell[];
  /** The header row as `raw.data` holds it, with the block indentation gone. */
  readonly line: string;
  /** The whole data section, which is where {@link line} is looked for. */
  readonly range: Range;
  readonly delimiter: string;
}

/**
 * The header row of a block's own data section.
 *
 * The range is the whole section rather than the row, because `raw.data` has
 * the container indentation stripped and so cannot be located by offset
 * arithmetic — the row is found by looking for its text inside the section, and
 * as the first non-blank line of it there is nothing it could be found inside
 * by mistake.
 */
function readHeader(block: MdvBlock): Header | undefined {
  const range = block.dataPosition;
  if (range === undefined) return undefined;

  const raw = block.raw.data;
  if (raw.trim() === '') return undefined;

  const attrs = block.attrs;
  // Rows published under an id are read by `@id` from anywhere in the document
  // (SPEC 6.3), and the `x: date` that reads them is a reference in another
  // block's text. That is the case below seen from the other end: a name whose
  // uses are not all in this block is a name this file cannot move.
  if (attrs['id'] !== undefined) return undefined;
  if (attrs['header'] === false) return undefined; // Names are `column_1`, `column_2`.
  if (attrs['columns'] !== undefined) return undefined; // Names come from the header, not the text.
  if (attrs['src'] !== undefined) return undefined;
  if (isReference(attrs['data']) || isReference(attrs['from'])) return undefined;

  const declared = attrs['format'];
  const format = typeof declared === 'string' && declared !== 'auto' ? declared : detectFormat(raw);

  const lines = splitLines(stripBom(raw));
  if (format === 'table') {
    // SPEC 6.2.1: the first non-blank line is the header row.
    const line = lines.find((candidate) => !isBlank(candidate));
    if (line === undefined) return undefined;
    return { cells: pipeCells(line), line, range, delimiter: '|' };
  }

  if (format === 'csv' || format === 'tsv') {
    // The scanner drops an empty line and keeps one that holds only spaces, so
    // the header row is the first line with any character in it at all — not
    // the first non-blank one, which would skip a row of empty cells.
    const line = lines.find((candidate) => candidate !== '');
    if (line === undefined) return undefined;
    const delimiter = format === 'tsv' ? '\t' : firstChar(stringOr(attrs['delimiter']), ',');
    const quoting = format === 'csv';
    // The names come from a scan of the whole section, because that is the scan
    // whose answer the rest of the pipeline sees: a quoted cell may run past the
    // end of the line, and then this row is not the header row on its own.
    const names = scanDelimited(raw, delimiter, quoting)[0] ?? [];
    return { cells: delimitedCells(line, names, delimiter, quoting), line, range, delimiter };
  }

  // `json` and `ndjson` name a column once per record and `columns` once per
  // line, so there is no one row to rewrite; `matrix` names none at all.
  return undefined;
}

/**
 * Header cells of a `csv` or `tsv` row.
 *
 * The names are the reader's, so they are the names the rest of the pipeline
 * will use; the spans come from a scan of the one row that only has to know
 * where a quoted run ends. When the two disagree about how many cells there
 * are — a quoted cell that runs onto the next line — every cell is reported as
 * unlocatable rather than paired up by guesswork.
 */
function delimitedCells(
  line: string,
  names: readonly string[],
  delimiter: string,
  quoting: boolean,
): HeaderCell[] {
  const spans = delimitedSpans(line, delimiter, quoting);
  if (spans.length !== names.length) return names.map((name) => ({ name, offset: -1 }));
  return names.map((name, index) => {
    const span = spans[index] as { start: number; end: number };
    const within = line.slice(span.start, span.end).indexOf(name);
    return { name, offset: within === -1 ? -1 : span.start + within };
  });
}

/** Where each cell of one delimited row starts and ends, quotes included. */
function delimitedSpans(
  line: string,
  delimiter: string,
  quoting: boolean,
): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoting && ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && ch === delimiter) {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  spans.push({ start, end: line.length });
  return spans;
}

/**
 * Header cells of a `table` row.
 *
 * `splitPipeRow` owns the rules — escapes, trimming, optional edge pipes — and
 * is asked for the names; the spans repeat only the split, and a cell whose
 * name is not in it verbatim (one written `a\|b`) is reported as unlocatable.
 */
function pipeCells(line: string): HeaderCell[] {
  const names = splitPipeRow(line);
  const spans = pipeSpans(line);
  if (spans.length !== names.length) return names.map((name) => ({ name, offset: -1 }));
  return names.map((name, index) => {
    const span = spans[index] as { start: number; end: number };
    const within = line.slice(span.start, span.end).indexOf(name);
    return { name, offset: within === -1 ? -1 : span.start + within };
  });
}

/** The split half of {@link splitPipeRow}, keeping offsets instead of text. */
function pipeSpans(line: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '|') {
      spans.push({ start, end: i });
      start = i + 1;
    }
  }
  spans.push({ start, end: line.length });

  const isEmpty = (span: { start: number; end: number }): boolean =>
    line.slice(span.start, span.end).trim() === '';
  if (spans.length > 1 && isEmpty(spans[0] as { start: number; end: number })) {
    if (line.trimStart().startsWith('|')) spans.shift();
  }
  if (spans.length > 1 && isEmpty(spans[spans.length - 1] as { start: number; end: number })) {
    if (line.trimEnd().endsWith('|')) spans.pop();
  }
  return spans;
}

// ─────────────────────────────────────────────────────────────────────────────
// References, in pipeline order
// ─────────────────────────────────────────────────────────────────────────────

/** Adds one reference site, given the path whose range it is written in. */
type AddSite = (path: string, kind: ColumnSiteKind, text: string, offset: number) => void;

/**
 * Every reference to `name` the block makes while `name` still means the header
 * column, in source order.
 */
function collectReferences(block: MdvBlock, name: string, into: ColumnSite[]): void {
  const add: AddSite = (path, kind, text, offset) => {
    into.push({
      name,
      kind,
      path,
      range: block.attrsPosition[path] ?? rangeOfNode(block),
      text,
      // A site whose path has no recorded range cannot be edited exactly, and
      // says so the same way an id hidden by YAML rewriting does.
      offset: block.attrsPosition[path] === undefined ? -1 : offset,
    });
  };

  let alive = true;
  const steps = block.attrs['transform'];
  if (Array.isArray(steps)) {
    for (const [index, step] of steps.entries()) {
      if (!alive) break;
      if (!isMap(step)) continue;
      alive = stepReferences(step, `transform[${index}]`, name, add);
    }
  } else if (isMap(steps)) {
    // `readPipeline` accepts a lone step written unwrapped, and the parser
    // paths it unwrapped too.
    alive = stepReferences(steps, 'transform', name, add);
  }
  if (alive) channelReferences(block.attrs, name, add);
}

/**
 * References one transform step makes, and whether `name` still means the
 * header column after it (SPEC 6.7).
 *
 * The survival half is the step's own definition read backwards: a step that
 * chooses which columns come out (`aggregate`, `select`, `pivot`, `unpivot`)
 * ends the walk unless this one is among them, `rename` ends it because the
 * column continues under the other name, and everything else passes every
 * column through.
 */
function stepReferences(step: AttrMap, base: string, name: string, add: AddSite): boolean {
  const filter = step['filter'];
  if (typeof filter === 'string') {
    expressionReferences(filter, `${base}.filter`, name, add);
    return true;
  }

  const derive = step['derive'];
  if (isMap(derive)) {
    // Entries are evaluated left to right and later ones see earlier ones, so
    // `derive: {revenue: revenue * 2}` reads the header column and then hides
    // it: everything after that key means the derived value, and a rename of
    // the header column must leave those references alone.
    for (const [key, value] of Object.entries(derive)) {
      if (typeof value === 'string')
        expressionReferences(value, `${base}.derive.${key}`, name, add);
      if (key === name) return false;
    }
    return true;
  }

  const aggregate = step['aggregate'];
  if (isMap(aggregate)) return aggregateReferences(aggregate, `${base}.aggregate`, name, add);

  const sort = step['sort'];
  if (sort !== undefined) {
    listReferences(sort, `${base}.sort`, name, add, true);
    return true;
  }

  const select = step['select'];
  if (select !== undefined) return listReferences(select, `${base}.select`, name, add, false);

  const rename = step['rename'];
  if (isMap(rename)) {
    if (!Object.hasOwn(rename, name)) return true;
    // The old name is the *key*, and `${base}.rename.${name}` is the path of
    // the value beside it — a range holding the new name, which this one is
    // not written inside. The suffix keeps the two apart so the site falls
    // through to "no recorded range" and the caller declines, instead of
    // searching a span the key is not in and landing wherever it likes.
    add(`${base}.rename.${name}${KEY_PATH}`, 'attribute', name, 0);
    return false; // The column goes on under the name this step gives it.
  }

  const pivot = step['pivot'];
  if (isMap(pivot)) {
    scalarReference(pivot['key'], `${base}.pivot.key`, name, add);
    scalarReference(pivot['value'], `${base}.pivot.value`, name, add);
    return listReferences(pivot['group'], `${base}.pivot.group`, name, add, false);
  }

  const unpivot = step['unpivot'];
  if (isMap(unpivot)) {
    // A folded column leaves as `key`/`value`; one that is not folded stays.
    return !listReferences(unpivot['fields'], `${base}.unpivot.fields`, name, add, false);
  }

  const bin = step['bin'];
  if (isMap(bin)) {
    if (
      scalarReference(bin['field'], `${base}.bin.field`, name, add) &&
      bin['output'] === undefined
    ) {
      // The output defaults to `<field>_bin`, so renaming the field renames a
      // second column that nothing in the document spells out. There is no text
      // to rewrite, and the site says so rather than let the rename go through
      // and break every reference to `revenue_bin`.
      add(`${base}.bin.output`, 'attribute', name, 0);
    }
    return true;
  }

  const window = step['window'];
  if (isMap(window)) {
    scalarReference(window['field'], `${base}.window.field`, name, add);
    listReferences(window['partition'], `${base}.window.partition`, name, add, false);
    return true;
  }

  const join = step['join'];
  if (isMap(join)) {
    joinReferences(join, `${base}.join`, name, add);
    return true; // A join adds the other table's columns and keeps its own.
  }

  if (step['limit'] !== undefined) return true;

  // An unrecognised step is `MDV2500`, and what it would do with a column is
  // not knowable. The walk stops rather than rewrite past it.
  return false;
}

/**
 * An aggregate keeps only what it groups by and what it aggregates, so it is
 * also where a column most often stops being itself (SPEC 6.7).
 *
 * The two spellings of an aggregator differ in exactly the way that matters
 * here: `sum: [revenue]` names its output after its input, so the column comes
 * out under whatever the header is renamed to and the walk continues, while
 * `sum: {total: revenue}` names the output itself, so `total` goes on meaning
 * what it always did and the walk stops.
 */
function aggregateReferences(
  aggregate: AttrMap,
  base: string,
  name: string,
  add: AddSite,
): boolean {
  let survives = listReferences(aggregate['group'], `${base}.group`, name, add, false);

  for (const [op, arg] of Object.entries(aggregate)) {
    if (op === 'group') continue;
    // `count: true` or `count: rows` names an output and reads no column.
    if (op === 'count') continue;

    if (typeof arg === 'string' || Array.isArray(arg)) {
      if (listReferences(arg, `${base}.${op}`, name, add, false)) survives = true;
      continue;
    }
    if (isMap(arg)) {
      for (const [output, input] of Object.entries(arg)) {
        scalarReference(input, `${base}.${op}.${output}`, name, add);
      }
    }
  }
  return survives;
}

/** `on: date`, or `on: {left: date, right: day}` — only the left side is ours. */
function joinReferences(join: AttrMap, base: string, name: string, add: AddSite): void {
  const on = join['on'];
  if (typeof on === 'string') {
    scalarReference(on, `${base}.on`, name, add);
    return;
  }
  if (isMap(on)) scalarReference(on['left'], `${base}.on.left`, name, add);
}

/** A scalar attribute that names one column. */
function scalarReference(
  value: AttrValue | undefined,
  path: string,
  name: string,
  add: AddSite,
): boolean {
  if (typeof value !== 'string' || value !== name) return false;
  add(path, 'attribute', value, 0);
  return true;
}

/**
 * A `field` or `[field, field]` attribute, and whether it names this column.
 *
 * `descending` allows the `-field` spelling `sort` uses, where the name starts
 * one character in.
 */
function listReferences(
  value: AttrValue | undefined,
  path: string,
  name: string,
  add: AddSite,
  descending: boolean,
): boolean {
  const one = (item: AttrValue | undefined, at: string): boolean => {
    if (typeof item !== 'string') return false;
    const offset = descending && item.startsWith('-') ? 1 : 0;
    if (item.slice(offset) !== name) return false;
    add(at, 'attribute', item, offset);
    return true;
  };

  if (Array.isArray(value)) {
    let hit = false;
    for (const [index, item] of value.entries()) {
      if (one(item, `${path}[${index}]`)) hit = true;
    }
    return hit;
  }
  return one(value, path);
}

/** Every field an expression reads, at the offsets it reads them from. */
function expressionReferences(source: string, path: string, name: string, add: AddSite): void {
  for (const ref of fieldRefs(source)) {
    if (ref.name !== name) continue;
    add(path, ref.bracketed ? 'bracket' : 'identifier', source, ref.offset);
  }
}

/**
 * Channel bindings, which read the table the pipeline produced (SPEC 7.1.2).
 *
 * A bare `color: revenue` is a field exactly when it names a column, which is
 * the reader's rule and the reason this is only asked once the walk says the
 * column is still there to be named.
 */
function channelReferences(attrs: AttrMap, name: string, add: AddSite): void {
  const visit = (value: AttrValue | undefined, path: string): void => {
    if (typeof value === 'string') {
      if (value === name) add(path, 'attribute', value, 0);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${path}[${index}]`);
      return;
    }
    if (!isMap(value)) return;
    const field = value['field'];
    if (typeof field === 'string' && field === name) add(`${path}.field`, 'attribute', field, 0);
  };

  for (const channel of CHANNEL_NAMES) visit(attrs[channel], channel);
}

// ─────────────────────────────────────────────────────────────────────────────

function isMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: AttrValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `@sales` — rows that come from a dataset, not from a header this block owns. */
function isReference(value: AttrValue | undefined): boolean {
  return typeof value === 'string' && value.startsWith('@');
}
