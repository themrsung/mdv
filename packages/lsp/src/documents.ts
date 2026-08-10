/**
 * The open-document mirror, and the offset arithmetic every feature runs on.
 *
 * A language server never reads the file it is asked about: the buffer in the
 * editor is usually ahead of the disk, and on `vscode.dev` there may be no disk
 * at all. `didOpen`/`didChange`/`didClose` are the only source of text, so this
 * store is the server's filesystem.
 *
 * Two conversions matter and are easy to get subtly wrong:
 *
 * - **LSP speaks (line, character)**; `@mdv/parser` ranges carry a source
 *   offset. Everything crosses through {@link TextDocument.positionAt} and
 *   {@link TextDocument.offsetAt}, which are exact inverses over the same text.
 * - **`character` counts UTF-16 code units** under the default position
 *   encoding, which is what a JavaScript string index already is. Counting
 *   code points instead would misplace every range after an emoji.
 */

import { TextDocumentSyncKind } from './protocol/types.js';
import type {
  DidChangeTextDocumentParams,
  Position,
  Range,
  TextDocumentContentChangeEvent,
  TextDocumentItem,
} from './protocol/types.js';

/** One open buffer, kept in step with the editor's copy of it. */
export class TextDocument {
  readonly uri: string;
  readonly languageId: string;
  #version: number;
  #text: string;
  /** Offset of the first character of each line; rebuilt lazily after an edit. */
  #lineStarts: number[] | null = null;

  constructor(uri: string, languageId: string, version: number, text: string) {
    this.uri = uri;
    this.languageId = languageId;
    this.#version = version;
    this.#text = text;
  }

  static fromItem(item: TextDocumentItem): TextDocument {
    return new TextDocument(item.uri, item.languageId, item.version, item.text);
  }

  get version(): number {
    return this.#version;
  }

  get text(): string {
    return this.#text;
  }

  get lineCount(): number {
    return this.#starts().length;
  }

  getText(range?: Range): string {
    if (range === undefined) return this.#text;
    return this.#text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  /** The whole document as a range, for a full-document edit. */
  fullRange(): Range {
    return { start: { line: 0, character: 0 }, end: this.positionAt(this.#text.length) };
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.#text.length));
    const starts = this.#starts();
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((starts[middle] ?? 0) > clamped) high = middle;
      else low = middle + 1;
    }
    const line = Math.max(0, low - 1);
    return { line, character: clamped - (starts[line] ?? 0) };
  }

  offsetAt(position: Position): number {
    const starts = this.#starts();
    if (position.line < 0) return 0;
    if (position.line >= starts.length) return this.#text.length;
    const start = starts[position.line] ?? 0;
    // A client may point past the end of a line — VS Code does it for a
    // selection that ends in the virtual space after the last character — so
    // the offset is clamped to where the next line starts rather than running
    // on to the end of the document. That is one past the terminator, which is
    // what the reference implementation does; matching it matters more than
    // being tidy, because a client that computed an offset this way expects the
    // same one back.
    const end =
      position.line + 1 < starts.length ? (starts[position.line + 1] ?? start) : this.#text.length;
    return Math.max(start, Math.min(start + Math.max(0, position.character), end));
  }

  /** Line text without its terminator, which is what a prefix test wants. */
  lineText(line: number): string {
    const starts = this.#starts();
    if (line < 0 || line >= starts.length) return '';
    const start = starts[line] ?? 0;
    const end = line + 1 < starts.length ? (starts[line + 1] ?? start) : this.#text.length;
    return this.#text.slice(start, end).replace(/\r?\n$/u, '');
  }

  /**
   * Apply one `didChange`. Changes are applied in order against the text each
   * previous change produced — the protocol says so, and applying them against
   * the original text instead corrupts every multi-edit change (a rename, a
   * multi-cursor edit) in a way that only shows up on long files.
   */
  update(changes: readonly TextDocumentContentChangeEvent[], version: number): void {
    for (const change of changes) {
      if (change.range === undefined) {
        this.#text = change.text;
      } else {
        const start = this.offsetAt(change.range.start);
        const end = Math.max(start, this.offsetAt(change.range.end));
        this.#text = this.#text.slice(0, start) + change.text + this.#text.slice(end);
      }
      this.#lineStarts = null;
    }
    this.#version = version;
  }

  #starts(): number[] {
    const cached = this.#lineStarts;
    if (cached !== null) return cached;
    const starts = [0];
    for (let index = 0; index < this.#text.length; index += 1) {
      if (this.#text.charCodeAt(index) === 10 /* \n */) starts.push(index + 1);
    }
    this.#lineStarts = starts;
    return starts;
  }
}

/** What changed, and why the store is telling you. */
export interface DocumentEvent {
  readonly document: TextDocument;
  readonly reason: 'open' | 'change' | 'save';
}

/**
 * Every open document, and the notifications that keep them current.
 *
 * The store deliberately does not register itself on a connection: the server
 * wires the three notifications, so a test can drive the store directly and a
 * future in-process host can feed it from `vscode.workspace` without a socket.
 */
export class DocumentStore {
  readonly #documents = new Map<string, TextDocument>();
  #changeListeners: ((event: DocumentEvent) => void)[] = [];
  #closeListeners: ((uri: string) => void)[] = [];

  /** The sync mode this store implements, advertised in `initialize`. */
  static readonly syncKind = TextDocumentSyncKind.incremental;

  get(uri: string): TextDocument | undefined {
    return this.#documents.get(uri);
  }

  all(): readonly TextDocument[] {
    return [...this.#documents.values()];
  }

  open(item: TextDocumentItem): TextDocument {
    const document = TextDocument.fromItem(item);
    this.#documents.set(item.uri, document);
    this.#emit({ document, reason: 'open' });
    return document;
  }

  change(params: DidChangeTextDocumentParams): TextDocument | undefined {
    const document = this.#documents.get(params.textDocument.uri);
    // A change for a document that was never opened is the client's bug, but
    // dropping it silently is right: inventing a buffer from a delta would
    // publish diagnostics about text nobody has.
    if (document === undefined) return undefined;
    document.update(params.contentChanges, params.textDocument.version);
    this.#emit({ document, reason: 'change' });
    return document;
  }

  save(uri: string, text?: string): TextDocument | undefined {
    const document = this.#documents.get(uri);
    if (document === undefined) return undefined;
    // `includeText` is off, so `text` normally arrives undefined and the mirror
    // is already right. When a client does send it, trust it over the mirror.
    if (text !== undefined) document.update([{ text }], document.version);
    this.#emit({ document, reason: 'save' });
    return document;
  }

  close(uri: string): void {
    if (!this.#documents.delete(uri)) return;
    for (const listener of this.#closeListeners) listener(uri);
  }

  onDidChangeContent(listener: (event: DocumentEvent) => void): { dispose(): void } {
    this.#changeListeners.push(listener);
    return {
      dispose: () => {
        this.#changeListeners = this.#changeListeners.filter((entry) => entry !== listener);
      },
    };
  }

  onDidClose(listener: (uri: string) => void): { dispose(): void } {
    this.#closeListeners.push(listener);
    return {
      dispose: () => {
        this.#closeListeners = this.#closeListeners.filter((entry) => entry !== listener);
      },
    };
  }

  #emit(event: DocumentEvent): void {
    for (const listener of this.#changeListeners) listener(event);
  }
}
