/**
 * A runtime double of the `vscode` module (SPEC 29).
 *
 * The extension host is not available under vitest, so `vitest.config.ts`
 * aliases the bare `vscode` specifier - in the extension's own sources *and*
 * inside `vscode-languageclient`, which reaches for it too - to this file.
 *
 * It is a real object graph rather than a mock library: registrations are
 * recorded, events fire for real, the file system is a `Map`, and the
 * configuration store answers out of the manifest's own declared defaults. A
 * test that activates the extension therefore runs the same code the host
 * runs, and can then ask this module what the extension did.
 *
 * Only what the extension actually touches is implemented. Anything else is
 * absent on purpose: a `TypeError` from this file means the extension started
 * using an API that nothing here specifies yet, which is a thing a reviewer
 * should have to look at.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** The `vscode.Event<T>` shape: subscribing returns the unsubscribe handle. */
export type Event<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: Disposable[],
) => Disposable;

export class Disposable {
  static from(...items: readonly { dispose(): unknown }[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }

  #callOnDispose: (() => unknown) | undefined;

  constructor(callOnDispose: () => unknown) {
    this.#callOnDispose = callOnDispose;
  }

  /** Idempotent, like the real one: disposing twice must not run twice. */
  dispose(): void {
    const call = this.#callOnDispose;
    this.#callOnDispose = undefined;
    call?.();
  }
}

export class EventEmitter<T> {
  readonly #listeners = new Set<(e: T) => unknown>();

  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.#listeners.add(bound);
    const subscription = new Disposable(() => this.#listeners.delete(bound));
    disposables?.push(subscription);
    return subscription;
  };

  fire(data: T): void {
    // Copy first: a listener is allowed to unsubscribe while we are firing.
    for (const listener of [...this.#listeners]) listener(data);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  dispose(): void {
    this.#listeners.clear();
  }
}

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

interface UriParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

/** Join URI path segments the way the real `Uri.joinPath` does. */
function joinPaths(base: string, segments: readonly string[]): string {
  const parts = base.split('/').filter((p) => p.length > 0);
  for (const segment of segments) {
    for (const piece of segment.split('/')) {
      if (piece === '' || piece === '.') continue;
      if (piece === '..') parts.pop();
      else parts.push(piece);
    }
  }
  return `/${parts.join('/')}`;
}

export class Uri implements UriParts {
  static file(path: string): Uri {
    return new Uri({
      scheme: 'file',
      authority: '',
      path: path.startsWith('/') ? path : `/${path}`,
      query: '',
      fragment: '',
    });
  }

  static parse(value: string): Uri {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/.exec(
      value,
    );
    if (match === null) return Uri.file(value);
    return new Uri({
      scheme: match[1] ?? '',
      authority: match[3] ?? '',
      path: match[4] ?? '',
      query: match[6] ?? '',
      fragment: match[8] ?? '',
    });
  }

  static joinPath(base: Uri, ...segments: readonly string[]): Uri {
    return base.with({ path: joinPaths(base.path, segments) });
  }

  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  constructor(parts: UriParts) {
    this.scheme = parts.scheme;
    this.authority = parts.authority;
    this.path = parts.path;
    this.query = parts.query;
    this.fragment = parts.fragment;
  }

  get fsPath(): string {
    return this.path;
  }

  with(change: Partial<UriParts>): Uri {
    return new Uri({ ...this, ...change });
  }

  toString(): string {
    const authority = this.authority === '' && this.scheme !== 'file' ? '' : `//${this.authority}`;
    const query = this.query === '' ? '' : `?${this.query}`;
    const fragment = this.fragment === '' ? '' : `#${this.fragment}`;
    return `${this.scheme}:${authority}${this.path}${query}${fragment}`;
  }

  toJSON(): unknown {
    return { scheme: this.scheme, authority: this.authority, path: this.path };
  }
}

// ---------------------------------------------------------------------------
// Positions and ranges
// ---------------------------------------------------------------------------

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}

  isBefore(other: Position): boolean {
    return this.line === other.line ? this.character < other.character : this.line < other.line;
  }

  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }

  isAfter(other: Position): boolean {
    return other.isBefore(this);
  }

  isAfterOrEqual(other: Position): boolean {
    return this.isAfter(other) || this.isEqual(other);
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }

