import { describe, expect, it } from 'vitest';
import {
  CONFORMANCE_LEVELS,
  LEVEL_REQUIREMENTS,
  LEVEL_TABLE,
  SPEC_VERSION,
  isKnownRequirement,
  levelName,
  lookupRequirement,
  requirementsAt,
  requirementsUpTo,
} from '@mdv/spec';

describe('SPEC 16.1 level table', () => {
  it('names each requirement exactly once', () => {
    const seen = new Set<string>();
    for (const requirement of LEVEL_REQUIREMENTS) {
      expect(seen.has(requirement.id), `duplicate ${requirement.id}`).toBe(false);
      seen.add(requirement.id);
    }
    expect(seen.size).toBe(LEVEL_REQUIREMENTS.length);
  });

  it('uses well-formed rows', () => {
    for (const requirement of LEVEL_REQUIREMENTS) {
      expect(requirement.id, requirement.id).toMatch(/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/);
      expect(CONFORMANCE_LEVELS, requirement.id).toContain(requirement.level);
      expect(requirement.label.length, requirement.id).toBeGreaterThan(0);
      // A section number, e.g. `8.2`, `6.1.1`, `28`.
      expect(requirement.spec, requirement.id).toMatch(/^\d+(?:\.\d+)*$/);
    }
  });

  it('tracks the spec revision the other artefacts were generated from', () => {
    expect(LEVEL_TABLE.specVersion).toBe(SPEC_VERSION);
  });

  it('gives every level the name SPEC 16.1 gives it', () => {
    expect(levelName(1)).toBe('Core');
    expect(levelName(2)).toBe('Standard');
    expect(levelName(3)).toBe('Extended');
  });

  it('populates all three levels', () => {
    for (const level of CONFORMANCE_LEVELS) {
      expect(requirementsAt(level).length, `level ${String(level)}`).toBeGreaterThan(0);
    }
  });

  it('reads cumulatively, as SPEC 16.1 requires', () => {
    expect(requirementsUpTo(1)).toEqual(requirementsAt(1));
    expect(requirementsUpTo(2).length).toBe(requirementsAt(1).length + requirementsAt(2).length);
    expect(requirementsUpTo(3).length).toBe(LEVEL_REQUIREMENTS.length);
    for (const requirement of requirementsUpTo(2)) expect(requirement.level).not.toBe(3);
  });

  it('carries the Level 1 chart types of SPEC 16.1, and no more', () => {
    const types = requirementsAt(1)
      .filter((requirement) => requirement.id.startsWith('type.'))
      .map((requirement) => requirement.id.slice('type.'.length))
      .sort();
    expect(types).toEqual(['area', 'bar', 'donut', 'line', 'metric', 'pie', 'scatter', 'table']);
  });

  it('places every remaining catalogued type at Level 2 or 3', () => {
    const level2 = requirementsAt(2).map((requirement) => requirement.id);
    for (const id of ['type.histogram', 'type.heatmap', 'type.candlestick', 'type.sparkline']) {
      expect(level2, id).toContain(id);
    }
    const level3 = requirementsAt(3).map((requirement) => requirement.id);
    for (const id of ['type.map', 'type.network', 'type.gantt']) expect(level3, id).toContain(id);
  });

  it('looks requirements up by id', () => {
    expect(lookupRequirement('type.bar')).toEqual({
      id: 'type.bar',
      level: 1,
      label: '`bar`',
      spec: '8.2',
    });
    expect(lookupRequirement('export.pdf')?.level).toBe(2);
    expect(lookupRequirement('nope.nothing')).toBeUndefined();
    expect(isKnownRequirement('data.mdvx')).toBe(true);
    expect(isKnownRequirement('data.mdxv')).toBe(false);
  });
});
