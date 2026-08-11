import rawLevelTable from '../levels.json' with { type: 'json' };
import type { ConformanceLevel, LevelRequirement, LevelTable } from './types.js';

/**
 * The SPEC 16.1 level table, loaded from `packages/spec/levels.json`.
 *
 * SPEC 16.1 states each level as one sentence of prose. Read that way, "does
 * this reader implement Level 2?" can only be answered by a human comparing the
 * sentence against the code. This is the same content as data: one row per
 * feature, so the question becomes a lookup, and so a conformance run can list
 * exactly which features its corpus never touches.
 */
export const LEVEL_TABLE: LevelTable = rawLevelTable as unknown as LevelTable;

/** Every requirement, in SPEC 16.1 order (level, then section). */
export const LEVEL_REQUIREMENTS: readonly LevelRequirement[] = LEVEL_TABLE.requirements;

/** The three levels, ascending. */
export const CONFORMANCE_LEVELS: readonly ConformanceLevel[] = [1, 2, 3];

const INDEX: ReadonlyMap<string, LevelRequirement> = new Map(
  LEVEL_TABLE.requirements.map((requirement) => [requirement.id, requirement] as const),
);

/** `true` when `id` names a requirement in SPEC 16.1. */
export function isKnownRequirement(id: string): boolean {
  return INDEX.has(id);
}

/** Look up a requirement, or `undefined` for an id this spec build lacks. */
export function lookupRequirement(id: string): LevelRequirement | undefined {
  return INDEX.get(id);
}

/** The name SPEC 16.1 gives a level: `Core`, `Standard`, `Extended`. */
export function levelName(level: ConformanceLevel): string {
  return LEVEL_TABLE.levels[String(level)] ?? `Level ${String(level)}`;
}

/** Requirements introduced *at* `level`, in table order. */
export function requirementsAt(level: ConformanceLevel): readonly LevelRequirement[] {
  return LEVEL_REQUIREMENTS.filter((requirement) => requirement.level === level);
}

/**
 * Every requirement a reader claiming `level` must implement.
 *
 * Cumulative, because SPEC 16.1 is: "A reader MUST advertise its level and MUST
 * implement every feature of the levels below the one it claims."
 */
export function requirementsUpTo(level: ConformanceLevel): readonly LevelRequirement[] {
  return LEVEL_REQUIREMENTS.filter((requirement) => requirement.level <= level);
}