  compareTo(other: Position): number {
    if (this.isBefore(other)) return -1;
    return this.isEqual(other) ? 0 : 1;
  }

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line = this.line, character = this.character): Position {
    return new Position(line, character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const start = typeof a === 'number' ? new Position(a, b as number) : a;
    const end = typeof a === 'number' ? new Position(c ?? 0, d ?? 0) : (b as Position);
    // The real Range sorts its ends; code that reads `.start` relies on it.
    const flipped = end.isBefore(start);
    this.start = flipped ? end : start;
    this.end = flipped ? start : end;
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    const [from, to] =
      positionOrRange instanceof Range
        ? [positionOrRange.start, positionOrRange.end]
        : [positionOrRange, positionOrRange];
    return from.isAfterOrEqual(this.start) && to.isBeforeOrEqual(this.end);
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  with(start = this.start, end = this.end): Range {
    return new Range(start, end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(
    anchorLine: number,
    anchorCharacter: number,
    activeLine: number,
    activeCharacter: number,
  );
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const anchor = typeof a === 'number' ? new Position(a, b as number) : a;
    const active = typeof a === 'number' ? new Position(c ?? 0, d ?? 0) : (b as Position);
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  get isReversed(): boolean {
    return this.active.isBefore(this.anchor);
  }
}

// ---------------------------------------------------------------------------
// Editing and language primitives
// ---------------------------------------------------------------------------

export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }

  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }

  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }

  constructor(
    readonly range: Range,
    readonly newText: string,
  ) {}
}

export class SnippetString {
  constructor(public value = '') {}

  appendText(text: string): SnippetString {
    this.value += text.replace(/(\$|}|\\)/g, '\\$1');
    return this;
  }
}

export class MarkdownString {
  isTrusted?: boolean;
  supportHtml?: boolean;
  supportThemeIcons?: boolean;

  constructor(public value = '') {}

  appendText(text: string): MarkdownString {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
    return this;
  }

  appendMarkdown(markdown: string): MarkdownString {
    this.value += markdown;
    return this;
  }

  appendCodeblock(code: string, language = ''): MarkdownString {
    this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
    return this;
  }
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  tags?: number[];
  relatedInformation?: unknown[];

  constructor(
    readonly range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}

export class CodeLens {
  constructor(
    readonly range: Range,
    public command?: Command,
  ) {}

  get isResolved(): boolean {
    return this.command !== undefined;
  }
}

export interface Command {
  readonly title: string;
  readonly command: string;
  readonly tooltip?: string;
  readonly arguments?: unknown[];
}

export class CompletionItem {
  detail?: string;
  documentation?: string | MarkdownString;
  insertText?: string | SnippetString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  range?: Range;

  constructor(
    public label: string,
    public kind?: CompletionItemKind,
  ) {}
}

export class CompletionList {
  constructor(
    readonly items: CompletionItem[] = [],
    readonly isIncomplete = false,
  ) {}
}

export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;

  constructor(
    base: Uri | { readonly uri: Uri },
    readonly pattern: string,
  ) {
    this.baseUri = base instanceof Uri ? base : base.uri;
    this.base = this.baseUri.fsPath;
  }
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface TextLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
  readonly rangeIncludingLineBreak: Range;
  readonly firstNonWhitespaceCharacterIndex: number;
  readonly isEmptyOrWhitespace: boolean;
}

/**
 * A document backed by a plain string.
 *
 * Offsets are computed rather than cached: the documents in these tests are
 * small, and a wrong offset that only shows up on the second edit is a much
 * worse trade than a linear scan.
 */
export class TextDocument {
  #text: string;
  #version = 1;
  isClosed = false;
  isDirty = false;

  constructor(
    readonly uri: Uri,
    text: string,
    readonly languageId = 'mdv',
    readonly isUntitled = false,
  ) {
    this.#text = text;
  }

  get fileName(): string {
    return this.uri.fsPath;
  }

  get version(): number {
    return this.#version;
  }

  get eol(): EndOfLine {
    return EndOfLine.LF;
  }

  get encoding(): string {
    return 'utf8';
  }

  get lineCount(): number {
    return this.#lines().length;
  }

