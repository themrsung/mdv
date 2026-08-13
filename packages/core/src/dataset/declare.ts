/**
 * Turning declarations into nodes of the dataset graph (SPEC 6.3).
 *
 * > Datasets declared in front matter (`datasets:`) and datasets declared in
 * > blocks share one namespace.
 *
 * One namespace means one place that decides what an id is worth, which is this
 * module: it validates the id, resolves collisions ("last definition wins and
 * earlier ones are shadowed"), and reads the loose `AttrMap` of a header into
 * the typed fields the rest of the pipeline relies on.
 */

import type { AttrMap, AttrValue, Range } from '@mdv/parser';
import type { DiagCollector } from '../data/diag.js';
import type {
  DataFormat,
  DataType,
  DatasetNode,
  DatasetOrigin,
  FieldDecl,
  TransformPipeline,
  TransformStep,
} from '../types/data.js';
import { DATASET_ID_PATTERN, isUsableId } from './reference.js';

/**
 * The block type that declares data instead of drawing it (SPEC 6.3).
 *
 * Named here rather than at each use so that "is this block a declaration?" has
 * one answer: resolve asks it to route a block to {@link readDeclaration}, and
 * a tool that locates declarations has to route the same way or it will report
 * a dataset the document does not have.
 */
export const DATASET_BLOCK = 'dataset';

/** A dataset as declared, before anything has been parsed or fetched. */
export interface DatasetDeclaration {
  id: string;
  origin: DatasetOrigin;
  from?: string | undefined;
  src?: string | undefined;
  integrity?: string | undefined;
  format?: DataFormat | undefined;
  /** The verbatim data section. */
  raw?: string | undefined;
  fields?: Readonly<Record<string, FieldDecl>> | undefined;
  transform?: TransformPipeline | undefined;
  show?: 'none' | 'table' | undefined;
  range?: Range | undefined;
  /** The block carried no data at all; see {@link DatasetNode.implicit}. */
  implicit?: boolean | undefined;
}

/**
 * Build the node list for one document.
 *
 * Ids that fail the pattern are dropped rather than repaired: a dataset nobody
 * can reference is not worth keeping, and a silently renamed one would make
 * `@sales` resolve to something the author never wrote.
 */
export function declareDatasets(
  declarations: readonly DatasetDeclaration[],
  diag: DiagCollector,
): DatasetNode[] {
  const byId = new Map<string, DatasetNode>();
  const order: string[] = [];

  for (const declaration of declarations) {
    const scoped = declaration.range === undefined ? diag : diag.withRange(declaration.range);

    if (!isUsableId(declaration.id)) {
      scoped.emit('MDV1220', {
        message: `\`${declaration.id}\` is not a valid dataset id`,
        detail: `An id must match \`${DATASET_ID_PATTERN.source}\` (SPEC 6.3). The dataset was dropped.`,
      });
      continue;
    }

    if (byId.has(declaration.id)) {
      scoped.emit('MDV2140', {
        message: `Duplicate dataset id \`${declaration.id}\``,
        detail: 'The later definition wins; the earlier one is shadowed (SPEC 6.3).',
      });
      // The surviving node takes the *later* declaration's position, because
      // that is where the definition a reader will see actually lives.
      const at = order.indexOf(declaration.id);
      if (at !== -1) order.splice(at, 1);
    }

    byId.set(declaration.id, toNode(declaration));
    order.push(declaration.id);
  }

  return order.map((id) => byId.get(id) as DatasetNode);
}

function toNode(declaration: DatasetDeclaration): DatasetNode {
  return {
    id: declaration.id,
    origin: declaration.origin,
    state: 'declared',
    ...(declaration.from !== undefined ? { from: declaration.from } : {}),
    ...(declaration.src !== undefined ? { src: declaration.src } : {}),
    ...(declaration.integrity !== undefined ? { integrity: declaration.integrity } : {}),
    ...(declaration.format !== undefined ? { format: declaration.format } : {}),
    ...(declaration.raw !== undefined ? { raw: declaration.raw } : {}),
    ...(declaration.fields !== undefined ? { fields: declaration.fields } : {}),
    ...(declaration.transform !== undefined ? { transform: declaration.transform } : {}),
    ...(declaration.show !== undefined ? { show: declaration.show } : {}),
    ...(declaration.range !== undefined ? { range: declaration.range } : {}),
    ...(declaration.implicit === true ? { implicit: true } : {}),
  };
}

const DATA_FORMATS: readonly string[] = [
  'auto',
  'table',
  'csv',
  'tsv',
  'json',
  'ndjson',
  'columns',
  'matrix',
];

const DATA_TYPES: readonly string[] = [
  'number',
  'integer',
  'string',
  'category',
  'boolean',
  'date',
  'time',
  'datetime',
  'unknown',
];

/**
 * Read the dataset-related keys of a header into a declaration.
 *
 * Tolerant by construction (SPEC 14.1): a key of the wrong shape is reported and
 * ignored, never fatal, because the rest of the dataset may still be usable —
 * a bad `show:` should not cost the reader its data.
 */
