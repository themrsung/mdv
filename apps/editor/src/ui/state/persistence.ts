/**
 * Autosave and crash recovery.
 *
 * The contract with the user is narrow and worth stating exactly, because a
 * recovery prompt that lies is worse than none:
 *
 * - A draft is written to `localStorage` after every idle pause. It records the
 *   text, when it was written, and what file it came from.
 * - On load, a draft is offered **only when it differs from what the document
 *   would otherwise be** — the file that was reopened, or the starter document.
 *   Restoring a draft identical to the current text is a prompt with no
 *   meaning, so there isn't one.
 * - Accepting or dismissing recovery clears the draft. Autosave then starts
 *   again from the accepted state.
 *
 * `localStorage` is a ~5 MB quota shared with everything else on the origin, and
 * a document with three pasted screenshots blows straight through it. A write
 * that fails is reported rather than swallowed, so the status bar can say
 * "autosave off — document too large" instead of quietly not saving.
 */

/** The slice of `Storage` this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The autosaved document. */
export interface DraftRecord {
  readonly version: 1;
  readonly text: string;
  /** Epoch milliseconds, supplied by the caller so tests stay deterministic. */
  readonly savedAt: number;
  /** Name of the file it came from, when it came from one. */
  readonly fileName: string | null;
}

/** Why a save did not happen. */
export type SaveOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'quota' | 'unavailable'; readonly message: string };

/** Default storage key. Versioned so a format change cannot mis-read old data. */
export const DRAFT_KEY = 'mdv.editor.draft.v1';

/** Read the stored draft, or `null` when there is none or it is unreadable. */
export function loadDraft(storage: StorageLike, key: string = DRAFT_KEY): DraftRecord | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated write from a previous crash. Nothing to recover, and leaving
    // it in place would make every future load fail the same way.
    discard(storage, key);
    return null;
  }
  if (!isDraft(parsed)) {
    discard(storage, key);
    return null;
  }
  return parsed;
}

/** Write the draft. Never throws; a full quota comes back as a result. */
export function saveDraft(
  storage: StorageLike,
  record: DraftRecord,
  key: string = DRAFT_KEY,
): SaveOutcome {
  try {
    storage.setItem(key, JSON.stringify(record));
    return { ok: true };
  } catch (error) {
    if (isQuotaError(error)) {
      // Drop the stale draft: keeping an old one around while refusing to
      // update it means a recovery prompt that restores the wrong document.
      discard(storage, key);
      return {
        ok: false,
        reason: 'quota',
        message:
          'Autosave is off: the document is larger than this browser will store. Save it to a file.',
      };
    }
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Autosave is off: this browser is not allowing local storage.',
    };
  }
}

/** Remove the draft, ignoring a storage that refuses. */
export function clearDraft(storage: StorageLike, key: string = DRAFT_KEY): void {
  discard(storage, key);
}

/**
 * Should the user be offered this draft?
 *
 * Only when it actually says something different from the text the editor is
 * about to show, and only when it is not empty.
 */
export function shouldOfferRecovery(draft: DraftRecord | null, currentText: string): boolean {
  if (draft === null) return false;
  if (draft.text.trim() === '') return false;
  return draft.text !== currentText;
}

/** A short, stable description of when a draft was written. */
export function describeAge(savedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (seconds < 45) return 'moments ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

function discard(storage: StorageLike, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A storage that will not delete will not store either; nothing to do.
  }
}

function isDraft(value: unknown): value is DraftRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) return false;
  if (typeof record['text'] !== 'string') return false;
  if (typeof record['savedAt'] !== 'number') return false;
  const name = record['fileName'];
  return name === null || typeof name === 'string';
}

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return (
    named.name === 'QuotaExceededError' ||
    named.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    named.code === 22 ||
    named.code === 1014
  );
}
