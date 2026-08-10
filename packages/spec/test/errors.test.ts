import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  codesInGroup,
  groupName,
  isKnownErrorCode,
  lookupErrorCode,
  severityOf,
  summaryOf,
} from '@mdv/spec';

describe('Appendix C error table', () => {
  it('exposes every code exactly once', () => {
    const seen = new Set<string>();
    for (const entry of ERROR_CODES) {
      expect(seen.has(entry.code), `duplicate ${entry.code}`).toBe(false);
      seen.add(entry.code);
    }
    expect(seen.size).toBe(ERROR_CODES.length);
  });

  it('uses well-formed codes and severities', () => {
    for (const entry of ERROR_CODES) {
      expect(entry.code).toMatch(/^MDV[1-5]\d{3}$/);
      expect(['error', 'warning', 'info']).toContain(entry.severity);
      expect(entry.summary.length).toBeGreaterThan(0);
      // SPEC 14.2: one sentence, no trailing period.
      expect(entry.summary.endsWith('.')).toBe(false);
    }
  });

  it('covers all five families', () => {
    for (const group of ['MDV1', 'MDV2', 'MDV3', 'MDV4', 'MDV5'] as const) {
      expect(codesInGroup(group).length).toBeGreaterThan(0);
    }
  });

  it('looks codes up by value', () => {
    expect(lookupErrorCode('MDV3010')?.severity).toBe('error');
    expect(severityOf('MDV3021')).toBe('warning');
    expect(severityOf('MDV1100')).toBe('info');
    expect(summaryOf('MDV4001')).toBe('`src:` encountered in a synchronous resolve');
    expect(groupName('MDV3010')).toBe('encoding');
  });

  it('fails closed on unknown codes', () => {
    expect(isKnownErrorCode('MDV9999')).toBe(false);
    expect(lookupErrorCode('MDV9999')).toBeUndefined();
    // An unclassifiable diagnostic must not be silently downgraded.
    expect(severityOf('MDV9999')).toBe('error');
  });
});