  #lines(): string[] {
    return this.#text.split('\n');
  }

  /** Replace the whole document, as an external edit would. */
  setText(text: string): void {
    this.#text = text;
    this.#version += 1;
  }

  getText(range?: Range): string {
    if (range === undefined) return this.#text;
    return this.#text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const lineNumber = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line;
    const lines = this.#lines();
    if (lineNumber < 0 || lineNumber >= lines.length) {
      throw new RangeError(`vscode double: line ${lineNumber} is out of range`);
    }
    const text = lines[lineNumber] ?? '';
    const leading = /^\s*/.exec(text)?.[0].length ?? 0;
    const isLast = lineNumber === lines.length - 1;
    return {
      lineNumber,
      text,
      range: new Range(new Position(lineNumber, 0), new Position(lineNumber, text.length)),
      rangeIncludingLineBreak: new Range(
        new Position(lineNumber, 0),
        isLast ? new Position(lineNumber, text.length) : new Position(lineNumber + 1, 0),
      ),
      firstNonWhitespaceCharacterIndex: leading,
      isEmptyOrWhitespace: leading === text.length,
    };
  }

  offsetAt(position: Position): number {
    const lines = this.#lines();
    const line = Math.max(0, Math.min(position.line, lines.length - 1));
    let offset = 0;
    for (let i = 0; i < line; i += 1) offset += (lines[i] ?? '').length + 1;
    return offset + Math.max(0, Math.min(position.character, (lines[line] ?? '').length));
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.#text.length));
    const before = this.#text.slice(0, clamped).split('\n');
    const line = before.length - 1;
    return new Position(line, (before[line] ?? '').length);
  }

  validatePosition(position: Position): Position {
    return this.positionAt(this.offsetAt(position));
  }

  validateRange(range: Range): Range {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  getWordRangeAtPosition(position: Position, regex = /[A-Za-z0-9_-]+/g): Range | undefined {
    const line = this.lineAt(position.line).text;
    const pattern = new RegExp(
      regex.source,
      regex.flags.includes('g') ? regex.flags : `${regex.flags}g`,
    );
    for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start <= position.character && position.character <= end) {
        return new Range(new Position(position.line, start), new Position(position.line, end));
      }
    }
    return undefined;
  }

  save(): Promise<boolean> {
    this.isDirty = false;
    return Promise.resolve(true);
  }
}

/** The subset of `TextEditor` the extension drives. */
export class TextEditor {
  selection: Selection;
  selections: Selection[];
  readonly revealed: { range: Range; type: TextEditorRevealType }[] = [];
  readonly snippets: { snippet: SnippetString; where: Position | Range | undefined }[] = [];
  readonly edits: TextEdit[] = [];

  constructor(
    readonly document: TextDocument,
    readonly viewColumn: ViewColumn = ViewColumn.One,
    selection = new Selection(new Position(0, 0), new Position(0, 0)),
  ) {
    this.selection = selection;
    this.selections = [selection];
  }

  revealRange(range: Range, type: TextEditorRevealType = TextEditorRevealType.Default): void {
    this.revealed.push({ range, type });
  }

  insertSnippet(snippet: SnippetString, where?: Position | Range): Promise<boolean> {
    this.snippets.push({ snippet, where });
    return Promise.resolve(true);
  }

  edit(callback: (builder: TextEditorEdit) => void): Promise<boolean> {
    const staged: TextEdit[] = [];
    callback({
      replace: (range, text) => {
        staged.push(new TextEdit(rangeOf(range), text));
      },
      insert: (position, text) => {
        staged.push(TextEdit.insert(position, text));
      },
      delete: (range) => {
        staged.push(TextEdit.delete(rangeOf(range)));
      },
      setEndOfLine: () => {},
    });
    // Apply back-to-front so earlier offsets stay valid.
    const ordered = [...staged].sort((a, b) => b.range.start.compareTo(a.range.start));
    let text = this.document.getText();
    for (const edit of ordered) {
      const from = this.document.offsetAt(edit.range.start);
      const to = this.document.offsetAt(edit.range.end);
      text = text.slice(0, from) + edit.newText + text.slice(to);
    }
    this.document.setText(text);
    this.edits.push(...staged);
    return Promise.resolve(true);
  }
}

export interface TextEditorEdit {
  replace(location: Range | Position | Selection, value: string): void;
  insert(location: Position, value: string): void;
  delete(location: Range | Selection): void;
  setEndOfLine(eol: EndOfLine): void;
}

function rangeOf(location: Range | Position): Range {
  return location instanceof Range ? location : new Range(location, location);
}

// ---------------------------------------------------------------------------
// Recorded state
// ---------------------------------------------------------------------------

export interface ProviderRegistration<P> {
  readonly selector: unknown;
  readonly provider: P;
  disposed: boolean;
}

export interface ShownMessage {
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly items: readonly unknown[];
}

export interface OutputChannelRecord {
  readonly name: string;
  readonly lines: string[];
  disposed: boolean;
}

export interface WebviewPanelRecord {
  readonly viewType: string;
  readonly title: string;
  readonly column: ViewColumn;
}

export interface DiagnosticCollectionRecord {
  readonly name: string;
  readonly entries: Map<string, readonly Diagnostic[]>;
  disposed: boolean;
}

