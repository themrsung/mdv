/**
 * Selection mapping.
 *
 * A transaction has to answer one question for anything holding a position into
 * the old document — the caret, a remote cursor, a comment anchor, a search
 * result: *where did this go?* Re-deriving positions from scratch loses the
 * caret on every edit, and clamping alone is wrong in the interesting cases
 * (splitting a paragraph must send the tail of the caret's text into the *new*
 * block, not clamp it to the end of the old one).
 *
 * So commands record what they did, in terms this module understands:
 *
 * - {@link MappingBuilder.splice} — inside one inline container, `[start, end)`
 *   became `insertedLength` characters.
 * - {@link MappingBuilder.move} — everything from `fromStart` in one container
 *   moved to `toStart` in another. This is what a split and a merge are.
 * - {@link MappingBuilder.drop} — a block ceased to exist; points inside it have
 *   no image and the caller must supply its own answer.
 *
 * Offsets are absolute character offsets within a container, so a command does
 * not have to think about run boundaries. Steps are applied in the order they
 * were recorded, each interpreted against the document as it stood when the
 * step was recorded — which is exactly how the commands build them.
 */

import type { NodeId } from './ids.js';
import type { MdvDocument } from './model.js';
import type { Point, Selection } from './selection.js';
import {
  containerPath,
  fromAbsolute,
  normalizePoint,
  normalizeSelection,
  resolveContainer,
  toAbsolute,
} from './selection.js';

/** Maps a point valid in the pre-transaction document into the new one. */
export type PointMap = (point: Point) => Point | undefined;

/** The inline container a mapping step refers to. */
export interface ContainerAddress {
  readonly blockId: NodeId;
  /** Container path — no trailing run index. `[]` for a paragraph, `[r, c]` for a cell. */
  readonly path: readonly number[];
}

interface SpliceStep {
  readonly kind: 'splice';
  readonly at: ContainerAddress;
  readonly start: number;
  readonly end: number;
  readonly insertedLength: number;
}

interface MoveStep {
  readonly kind: 'move';
  readonly from: ContainerAddress;
  readonly fromStart: number;
  readonly to: ContainerAddress;
  readonly toStart: number;
}

interface DropStep {
  readonly kind: 'drop';
  readonly blockId: NodeId;
}

type Step = SpliceStep | MoveStep | DropStep;

/** True when two container addresses denote the same run list. */
export function sameAddress(a: ContainerAddress, b: ContainerAddress): boolean {
  if (a.blockId !== b.blockId || a.path.length !== b.path.length) return false;
  return a.path.every((value, index) => value === b.path[index]);
}

/** The container address a point lives in. */
export function addressOf(point: Point): ContainerAddress {
  return { blockId: point.blockId, path: containerPath(point) };
}

/**
 * Accumulates the record of a transaction and turns it into a {@link PointMap}.
 *
 * A command that records nothing still produces a usable map: positions are
 * carried over and clamped, which is right for edits that do not move text
 * (setting a heading level, changing a column's alignment).
 */
export class MappingBuilder {
  readonly #before: MdvDocument;
  readonly #steps: Step[] = [];

  constructor(before: MdvDocument) {
    this.#before = before;
  }

  /** Record that `[start, end)` in `at` became `insertedLength` characters. */
  splice(at: ContainerAddress, start: number, end: number, insertedLength: number): this {
    this.#steps.push({
      kind: 'splice',
      at,
      start: Math.min(start, end),
      end: Math.max(start, end),
      insertedLength,
    });
    return this;
  }

  /** Record that the tail of `from` beginning at `fromStart` now lives in `to` at `toStart`. */
  move(from: ContainerAddress, fromStart: number, to: ContainerAddress, toStart: number): this {
    this.#steps.push({ kind: 'move', from, fromStart, to, toStart });
    return this;
  }

  /** Record that a block no longer exists. */
  drop(blockId: NodeId): this {
    this.#steps.push({ kind: 'drop', blockId });
    return this;
  }

  /** True when nothing was recorded, so the map is pure clamping. */
  get isEmpty(): boolean {
    return this.#steps.length === 0;
  }

  /**
   * Freeze the record against the resulting document.
   *
   * @param after - The document the transaction produced.
   * @param fallback - Where to send points whose block was dropped. Omitting it
   *   means such points have no image and the map returns `undefined`.
   */
  build(after: MdvDocument, fallback?: Point): PointMap {
    const steps = [...this.#steps];
    const before = this.#before;

    return (point: Point): Point | undefined => {
      const container = resolveContainer(before, point);
      if (!container) return normalizePoint(after, point) ?? fallback;

      let address: ContainerAddress = addressOf(point);
      let offset = toAbsolute(container, point);
      let dropped = false;

      for (const step of steps) {
        if (step.kind === 'drop') {
          if (step.blockId === address.blockId) dropped = true;
          continue;
        }
        if (step.kind === 'move') {
          if (sameAddress(address, step.from) && offset >= step.fromStart) {
            address = step.to;
            offset = offset - step.fromStart + step.toStart;
            dropped = false;
          }
          continue;
        }
        if (!sameAddress(address, step.at)) continue;
        if (offset <= step.start) continue;
        offset =
          offset >= step.end
            ? offset + step.insertedLength - (step.end - step.start)
            : step.start + step.insertedLength;
      }

      if (dropped) return fallback;

      const target = resolveContainer(after, {
        blockId: address.blockId,
        path: [...address.path, 0],
        offset: 0,
      });
      if (!target) return fallback;
      let total = 0;
      for (const run of target.runs) total += run.text.length;
      return fromAbsolute(target, Math.max(0, Math.min(offset, total)));
    };
  }
}

/** The map used by commands that only clamp: carry positions, then normalise. */
export function clampingMap(after: MdvDocument): PointMap {
  return (point) => normalizePoint(after, point);
}

/**
 * Map a whole selection, falling back to normalisation for any endpoint the map
 * cannot place. The result is always valid for `after`.
 */
export function mapSelection(
  after: MdvDocument,
  selection: Selection,
  map: PointMap,
): Selection {
  if (selection.kind !== 'text') return normalizeSelection(after, selection);
  const anchor = map(selection.anchor);
  const focus = map(selection.focus);
  if (!anchor || !focus) return normalizeSelection(after, selection);
  return normalizeSelection(after, { kind: 'text', anchor, focus });
}
