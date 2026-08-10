/**
 * The `DataRegistry` implementation (SPEC 6.3, SPEC 18 stage 2).
 *
 * A registry belongs to exactly one document and is read-only from the outside
 * (SPEC 17.3 invariant 4): nothing a block does can add a dataset or change one,
 * which is what lets two documents resolve concurrently without interference.
 */

import type {
  Column,
  DataRegistry,
  DatasetNode,
  Table,
  TableRef,
  TransformPipeline,
  Value,
} from '../types/data.js';
import { pipelineKey } from '../transform/index.js';
import type { DatasetReference } from './reference.js';

/**
 * Wrap nodes in a registry.
 *
 * The nodes are captured as given, in declaration order (SPEC 24.3 rule 5); the
 * caller is expected to have finished preparing them, because a registry has no
 * way to run a transform and must never trigger work on lookup.
 */
export function createRegistry(nodes: readonly DatasetNode[]): DataRegistry {
  const list = [...nodes];
  const byId = new Map<string, DatasetNode>();
  for (const node of list) byId.set(node.id, node);

  return {
    get(id: string): DatasetNode | undefined {
      return byId.get(id);
    },
    has(id: string): boolean {
      return byId.has(id);
    },
    list(): readonly DatasetNode[] {
      return list;
    },
    resolve(ref: TableRef): Table | undefined {
      const node = byId.get(ref.datasetId);
      if (node === undefined || node.state !== 'ready' || node.table === undefined)
        return undefined;
      return applyProjection(node.table, ref.projection);
    },
  };
}

/** An empty registry, for a document with no datasets and for tests. */
export function emptyRegistry(): DataRegistry {
  return createRegistry([]);
}

/**
 * Keep only the projected fields, in the listed order (SPEC 6.3).
 *
 * A name that is not in the table is skipped rather than fabricated as a null
 * column: the reference is wrong, and inventing the field would hide that from
 * every downstream check. The caller reports it (`MDV2111`) at reference time,
 * where the source range points at the reference rather than at the data.
 */
export function applyProjection(table: Table, projection: readonly string[] | undefined): Table {
  if (projection === undefined || projection.length === 0) return table;

  const index = new Map<string, number>();
  for (let i = 0; i < table.fields.length; i += 1) {
    const field = table.fields[i];
    if (field !== undefined && !index.has(field.name)) index.set(field.name, i);
  }

  const picked: number[] = [];
  const fields: Column[] = [];
  for (const name of projection) {
    const at = index.get(name);
    if (at === undefined) continue;
    picked.push(at);
    fields.push({ ...(table.fields[at] as Column) });
  }
  if (fields.length === 0) return table;

  return {
    fields,
    rows: table.rows.map((row) => picked.map((at) => row[at] ?? null) as Value[]),
  };
}

/** The projected names a table does not have — the caller's `MDV2111` list. */
export function missingProjection(
  table: Table,
  projection: readonly string[] | undefined,
): string[] {
  if (projection === undefined) return [];
  const names = new Set(table.fields.map((field) => field.name));
  return projection.filter((name) => !names.has(name));
}

/**
 * The memoisation key of SPEC 6.7: *(dataset identity, transform pipeline)*.
 *
 * > Transforms are evaluated once per resolved dataset and memoised by (dataset
 * > identity, transform pipeline) so N charts over one dataset cost one
 * > evaluation.
 *
 * The projection is part of the identity because it changes the table the
 * pipeline runs on — `@sales[date]` and `@sales` are different inputs.
 */
export function tableKey(
  datasetId: string,
  projection: readonly string[] | undefined,
  pipeline: TransformPipeline | undefined,
): string {
  const fields = projection === undefined || projection.length === 0 ? '' : projection.join(',');
  return `${datasetId}|${fields}|${pipelineKey(pipeline)}`;
}

/** Build the `TableRef` a block carries, from a parsed reference and its pipeline. */
export function createTableRef(
  reference: DatasetReference,
  pipeline?: TransformPipeline,
): TableRef {
  return {
    datasetId: reference.id,
    ...(reference.projection !== undefined ? { projection: reference.projection } : {}),
    key: tableKey(reference.id, reference.projection, pipeline),
  };
}

/**
 * A per-document memo for prepared tables, keyed by {@link TableRef.key}.
 *
 * This is where "N charts over one dataset cost one evaluation" actually
 * happens. It is a plain closure rather than a module-level cache on purpose:
 * a cache that outlived the document would leak one document's data into
 * another's render (SPEC 17.3 invariant 4).
 */
export interface TableCache {
  /** Return the memoised table for `key`, computing it once on first use. */
  get(key: string, compute: () => Table): Table;
  /** How many distinct keys were computed — the number of pipeline evaluations. */
  readonly size: number;
}

export function createTableCache(): TableCache {
  const entries = new Map<string, Table>();
  return {
    get(key: string, compute: () => Table): Table {
      const hit = entries.get(key);
      if (hit !== undefined) return hit;
      const table = compute();
      entries.set(key, table);
      return table;
    },
    get size(): number {
      return entries.size;
    },
  };
}