/**
 * Everything the extension did, and the few answers a test gets to script.
 *
 * Registrations are appended rather than replaced so a test can prove the
 * *absence* of a duplicate - which is the whole point of SPEC 29.4's
 * "either the in-process providers or the server, never both".
 */
export interface Recorded {
  readonly commands: Map<string, (...args: never[]) => unknown>;
  readonly executed: { command: string; args: readonly unknown[] }[];
  readonly contextKeys: Map<string, unknown>;
  readonly formatters: ProviderRegistration<unknown>[];
  readonly codeLensProviders: ProviderRegistration<unknown>[];
  readonly completionProviders: ProviderRegistration<unknown>[];
  readonly contentProviders: { scheme: string; provider: unknown }[];
  readonly customEditors: { viewType: string; provider: unknown }[];
  readonly webviewSerializers: { viewType: string; serializer: unknown }[];
  readonly diagnosticCollections: DiagnosticCollectionRecord[];
  readonly outputChannels: OutputChannelRecord[];
  readonly webviewPanels: WebviewPanelRecord[];
  readonly messages: ShownMessage[];
  readonly watchers: { pattern: unknown; disposed: boolean }[];
  readonly files: Map<string, Uint8Array>;
  readonly configuration: Map<string, unknown>;
  readonly configurationDefaults: Map<string, unknown>;
  readonly updates: { key: string; value: unknown; target: ConfigurationTarget | undefined }[];
  readonly progress: { title: string | undefined }[];
  /** Scripted answers, oldest first. */
  readonly quickPickAnswers: unknown[];
  readonly messageAnswers: unknown[];
  inputBoxAnswer: string | undefined;
  saveDialogAnswer: Uri | undefined;
  clipboard: string;
}

const recorded: Recorded = {
  commands: new Map(),
  executed: [],
  contextKeys: new Map(),
  formatters: [],
  codeLensProviders: [],
  completionProviders: [],
  contentProviders: [],
  customEditors: [],
  webviewSerializers: [],
  diagnosticCollections: [],
  outputChannels: [],
  webviewPanels: [],
  messages: [],
  watchers: [],
  files: new Map(),
  configuration: new Map(),
  configurationDefaults: new Map(),
  updates: [],
  progress: [],
  quickPickAnswers: [],
  messageAnswers: [],
  inputBoxAnswer: undefined,
  saveDialogAnswer: undefined,
  clipboard: '',
};

/** What the extension did, and the answers a test can script. */
export const recording = recorded;

function clearAll(...targets: { length: number }[]): void {
  for (const target of targets) target.length = 0;
}

/** Return the double to its start-of-test state. Call this in `beforeEach`. */
export function reset(): void {
  recorded.commands.clear();
  recorded.contextKeys.clear();
  recorded.files.clear();
  recorded.configuration.clear();
  recorded.configurationDefaults.clear();
  // Values and scopes are one store split in two; clearing only the values
  // would leave the next test's `inspect` reporting the previous test's scope.
  configurationScopes.clear();
  for (const collection of recorded.diagnosticCollections) collection.entries.clear();
  clearAll(
    recorded.executed,
    recorded.formatters,
    recorded.codeLensProviders,
    recorded.completionProviders,
    recorded.contentProviders,
    recorded.customEditors,
    recorded.webviewSerializers,
    recorded.diagnosticCollections,
    recorded.outputChannels,
    recorded.webviewPanels,
    recorded.messages,
    recorded.watchers,
    recorded.updates,
    recorded.progress,
    recorded.quickPickAnswers,
    recorded.messageAnswers,
  );
  recorded.inputBoxAnswer = undefined;
  recorded.saveDialogAnswer = undefined;
  recorded.clipboard = '';

  host.uiKind = UIKind.Desktop;
  host.isTrusted = true;
  host.workspaceFolders = undefined;
  host.textDocuments = [];
  host.activeTextEditor = undefined;
  host.colorThemeKind = ColorThemeKind.Dark;

  for (const emitter of allEmitters) emitter.dispose();
}

/** The parts of the world a test sets *before* activating. */
export const host: {
  uiKind: UIKind;
  isTrusted: boolean;
  workspaceFolders: WorkspaceFolder[] | undefined;
  textDocuments: TextDocument[];
  activeTextEditor: TextEditor | undefined;
  colorThemeKind: ColorThemeKind;
} = {
  uiKind: UIKind.Desktop,
  isTrusted: true,
  workspaceFolders: undefined,
  textDocuments: [],
  activeTextEditor: undefined,
  colorThemeKind: ColorThemeKind.Dark,
};

