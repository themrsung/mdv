/**
 * Autosave and crash recovery.
 *
 * The failure modes here are all "storage did something rude": it threw on
 * access, it was full, or it holds half a JSON object written by a tab that
 * died mid-write. None of those may reach the user as an exception, and none
 * of them may result in the *wrong* document being restored — so the tests are
 * mostly about the unhappy paths.
 */

import { describe, expect, it } from 'vitest';
import type { DraftRecord, StorageLike } from '../state/persistence.js';
import {
  clearDraft,
  describeAge,
  DRAFT_KEY,
  loadDraft,
  saveDraft,
  shouldOfferRecovery,
} from '../state/persistence.js';

/** A `localStorage` stand-in whose behaviour each test can bend. */
class FakeStorage implements StorageLike {
  readonly items = new Map<string, string>();
  throwOnGet = false;
  throwOnSet: unknown = null;
  throwOnRemove = false;

  getItem(key: string): string | null {
    if (this.throwOnGet) throw new Error('denied');
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSet !== null) throw this.throwOnSet;
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    if (this.throwOnRemove) throw new Error('denied');
    this.items.delete(key);
  }
}

const record = (text: string, savedAt = 1_000, fileName: string | null = null): DraftRecord => ({
  version: 1,
  text,
  savedAt,
  fileName,
});

const quotaError = (): unknown => {
  const error = new Error('full');
  error.name = 'QuotaExceededError';
  return error;
};

describe('saving', () => {
  it('round-trips a draft', () => {
    const storage = new FakeStorage();
    expect(saveDraft(storage, record('# Hi', 5, 'notes.md'))).toEqual({ ok: true });
    expect(loadDraft(storage)).toEqual(record('# Hi', 5, 'notes.md'));
  });

  it('uses a versioned key so an old format cannot be mis-read', () => {
    const storage = new FakeStorage();
    saveDraft(storage, record('x'));
    expect([...storage.items.keys()]).toEqual([DRAFT_KEY]);
    expect(DRAFT_KEY).toContain('v1');
  });

  it('honours an explicit key', () => {
    const storage = new FakeStorage();
    saveDraft(storage, record('x'), 'other');
    expect(loadDraft(storage)).toBeNull();
    expect(loadDraft(storage, 'other')?.text).toBe('x');
  });

  it('reports a full quota instead of throwing', () => {
    const storage = new FakeStorage();
    storage.throwOnSet = quotaError();
    const outcome = saveDraft(storage, record('big'));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('quota');
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it('recognises the quota error by legacy code as well as by name', () => {
    for (const thrown of [{ code: 22 }, { code: 1014 }, { name: 'NS_ERROR_DOM_QUOTA_REACHED' }]) {
      const storage = new FakeStorage();
      storage.throwOnSet = thrown;
      const outcome = saveDraft(storage, record('big'));
      expect(outcome.ok ? 'ok' : outcome.reason).toBe('quota');
    }
  });

  it('drops the stale draft when the new one will not fit', () => {
    // Otherwise the next reload offers to restore a document the author has
    // long since moved past.
    const storage = new FakeStorage();
    saveDraft(storage, record('old'));
    storage.throwOnSet = quotaError();
    saveDraft(storage, record('new and much longer'));
    expect(loadDraft(storage)).toBeNull();
  });

  it('reports a storage that refuses outright', () => {
    const storage = new FakeStorage();
    storage.throwOnSet = new Error('private mode');
    const outcome = saveDraft(storage, record('x'));
    expect(outcome.ok ? 'ok' : outcome.reason).toBe('unavailable');
  });

  it('survives a storage that also refuses to remove', () => {
    const storage = new FakeStorage();
    storage.throwOnSet = quotaError();
    storage.throwOnRemove = true;
    expect(() => saveDraft(storage, record('x'))).not.toThrow();
  });
});

describe('loading', () => {
  it('is null when nothing was ever stored', () => {
    expect(loadDraft(new FakeStorage())).toBeNull();
  });

  it('is null when reading throws', () => {
    const storage = new FakeStorage();
    storage.throwOnGet = true;
    expect(loadDraft(storage)).toBeNull();
  });

  it('discards a truncated write instead of failing forever', () => {
    const storage = new FakeStorage();
    storage.items.set(DRAFT_KEY, '{"version":1,"text":"half');
    expect(loadDraft(storage)).toBeNull();
    expect(storage.items.has(DRAFT_KEY)).toBe(false);
  });

  it('discards anything that is not a draft', () => {
    const wrong = [
      '"a string"',
      'null',
      '[]',
      '{"version":2,"text":"x","savedAt":1,"fileName":null}',
      '{"version":1,"savedAt":1,"fileName":null}',
      '{"version":1,"text":"x","savedAt":"soon","fileName":null}',
      '{"version":1,"text":"x","savedAt":1,"fileName":7}',
    ];
    for (const raw of wrong) {
      const storage = new FakeStorage();
      storage.items.set(DRAFT_KEY, raw);
      expect(loadDraft(storage), raw).toBeNull();
      expect(storage.items.has(DRAFT_KEY), raw).toBe(false);
    }
  });

  it('keeps an empty string out of the way', () => {
    const storage = new FakeStorage();
    storage.items.set(DRAFT_KEY, '');
    expect(loadDraft(storage)).toBeNull();
  });

  it('clears on request', () => {
    const storage = new FakeStorage();
    saveDraft(storage, record('x'));
    clearDraft(storage);
    expect(loadDraft(storage)).toBeNull();
  });
});

describe('offering recovery', () => {
  it('says nothing when there is no draft', () => {
    expect(shouldOfferRecovery(null, '')).toBe(false);
  });

  it('says nothing when the draft matches what is already open', () => {
    expect(shouldOfferRecovery(record('# Hi'), '# Hi')).toBe(false);
  });

  it('says nothing for a blank draft', () => {
    expect(shouldOfferRecovery(record('   \n\t '), '# Hi')).toBe(false);
  });

  it('offers a draft that differs', () => {
    expect(shouldOfferRecovery(record('# Hi there'), '# Hi')).toBe(true);
  });

  it('treats trailing whitespace as a difference worth keeping', () => {
    // The draft is what the author last had; only *emptiness* is uninteresting.
    expect(shouldOfferRecovery(record('# Hi\n'), '# Hi')).toBe(true);
  });
});

describe('describing age', () => {
  const now = 1_000_000_000;
  const ago = (ms: number): string => describeAge(now - ms, now);

  it('rounds the recent past away', () => {
    expect(ago(0)).toBe('moments ago');
    expect(ago(44_000)).toBe('moments ago');
  });

  it('counts minutes, then hours, then days', () => {
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(120_000)).toBe('2 minutes ago');
    expect(ago(3_600_000)).toBe('1 hour ago');
    expect(ago(2 * 3_600_000)).toBe('2 hours ago');
    expect(ago(24 * 3_600_000)).toBe('1 day ago');
    expect(ago(72 * 3_600_000)).toBe('3 days ago');
  });

  it('does not go backwards when the clock does', () => {
    expect(describeAge(now + 5_000, now)).toBe('moments ago');
  });
});
