/**
 * The dataset DAG (SPEC 6.3).
 *
 * > A dataset MAY derive from another (`from: "@sales"` plus `transform:`),
 * > forming a DAG. Cycles are `MDV2141`.
 *
 * Two properties matter here and nowhere else:
 *
 * - **Order is deterministic.** Traversal follows declaration order, so the same
 *   document always prepares its datasets in the same sequence and any
 *   diagnostic they emit lands in the same place (SPEC 24.3).
 * - **A cycle is data, not a stack overflow.** Detection happens before any
 *   table is built, so a cyclic document reports `MDV2141` and still renders
 *   everything that does not depend on the cycle.
 */

import type { DatasetNode, TransformPipeline } from '../types/data.js';
import { parseReference } from './reference.js';

/** The dependency structure of one document's datasets. */
export interface DatasetGraph {
  /**
   * Every id, in an order where a node follows everything it derives from.
   * Nodes on a cycle still appear — preparation needs to visit them to mark them
   * failed — but their relative order among themselves is declaration order.
   */
  order: readonly string[];
  /** Direct dependencies per id, in first-appearance order, unknown ids included. */
  edges: ReadonlyMap<string, readonly string[]>;
  /** Ids that sit on a cycle (`MDV2141`). */
  cyclic: ReadonlySet<string>;
  /** Each cycle as a path that returns to its first element: `a → b → a`. */
  cycles: readonly (readonly string[])[];
}

/**
 * The datasets one node depends on: its `from:`, plus every `join.with` in its
 * pipeline.
 *
 * `join` counts as a dependency because it reads another dataset's table; a
 * pipeline that joins a dataset which joins back is as circular as a `from:`
 * loop, and would otherwise deadlock preparation instead of reporting.
 */
export function dependenciesOf(node: DatasetNode): string[] {
  const out: string[] = [];
  const add = (reference: string | undefined): void => {
    if (reference === undefined) return;
    const parsed = parseReference(reference);
    const id = parsed?.id ?? (reference.startsWith('@') ? reference.slice(1) : reference);
    if (id !== '' && id !== node.id && !out.includes(id)) out.push(id);
  };

  add(node.from);
  for (const id of joinTargets(node.transform)) add(id);
  return out;
}

/** Every `join.with` in a pipeline, in step order. */
function joinTargets(pipeline: TransformPipeline | undefined): string[] {
  if (pipeline === undefined) return [];
  const out: string[] = [];
  for (const step of pipeline) {
    const join = (step as { join?: { with?: unknown } }).join;
    if (join !== undefined && typeof join.with === 'string') out.push(join.with);
  }
  return out;
}

/**
 * Build the graph and find its cycles.
 *
 * The traversal is an explicit-stack depth-first search rather than recursion:
 * a document may declare thousands of chained datasets, and a deep `from:` chain
 * must not exhaust the JavaScript stack (SPEC 14.1 — failures are diagnostics,
 * never crashes).
 */
export function buildGraph(nodes: readonly DatasetNode[]): DatasetGraph {
  const known = new Set(nodes.map((node) => node.id));
  const edges = new Map<string, readonly string[]>();
  for (const node of nodes) edges.set(node.id, dependenciesOf(node));

  const order: string[] = [];
  const cyclic = new Set<string>();
  const cycles: string[][] = [];
  /** 0 = unvisited, 1 = on the current path, 2 = finished. */
  const colour = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];

  for (const root of nodes) {
    if ((colour.get(root.id) ?? 0) !== 0) continue;

    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    colour.set(root.id, 1);
    path.push(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; next: number };
      const deps = edges.get(frame.id) ?? [];

      if (frame.next < deps.length) {
        const dep = deps[frame.next] as string;
        frame.next += 1;
        if (!known.has(dep)) continue; // Unresolved: `MDV2142`, not a cycle.

        const state = colour.get(dep) ?? 0;
        if (state === 1) {
          // `dep` is on the current path, so the path from it to here is a cycle.
          const from = path.indexOf(dep);
          const cycle = [...path.slice(from), dep];
          for (const id of cycle) cyclic.add(id);
          cycles.push(cycle);
          continue;
        }
        if (state === 0) {
          colour.set(dep, 1);
          path.push(dep);
          stack.push({ id: dep, next: 0 });
        }
        continue;
      }

      colour.set(frame.id, 2);
      order.push(frame.id);
      path.pop();
      stack.pop();
    }
  }

  return { order, edges, cyclic, cycles };
}

/** A cycle rendered for a diagnostic: `@a → @b → @a`. */
export function describeCycle(cycle: readonly string[]): string {
  return cycle.map((id) => `@${id}`).join(' → ');
}