export interface WorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

// ---------------------------------------------------------------------------
// Events the extension subscribes to
// ---------------------------------------------------------------------------

// `reset()` only ever drops the listeners, so the registry holds the emitters
// by the one member it uses. Typing it as `EventEmitter<something>` would need
// a cast at every push: the payload types have nothing in common.
const allEmitters: { dispose(): void }[] = [];

function emitter<T>(): EventEmitter<T> {
  const created = new EventEmitter<T>();
  allEmitters.push(created);
  return created;
}

export interface TextDocumentChangeEvent {
  readonly document: TextDocument;
  readonly contentChanges: readonly unknown[];
  readonly reason: undefined;
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean;
}

export interface ColorTheme {
  readonly kind: ColorThemeKind;
}

export interface TextEditorSelectionChangeEvent {
  readonly textEditor: TextEditor;
  readonly selections: readonly Selection[];
  readonly kind: undefined;
}

export interface TextEditorVisibleRangesChangeEvent {
  readonly textEditor: TextEditor;
  readonly visibleRanges: readonly Range[];
}

/** Fire these from a test to drive the extension the way the host would. */
export const fire = {
  didOpenTextDocument: emitter<TextDocument>(),
  didCloseTextDocument: emitter<TextDocument>(),
  didChangeTextDocument: emitter<TextDocumentChangeEvent>(),
  didSaveTextDocument: emitter<TextDocument>(),
  didChangeConfiguration: emitter<ConfigurationChangeEvent>(),
  didGrantWorkspaceTrust: emitter<void>(),
  didChangeActiveTextEditor: emitter<TextEditor | undefined>(),
  didChangeActiveColorTheme: emitter<ColorTheme>(),
  didChangeTextEditorSelection: emitter<TextEditorSelectionChangeEvent>(),
  didChangeTextEditorVisibleRanges: emitter<TextEditorVisibleRangesChangeEvent>(),
} as const;

/** A `ConfigurationChangeEvent` that claims every listed section changed. */
export function configurationChange(...sections: readonly string[]): ConfigurationChangeEvent {
  return {
    affectsConfiguration: (section) =>
      sections.some((s) => s === section || s.startsWith(`${section}.`)),
  };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

export const commands = {
  registerCommand(command: string, callback: (...args: never[]) => unknown): Disposable {
    if (recorded.commands.has(command)) {
      // The real host rejects this too, and a silent second registration is
      // how a command ends up running twice per invocation.
      throw new Error(`vscode double: command '${command}' is already registered`);
    }
    recorded.commands.set(command, callback);
    return new Disposable(() => recorded.commands.delete(command));
  },

  registerTextEditorCommand(command: string, callback: (...args: never[]) => unknown): Disposable {
    return commands.registerCommand(command, callback);
  },

  executeCommand<T>(command: string, ...args: unknown[]): Promise<T> {
    recorded.executed.push({ command, args });
    if (command === 'setContext') {
      recorded.contextKeys.set(String(args[0]), args[1]);
      return Promise.resolve(undefined as T);
    }
    const handler = recorded.commands.get(command);
    if (handler === undefined) return Promise.resolve(undefined as T);
    return Promise.resolve(handler(...(args as never[])) as T);
  },

  getCommands(): Promise<string[]> {
    return Promise.resolve([...recorded.commands.keys()]);
  },
};

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

export interface OutputChannel {
  readonly name: string;
  append(value: string): void;
  appendLine(value: string): void;
  clear(): void;
  show(preserveFocus?: boolean): void;
  hide(): void;
  replace(value: string): void;
  dispose(): void;
}

export interface Progress<T> {
  report(value: T): void;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<unknown>;
}

const neverCancelled: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => new Disposable(() => {}),
};

function record(level: ShownMessage['level'], message: string, items: unknown[]): Promise<unknown> {
  recorded.messages.push({ level, message, items });
  return Promise.resolve(recorded.messageAnswers.shift());
}

