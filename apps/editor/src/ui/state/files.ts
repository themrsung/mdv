/**
 * Opening and saving `.mdv` files from a page with no server behind it.
 *
 * Two paths, chosen at runtime:
 *
 * - **File System Access API** (Chromium, and Safari for `showSaveFilePicker`).
 *   The handle is kept, so Ctrl+S after the first save overwrites the file the
 *   user chose instead of dropping another copy in Downloads.
 * - **Download / file input.** Everywhere else. Save produces a download and
 *   *cannot* overwrite, so the UI must not claim the document is "saved to" a
 *   path it has no handle for; `saveText` says which happened.
 *
 * The API is typed here rather than imported: `FileSystemFileHandle` is in
 * `lib.dom` but `showSaveFilePicker` is not, in the TypeScript version this
 * repo pins.
 */

/** A document loaded from disk. */
export interface OpenedFile {
  readonly name: string;
  readonly text: string;
  /** Present only when the File System Access API supplied it. */
  readonly handle: FileHandle | null;
}

/** The result of a save. */
export type SaveResult =
  | { readonly kind: 'saved'; readonly name: string; readonly handle: FileHandle }
  | { readonly kind: 'downloaded'; readonly name: string }
  | { readonly kind: 'cancelled' };

/** The subset of `FileSystemFileHandle` used here. */
export interface FileHandle {
  readonly name: string;
  createWritable(): Promise<WritableFileStream>;
  getFile(): Promise<{ text(): Promise<string>; name: string }>;
}

interface WritableFileStream {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface PickerOptions {
  suggestedName?: string;
  types?: readonly {
    description: string;
    accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

interface PickerWindow {
  showOpenFilePicker?: (options: PickerOptions & { multiple?: boolean }) => Promise<FileHandle[]>;
  showSaveFilePicker?: (options: PickerOptions) => Promise<FileHandle>;
}

const FILE_TYPES = [
  {
    description: 'MDV document',
    accept: { 'text/markdown': ['.mdv', '.md'] as readonly string[] },
  },
] as const;

/** The default name for a document that has never been saved. */
export const UNTITLED = 'untitled.mdv';

/** True when the browser can open and overwrite real files. */
export function supportsFileSystemAccess(): boolean {
  const scope = globalThis as unknown as PickerWindow;
  return typeof scope.showSaveFilePicker === 'function';
}

/**
 * Ask the user for a file and read it.
 *
 * Returns `null` when the picker was dismissed, which is not an error and must
 * not produce a message.
 */
export async function openFile(): Promise<OpenedFile | null> {
  const scope = globalThis as unknown as PickerWindow;
  const picker = scope.showOpenFilePicker;
  if (typeof picker === 'function') {
    let handles: FileHandle[];
    try {
      handles = await picker({ multiple: false, types: FILE_TYPES });
    } catch (error) {
      if (isAbort(error)) return null;
      throw error;
    }
    const handle = handles[0];
    if (handle === undefined) return null;
    const file = await handle.getFile();
    return { name: file.name, text: await file.text(), handle };
  }
  return openViaInput();
}

/** Save `text`, reusing `handle` when there is one. */
export async function saveText(
  text: string,
  name: string,
  handle: FileHandle | null,
  options: { readonly forcePicker?: boolean } = {},
): Promise<SaveResult> {
  const scope = globalThis as unknown as PickerWindow;

  if (handle !== null && options.forcePicker !== true) {
    await writeThrough(handle, text);
    return { kind: 'saved', name: handle.name, handle };
  }

  const picker = scope.showSaveFilePicker;
  if (typeof picker === 'function') {
    let chosen: FileHandle;
    try {
      chosen = await picker({ suggestedName: name, types: FILE_TYPES });
    } catch (error) {
      if (isAbort(error)) return { kind: 'cancelled' };
      throw error;
    }
    await writeThrough(chosen, text);
    return { kind: 'saved', name: chosen.name, handle: chosen };
  }

  download(text, name);
  return { kind: 'downloaded', name };
}

/** Trigger a browser download of `text`. Exported for the "Export" action. */
export function download(text: string, name: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the navigation a turn before revoking, or Safari cancels the download.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
}

/** Force a `.mdv` extension onto a user-supplied name. */
export function withMdvExtension(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return UNTITLED;
  return /\.(mdv|md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.mdv`;
}

async function writeThrough(handle: FileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(text);
  } finally {
    await writable.close();
  }
}

function openViaInput(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mdv,.md,.markdown,text/markdown,text/plain';
    input.style.display = 'none';

    let settled = false;
    const finish = (value: OpenedFile | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        finish(null);
        return;
      }
      void file.text().then(
        (text) => {
          finish({ name: file.name, text, handle: null });
        },
        () => {
          finish(null);
        },
      );
    });
    // `cancel` is not universal; the dialog simply never resolves without it,
    // which is why the promise is also settled by the next focus event.
    input.addEventListener('cancel', () => {
      finish(null);
    });

    document.body.append(input);
    input.click();
  });
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