export function readDeclaration(
  id: string,
  attrs: AttrMap,
  origin: DatasetOrigin,
  diag: DiagCollector,
  raw?: string,
  range?: Range,
): DatasetDeclaration {
  const scoped = range === undefined ? diag : diag.withRange(range);
  const declaration: DatasetDeclaration = { id, origin };

  const from = attrs['from'];
  if (typeof from === 'string') declaration.from = from;
  else if (from !== undefined) badType(scoped, 'from', 'a dataset reference');

  const src = attrs['src'];
  if (typeof src === 'string') declaration.src = src;
  else if (src !== undefined) badType(scoped, 'src', 'a path or URL');

  const integrity = attrs['integrity'];
  if (typeof integrity === 'string') declaration.integrity = integrity;
  else if (integrity !== undefined) badType(scoped, 'integrity', 'an SRI hash string');

  const format = attrs['format'];
  if (typeof format === 'string' && DATA_FORMATS.includes(format)) {
    declaration.format = format as DataFormat;
  } else if (format !== undefined) {
    scoped.emit('MDV1502', {
      message: `Unknown data format \`${describe(format)}\``,
      detail: `Known formats are ${DATA_FORMATS.join(', ')} (SPEC 6.2). Auto-detection was used.`,
    });
  }

  const show = attrs['show'];
  if (show === 'none' || show === 'table') declaration.show = show;
  else if (show !== undefined) {
    scoped.emit('MDV1502', {
      message: `Unknown \`show\` value \`${describe(show)}\``,
      detail: 'A dataset block is hidden unless `show: table` (SPEC 6.3).',
    });
  }

  const fields = readFields(attrs['fields'], scoped);
  if (fields !== undefined) declaration.fields = fields;

  const transform = readPipeline(attrs['transform'], scoped);
  if (transform !== undefined) declaration.transform = transform;

  if (raw !== undefined) declaration.raw = raw;
  if (range !== undefined) declaration.range = range;
  return declaration;
}

/** `fields: {date: {type: date}}`, or the shorthand `fields: {date: date}`. */
export function readFields(
  value: AttrValue | undefined,
  diag: DiagCollector,
): Record<string, FieldDecl> | undefined {
  if (value === undefined) return undefined;
  if (!isMap(value)) {
    badType(diag, 'fields', 'a mapping of field name to declaration');
    return undefined;
  }

  const out: Record<string, FieldDecl> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      // `fields: {date: date}` — the common case is a type and nothing else.
      if (DATA_TYPES.includes(entry)) {
        out[name] = { type: entry as DataType };
        continue;
      }
      diag.emit('MDV1502', {
        message: `Unknown field type \`${entry}\` for \`${name}\``,
        detail: `Known types are ${DATA_TYPES.join(', ')} (SPEC 6.1). The type was inferred instead.`,
      });
      continue;
    }
    if (!isMap(entry)) {
      badType(diag, `fields.${name}`, 'a type name or a mapping');
      continue;
    }

    const decl: FieldDecl = {};
    const type = entry['type'];
    if (typeof type === 'string' && DATA_TYPES.includes(type)) decl.type = type as DataType;
    else if (type !== undefined) {
      diag.emit('MDV1502', {
        message: `Unknown field type \`${describe(type)}\` for \`${name}\``,
        detail: `Known types are ${DATA_TYPES.join(', ')} (SPEC 6.1). The type was inferred instead.`,
      });
    }
    const format = entry['format'];
    // `FieldDecl.format` is a `FormatSpec`, i.e. a string. SPEC 6.9.2's options
    // object has no home on this shared type, so it is reported rather than
    // silently dropped, and the field falls back to its default rendering.
    if (typeof format === 'string') decl.format = format;
    else if (isMap(format)) {
      badType(
        diag,
        `fields.${name}.format`,
        'a format string; an options object is not carried on a field declaration',
      );
    } else if (format !== undefined) badType(diag, `fields.${name}.format`, 'a format string');
    const parse = entry['parse'];
    if (typeof parse === 'string') decl.parse = parse;
    else if (parse !== undefined) badType(diag, `fields.${name}.parse`, 'a format string');
    const title = entry['title'];
    if (typeof title === 'string') decl.title = title;
    else if (title !== undefined) badType(diag, `fields.${name}.title`, 'a string');

    out[name] = decl;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * `transform:` as written — a list of single-key mappings.
 *
 * Only the *shape* is checked here. Whether `sort` names a real field, or
 * `window.op` is a known op, is the pipeline's business (`MDV2500`/`MDV2501`),
 * and reporting it there keeps one rule in one place.
 */
export function readPipeline(
  value: AttrValue | undefined,
  diag: DiagCollector,
): TransformPipeline | undefined {
  if (value === undefined) return undefined;

  const entries: readonly AttrValue[] = Array.isArray(value)
    ? (value as readonly AttrValue[])
    : [value as AttrValue];

  const steps: TransformStep[] = [];
  for (const entry of entries) {
    if (!isMap(entry)) {
      diag.emit('MDV2501', {
        message: 'A transform step must be a mapping',
        detail: `Got ${describe(entry)}. The step was dropped (SPEC 6.7).`,
      });
      continue;
    }
    steps.push(entry as unknown as TransformStep);
  }

  return steps.length === 0 ? undefined : steps;
}

function isMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badType(diag: DiagCollector, key: string, expected: string): void {
  diag.emit('MDV1220', {
    message: `\`${key}\` must be ${expected}`,
    detail: 'The value was ignored.',
  });
}

function describe(value: AttrValue | undefined): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return String(value);
}