export const window = {
  get activeTextEditor(): TextEditor | undefined {
    return host.activeTextEditor;
  },

  get visibleTextEditors(): readonly TextEditor[] {
    return host.activeTextEditor === undefined ? [] : [host.activeTextEditor];
  },

  get activeColorTheme(): ColorTheme {
    return { kind: host.colorThemeKind };
  },

  onDidChangeActiveTextEditor: fire.didChangeActiveTextEditor.event,
  onDidChangeActiveColorTheme: fire.didChangeActiveColorTheme.event,
  onDidChangeTextEditorSelection: fire.didChangeTextEditorSelection.event,
  onDidChangeTextEditorVisibleRanges: fire.didChangeTextEditorVisibleRanges.event,

  createOutputChannel(name: string): OutputChannel {
    const entry: OutputChannelRecord = { name, lines: [], disposed: false };
    recorded.outputChannels.push(entry);
    return {
      name,
      append: (value) => {
        const last = entry.lines.pop() ?? '';
        entry.lines.push(last + value);
      },
      appendLine: (value) => {
        entry.lines.push(value);
      },
      clear: () => {
        entry.lines.length = 0;
      },
      replace: (value) => {
        entry.lines.length = 0;
        entry.lines.push(value);
      },
      show: () => {},
      hide: () => {},
      dispose: () => {
        entry.disposed = true;
      },
    };
  },

  showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
    return record('info', message, items);
  },

  showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
    return record('warning', message, items);
  },

  showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
    return record('error', message, items);
  },

  showQuickPick(items: unknown, _options?: unknown): Promise<unknown> {
    void items;
    return Promise.resolve(recorded.quickPickAnswers.shift());
  },

  showInputBox(_options?: unknown): Promise<string | undefined> {
    return Promise.resolve(recorded.inputBoxAnswer);
  },

  showSaveDialog(_options?: unknown): Promise<Uri | undefined> {
    return Promise.resolve(recorded.saveDialogAnswer);
  },

  showTextDocument(document: TextDocument, column?: ViewColumn): Promise<TextEditor> {
    const editor = new TextEditor(document, column ?? ViewColumn.One);
    host.activeTextEditor = editor;
    return Promise.resolve(editor);
  },

  setStatusBarMessage(_message: string, _hideAfter?: number): Disposable {
    return new Disposable(() => {});
  },

  withProgress<R>(
    options: { title?: string },
    task: (progress: Progress<unknown>, token: CancellationToken) => Thenable<R>,
  ): Promise<R> {
    recorded.progress.push({ title: options.title });
    return Promise.resolve(task({ report: () => {} }, neverCancelled));
  },

  createWebviewPanel(
    viewType: string,
    title: string,
    column: ViewColumn | { viewColumn: ViewColumn },
    _options?: unknown,
  ): WebviewPanel {
    const resolved = typeof column === 'number' ? column : column.viewColumn;
    recorded.webviewPanels.push({ viewType, title, column: resolved });
    return new WebviewPanel(viewType, title, resolved);
  },

  registerWebviewPanelSerializer(viewType: string, serializer: unknown): Disposable {
    recorded.webviewSerializers.push({ viewType, serializer });
    return new Disposable(() => {});
  },

  registerCustomEditorProvider(
    viewType: string,
    provider: unknown,
    _options?: unknown,
  ): Disposable {
    recorded.customEditors.push({ viewType, provider });
    return new Disposable(() => {});
  },
};

export class Webview {
  html = '';
  options: unknown = {};
  readonly cspSource = 'vscode-double:';
  readonly posted: unknown[] = [];
  readonly #messages = new EventEmitter<unknown>();

  readonly onDidReceiveMessage: Event<unknown> = this.#messages.event;

  postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return Promise.resolve(true);
  }

  asWebviewUri(uri: Uri): Uri {
    return uri.with({ scheme: 'https', authority: 'double.vscode-cdn.net' });
  }

  /** Deliver a message from the page to the extension. */
  receive(message: unknown): void {
    this.#messages.fire(message);
  }
}

export class WebviewPanel {
  readonly webview = new Webview();
  visible = true;
  active = true;
  disposed = false;
  iconPath: unknown;

  readonly #didDispose = new EventEmitter<void>();
  readonly #didChangeViewState = new EventEmitter<{ webviewPanel: WebviewPanel }>();

  readonly onDidDispose: Event<void> = this.#didDispose.event;
  readonly onDidChangeViewState: Event<{ webviewPanel: WebviewPanel }> =
    this.#didChangeViewState.event;

  constructor(
    readonly viewType: string,
    public title: string,
    readonly viewColumn: ViewColumn,
  ) {}

  reveal(_column?: ViewColumn, _preserveFocus?: boolean): void {
    this.visible = true;
  }

  /** Move the panel out of view, as switching editor groups would. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.active = visible;
    this.#didChangeViewState.fire({ webviewPanel: this });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.#didDispose.fire();
  }
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

export interface ConfigurationInspection<T> {
  readonly key: string;
  readonly defaultValue: T | undefined;
  readonly globalValue: T | undefined;
  readonly workspaceValue: T | undefined;
  readonly workspaceFolderValue: T | undefined;
}

export class WorkspaceConfiguration {
  constructor(readonly section: string) {}

  #fullKey(key: string): string {
    return this.section === '' ? key : `${this.section}.${key}`;
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const full = this.#fullKey(key);
    if (recorded.configuration.has(full)) return recorded.configuration.get(full) as T;
    if (recorded.configurationDefaults.has(full)) {
      return recorded.configurationDefaults.get(full) as T;
    }
    return defaultValue;
  }

  has(key: string): boolean {
    const full = this.#fullKey(key);
    return recorded.configuration.has(full) || recorded.configurationDefaults.has(full);
  }

  /**
   * Workspace-scoped values are the ones a repository can author, so the
   * double reports anything a test set through `setWorkspaceSetting` there and
   * anything from `setUserSetting` in the global scope. SPEC 29.6's untrusted
   * read is only meaningful if those two are actually distinguishable.
   */
  inspect<T>(key: string): ConfigurationInspection<T> | undefined {
    const full = this.#fullKey(key);
    if (!recorded.configuration.has(full) && !recorded.configurationDefaults.has(full)) {
      return undefined;
    }
    const scope = configurationScopes.get(full) ?? 'workspace';
    const value = recorded.configuration.get(full) as T | undefined;
    return {
      key: full,
      defaultValue: recorded.configurationDefaults.get(full) as T | undefined,
      globalValue: scope === 'global' ? value : undefined,
      workspaceValue: scope === 'workspace' ? value : undefined,
      workspaceFolderValue: undefined,
    };
  }

  update(key: string, value: unknown, target?: ConfigurationTarget | boolean): Promise<void> {
    const full = this.#fullKey(key);
    recorded.configuration.set(full, value);
    configurationScopes.set(full, target === ConfigurationTarget.Global ? 'global' : 'workspace');
    recorded.updates.push({
      key: full,
      value,
      target: typeof target === 'boolean' ? undefined : target,
    });
    return Promise.resolve();
  }
}

const configurationScopes = new Map<string, 'global' | 'workspace'>();

/** Seed a manifest default (`contributes.configuration`). */
export function setDefaultSetting(key: string, value: unknown): void {
  recorded.configurationDefaults.set(key, value);
}

/** Set a value the way a repository's `.vscode/settings.json` would. */
export function setWorkspaceSetting(key: string, value: unknown): void {
  recorded.configuration.set(key, value);
  configurationScopes.set(key, 'workspace');
}

/** Set a value the way the user's own settings would. */
export function setUserSetting(key: string, value: unknown): void {
  recorded.configuration.set(key, value);
  configurationScopes.set(key, 'global');
}

export interface FileStat {
  readonly type: FileType;
  readonly ctime: number;
  readonly mtime: number;
  readonly size: number;
}

export const workspace = {
  get isTrusted(): boolean {
    return host.isTrusted;
  },

  get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
    return host.workspaceFolders;
  },

  get textDocuments(): readonly TextDocument[] {
    return host.textDocuments;
  },

  onDidOpenTextDocument: fire.didOpenTextDocument.event,
  onDidCloseTextDocument: fire.didCloseTextDocument.event,
  onDidChangeTextDocument: fire.didChangeTextDocument.event,
  onDidSaveTextDocument: fire.didSaveTextDocument.event,
  onDidChangeConfiguration: fire.didChangeConfiguration.event,
  onDidGrantWorkspaceTrust: fire.didGrantWorkspaceTrust.event,

  getConfiguration(section = '', _scope?: unknown): WorkspaceConfiguration {
    return new WorkspaceConfiguration(section);
  },

  openTextDocument(
    target: Uri | string | { content?: string; language?: string },
  ): Promise<TextDocument> {
    if (target instanceof Uri || typeof target === 'string') {
      const uri = typeof target === 'string' ? Uri.file(target) : target;
      const existing = host.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (existing !== undefined) return Promise.resolve(existing);
      const bytes = recorded.files.get(uri.toString());
      const text = bytes === undefined ? '' : new TextDecoder().decode(bytes);
      const created = new TextDocument(uri, text);
      host.textDocuments.push(created);
      return Promise.resolve(created);
    }
    const created = new TextDocument(
      Uri.parse(`untitled:untitled-${host.textDocuments.length + 1}`),
      target.content ?? '',
      target.language ?? 'mdv',
      true,
    );
    host.textDocuments.push(created);
    return Promise.resolve(created);
  },

  createFileSystemWatcher(pattern: unknown): FileSystemWatcher {
    const entry = { pattern, disposed: false };
    recorded.watchers.push(entry);
    return new FileSystemWatcher(() => {
      entry.disposed = true;
    });
  },

  registerTextDocumentContentProvider(scheme: string, provider: unknown): Disposable {
    recorded.contentProviders.push({ scheme, provider });
    return new Disposable(() => {});
  },

  asRelativePath(pathOrUri: string | Uri): string {
    const path = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    const root = host.workspaceFolders?.[0]?.uri.fsPath;
    return root !== undefined && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  },

  getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
    return host.workspaceFolders?.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath));
  },

  fs: {
    readFile(uri: Uri): Promise<Uint8Array> {
      const bytes = recorded.files.get(uri.toString());
      if (bytes === undefined) {
        return Promise.reject(new Error(`vscode double: no such file '${uri.toString()}'`));
      }
      return Promise.resolve(bytes);
    },

    writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      recorded.files.set(uri.toString(), content);
      return Promise.resolve();
    },

    stat(uri: Uri): Promise<FileStat> {
      const bytes = recorded.files.get(uri.toString());
      if (bytes === undefined) {
        return Promise.reject(new Error(`vscode double: no such file '${uri.toString()}'`));
      }
      return Promise.resolve({ type: FileType.File, ctime: 0, mtime: 0, size: bytes.length });
    },

    createDirectory(_uri: Uri): Promise<void> {
      return Promise.resolve();
    },
  },
};

export class FileSystemWatcher {
  readonly #created = new EventEmitter<Uri>();
  readonly #changed = new EventEmitter<Uri>();
  readonly #deleted = new EventEmitter<Uri>();

  readonly onDidCreate: Event<Uri> = this.#created.event;
  readonly onDidChange: Event<Uri> = this.#changed.event;
  readonly onDidDelete: Event<Uri> = this.#deleted.event;

  constructor(private readonly onDispose: () => void) {}

  fireCreate(uri: Uri): void {
    this.#created.fire(uri);
  }

  fireChange(uri: Uri): void {
    this.#changed.fire(uri);
  }

  fireDelete(uri: Uri): void {
    this.#deleted.fire(uri);
  }

  dispose(): void {
    this.onDispose();
  }
}

// ---------------------------------------------------------------------------
// languages
// ---------------------------------------------------------------------------

export interface DiagnosticCollection {
  readonly name: string;
  set(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void;
  get(uri: Uri): readonly Diagnostic[] | undefined;
  delete(uri: Uri): void;
  clear(): void;
  dispose(): void;
}

function registration<P>(
  into: ProviderRegistration<P>[],
  selector: unknown,
  provider: P,
): Disposable {
  const entry: ProviderRegistration<P> = { selector, provider, disposed: false };
  into.push(entry);
  return new Disposable(() => {
    entry.disposed = true;
  });
}

export const languages = {
  createDiagnosticCollection(name = 'default'): DiagnosticCollection {
    const entry: DiagnosticCollectionRecord = { name, entries: new Map(), disposed: false };
    recorded.diagnosticCollections.push(entry);
    return {
      name,
      set: (uri, diagnostics) => {
        if (diagnostics === undefined) entry.entries.delete(uri.toString());
        else entry.entries.set(uri.toString(), diagnostics);
      },
      get: (uri) => entry.entries.get(uri.toString()),
      delete: (uri) => {
        entry.entries.delete(uri.toString());
      },
      clear: () => entry.entries.clear(),
      dispose: () => {
        entry.disposed = true;
      },
    };
  },

  registerDocumentFormattingEditProvider(selector: unknown, provider: unknown): Disposable {
    return registration(recorded.formatters, selector, provider);
  },

  registerCodeLensProvider(selector: unknown, provider: unknown): Disposable {
    return registration(recorded.codeLensProviders, selector, provider);
  },

  registerCompletionItemProvider(
    selector: unknown,
    provider: unknown,
    ..._triggers: string[]
  ): Disposable {
    return registration(recorded.completionProviders, selector, provider);
  },
};

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

export const env = {
  get uiKind(): UIKind {
    return host.uiKind;
  },
  appName: 'MDV Test Host',
  language: 'en',
  clipboard: {
    readText(): Promise<string> {
      return Promise.resolve(recorded.clipboard);
    },
    writeText(value: string): Promise<void> {
      recorded.clipboard = value;
      return Promise.resolve();
    },
  },
};

/** The token every provider is handed when a test calls it directly. */
export const CancellationTokenSource = class {
  readonly token = neverCancelled;
  cancel(): void {}
  dispose(): void {}
};
