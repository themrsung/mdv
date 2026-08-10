/**
 * The slice of LSP 3.17 this server speaks, written out rather than depended on.
 *
 * `vscode-languageserver-protocol` would supply these, but it would also supply
 * a JSON-RPC implementation, a connection, a document store and a dependency on
 * `vscode-jsonrpc`'s Node bindings — and SPEC 29.4 asks for a *thin adapter*.
 * Declaring the structures we actually put on the wire keeps the package
 * dependency-free, keeps `@mdv/lsp` honest about which capabilities exist
 * (there is no type here for a feature the server does not answer), and lets
 * the web-worker build stay free of Node.
 *
 * Field names are wire names and must match the specification exactly. Where
 * LSP allows several shapes for one field, only the shape this server sends or
 * accepts is declared.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Text documents and positions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zero-based line, and a character offset **in UTF-16 code units** — the
 * default `positionEncoding`. A JavaScript string index is exactly that, which
 * is why every conversion in this package goes through a source offset rather
 * than through a column count.
 */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface TextDocumentIdentifier {
  readonly uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  readonly version: number;
}

export interface TextDocumentItem {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

export interface TextDocumentPositionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly position: Position;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

export interface WorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly TextEdit[]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Synchronisation
// ─────────────────────────────────────────────────────────────────────────────

export const TextDocumentSyncKind = {
  none: 0,
  full: 1,
  incremental: 2,
} as const;

export type TextDocumentSyncKindValue =
  (typeof TextDocumentSyncKind)[keyof typeof TextDocumentSyncKind];

export interface DidOpenTextDocumentParams {
  readonly textDocument: TextDocumentItem;
}

/** A change with no `range` replaces the whole document (full sync). */
export interface TextDocumentContentChangeEvent {
  readonly range?: Range;
  readonly text: string;
}

export interface DidChangeTextDocumentParams {
  readonly textDocument: VersionedTextDocumentIdentifier;
  readonly contentChanges: readonly TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface DidSaveTextDocumentParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly text?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

export const DiagnosticSeverity = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4,
} as const;

export type DiagnosticSeverityValue = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export const DiagnosticTag = {
  unnecessary: 1,
  deprecated: 2,
} as const;

export type DiagnosticTagValue = (typeof DiagnosticTag)[keyof typeof DiagnosticTag];

export interface CodeDescription {
  readonly href: string;
}

export interface DiagnosticRelatedInformation {
  readonly location: Location;
  readonly message: string;
}

export interface Diagnostic {
  readonly range: Range;
  readonly severity?: DiagnosticSeverityValue;
  readonly code?: string;
  readonly codeDescription?: CodeDescription;
  readonly source?: string;
  readonly message: string;
  readonly tags?: readonly DiagnosticTagValue[];
  readonly relatedInformation?: readonly DiagnosticRelatedInformation[];
  /** Round-tripped by the client, which is how a code action finds its fix. */
  readonly data?: unknown;
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly version?: number;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * What `diagnosticProvider` promises (3.17's pull diagnostics).
 *
 * Both flags are statements about MDV rather than about effort.
 * `interFileDependencies: false`: a document's diagnostics come from its own
 * text and the configuration in force, never from another open file, so the
 * client may re-ask for one document alone. `workspaceDiagnostics: false`: the
 * server validates what the editor has open; walking a repository is `mdv lint`,
 * and a language server that opened every file to squiggle it would be a
 * surprise rather than a feature.
 */
export interface DiagnosticOptions {
  readonly identifier?: string;
  readonly interFileDependencies: boolean;
  readonly workspaceDiagnostics: boolean;
}

export interface DocumentDiagnosticParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly identifier?: string;
  /** The `resultId` of the last report the client got for this document. */
  readonly previousResultId?: string;
}

export const DocumentDiagnosticReportKind = {
  full: 'full',
  unchanged: 'unchanged',
} as const;

export type DocumentDiagnosticReportKindValue =
  (typeof DocumentDiagnosticReportKind)[keyof typeof DocumentDiagnosticReportKind];

export interface FullDocumentDiagnosticReport {
  readonly kind: 'full';
  readonly resultId?: string;
  readonly items: readonly Diagnostic[];
}

/** "Nothing has changed since `resultId`" — the client keeps what it has. */
export interface UnchangedDocumentDiagnosticReport {
  readonly kind: 'unchanged';
  readonly resultId: string;
}

export type DocumentDiagnosticReport =
  FullDocumentDiagnosticReport | UnchangedDocumentDiagnosticReport;

// ─────────────────────────────────────────────────────────────────────────────
// Completion
// ─────────────────────────────────────────────────────────────────────────────

export const CompletionItemKind = {
  text: 1,
  method: 2,
  function: 3,
  constructor: 4,
  field: 5,
  variable: 6,
  class: 7,
  interface: 8,
  module: 9,
  property: 10,
  unit: 11,
  value: 12,
  enum: 13,
  keyword: 14,
  snippet: 15,
  color: 16,
  file: 17,
  reference: 18,
  folder: 19,
  enumMember: 20,
  constant: 21,
  struct: 22,
  event: 23,
  operator: 24,
  typeParameter: 25,
} as const;

export type CompletionItemKindValue = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];

export const InsertTextFormat = {
  plainText: 1,
  snippet: 2,
} as const;

export type InsertTextFormatValue = (typeof InsertTextFormat)[keyof typeof InsertTextFormat];

export const MarkupKind = {
  plainText: 'plaintext',
  markdown: 'markdown',
} as const;

export type MarkupKindValue = (typeof MarkupKind)[keyof typeof MarkupKind];

export interface MarkupContent {
  readonly kind: MarkupKindValue;
  readonly value: string;
}

export interface CompletionItem {
  readonly label: string;
  readonly kind?: CompletionItemKindValue;
  readonly detail?: string;
  readonly documentation?: MarkupContent;
  readonly sortText?: string;
  readonly filterText?: string;
  readonly insertText?: string;
  readonly insertTextFormat?: InsertTextFormatValue;
  readonly textEdit?: TextEdit;
  readonly preselect?: boolean;
}

export interface CompletionList {
  readonly isIncomplete: boolean;
  readonly items: readonly CompletionItem[];
}

export interface CompletionParams extends TextDocumentPositionParams {
  readonly context?: {
    readonly triggerKind: number;
    readonly triggerCharacter?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover, signature help, inlay hints
// ─────────────────────────────────────────────────────────────────────────────

export interface Hover {
  readonly contents: MarkupContent;
  readonly range?: Range;
}

export interface ParameterInformation {
  readonly label: string;
  readonly documentation?: MarkupContent;
}

export interface SignatureInformation {
  readonly label: string;
  readonly documentation?: MarkupContent;
  readonly parameters?: readonly ParameterInformation[];
  readonly activeParameter?: number;
}

export interface SignatureHelp {
  readonly signatures: readonly SignatureInformation[];
  readonly activeSignature?: number;
  readonly activeParameter?: number;
}

export const InlayHintKind = {
  type: 1,
  parameter: 2,
} as const;

export type InlayHintKindValue = (typeof InlayHintKind)[keyof typeof InlayHintKind];

export interface InlayHint {
  readonly position: Position;
  readonly label: string;
  readonly kind?: InlayHintKindValue;
  readonly tooltip?: MarkupContent;
  readonly paddingLeft?: boolean;
  readonly paddingRight?: boolean;
}

export interface InlayHintParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly range: Range;
}

// ─────────────────────────────────────────────────────────────────────────────
// Symbols, folding, lenses
// ─────────────────────────────────────────────────────────────────────────────

export const SymbolKind = {
  file: 1,
  module: 2,
  namespace: 3,
  package: 4,
  class: 5,
  method: 6,
  property: 7,
  field: 8,
  constructor: 9,
  enum: 10,
  interface: 11,
  function: 12,
  variable: 13,
  constant: 14,
  string: 15,
  number: 16,
  boolean: 17,
  array: 18,
  object: 19,
  key: 20,
  null: 21,
  enumMember: 22,
  struct: 23,
  event: 24,
  operator: 25,
  typeParameter: 26,
} as const;

export type SymbolKindValue = (typeof SymbolKind)[keyof typeof SymbolKind];

export interface DocumentSymbol {
  readonly name: string;
  readonly detail?: string;
  readonly kind: SymbolKindValue;
  /** The whole construct, including its children. */
  readonly range: Range;
  /** The part to reveal and highlight — never wider than `range`. */
  readonly selectionRange: Range;
  readonly children?: readonly DocumentSymbol[];
}

export interface DocumentSymbolParams {
  readonly textDocument: TextDocumentIdentifier;
}

export const FoldingRangeKind = {
  comment: 'comment',
  imports: 'imports',
  region: 'region',
} as const;

export type FoldingRangeKindValue = (typeof FoldingRangeKind)[keyof typeof FoldingRangeKind];

export interface FoldingRange {
  readonly startLine: number;
  readonly startCharacter?: number;
  readonly endLine: number;
  readonly endCharacter?: number;
  readonly kind?: FoldingRangeKindValue;
  readonly collapsedText?: string;
}

export interface FoldingRangeParams {
  readonly textDocument: TextDocumentIdentifier;
}

export interface Command {
  readonly title: string;
  readonly command: string;
  readonly arguments?: readonly unknown[];
}

export interface CodeLens {
  readonly range: Range;
  readonly command?: Command;
  readonly data?: unknown;
}

export interface CodeLensParams {
  readonly textDocument: TextDocumentIdentifier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Code actions
// ─────────────────────────────────────────────────────────────────────────────

export const CodeActionKind = {
  quickFix: 'quickfix',
  refactor: 'refactor',
  refactorExtract: 'refactor.extract',
  source: 'source',
  sourceFixAll: 'source.fixAll',
} as const;

export type CodeActionKindValue = (typeof CodeActionKind)[keyof typeof CodeActionKind];

export interface CodeAction {
  readonly title: string;
  readonly kind?: CodeActionKindValue;
  readonly diagnostics?: readonly Diagnostic[];
  readonly isPreferred?: boolean;
  readonly edit?: WorkspaceEdit;
  readonly command?: Command;
}

export interface CodeActionContext {
  readonly diagnostics: readonly Diagnostic[];
  readonly only?: readonly string[];
}

export interface CodeActionParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly range: Range;
  readonly context: CodeActionContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting, definition, references, rename
// ─────────────────────────────────────────────────────────────────────────────

export interface FormattingOptions {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly trimTrailingWhitespace?: boolean;
  readonly insertFinalNewline?: boolean;
}

export interface DocumentFormattingParams {
  readonly textDocument: TextDocumentIdentifier;
  readonly options: FormattingOptions;
}

export interface DocumentRangeFormattingParams extends DocumentFormattingParams {
  readonly range: Range;
}

export interface ReferenceParams extends TextDocumentPositionParams {
  readonly context: { readonly includeDeclaration: boolean };
}

export interface RenameParams extends TextDocumentPositionParams {
  readonly newName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic tokens
// ─────────────────────────────────────────────────────────────────────────────

export interface SemanticTokensLegend {
  readonly tokenTypes: readonly string[];
  readonly tokenModifiers: readonly string[];
}

export interface SemanticTokens {
  readonly resultId?: string;
  /** Five integers per token: Δline, Δstart, length, type, modifiers. */
  readonly data: readonly number[];
}

export interface SemanticTokensParams {
  readonly textDocument: TextDocumentIdentifier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  readonly textDocument?: {
    readonly publishDiagnostics?: {
      readonly versionSupport?: boolean;
      readonly codeDescriptionSupport?: boolean;
    };
    readonly completion?: {
      readonly completionItem?: {
        readonly snippetSupport?: boolean;
        readonly documentationFormat?: readonly MarkupKindValue[];
      };
    };
    readonly hover?: { readonly contentFormat?: readonly MarkupKindValue[] };
    /** Present when the client pulls diagnostics instead of being pushed them. */
    readonly diagnostic?: {
      readonly dynamicRegistration?: boolean;
      readonly relatedDocumentSupport?: boolean;
    };
  };
  readonly workspace?: {
    readonly configuration?: boolean;
    readonly workspaceFolders?: boolean;
    readonly diagnostics?: { readonly refreshSupport?: boolean };
  };
  readonly general?: {
    readonly positionEncodings?: readonly string[];
  };
}

export interface WorkspaceFolder {
  readonly uri: string;
  readonly name: string;
}

export interface InitializeParams {
  readonly processId?: number | null;
  readonly clientInfo?: { readonly name: string; readonly version?: string };
  readonly locale?: string;
  readonly rootUri?: string | null;
  readonly capabilities: ClientCapabilities;
  readonly initializationOptions?: unknown;
  readonly trace?: string;
  readonly workspaceFolders?: readonly WorkspaceFolder[] | null;
}

export interface CompletionOptions {
  readonly triggerCharacters?: readonly string[];
  readonly resolveProvider?: boolean;
}

export interface SignatureHelpOptions {
  readonly triggerCharacters?: readonly string[];
  readonly retriggerCharacters?: readonly string[];
}

export interface CodeActionOptions {
  readonly codeActionKinds?: readonly CodeActionKindValue[];
}

export interface SemanticTokensOptions {
  readonly legend: SemanticTokensLegend;
  readonly full?: boolean;
}

export interface RenameOptions {
  readonly prepareProvider?: boolean;
}

export interface ServerCapabilities {
  readonly positionEncoding?: string;
  readonly textDocumentSync?: {
    readonly openClose: boolean;
    readonly change: TextDocumentSyncKindValue;
    readonly save?: boolean | { readonly includeText: boolean };
  };
  readonly completionProvider?: CompletionOptions;
  readonly hoverProvider?: boolean;
  readonly signatureHelpProvider?: SignatureHelpOptions;
  readonly definitionProvider?: boolean;
  readonly referencesProvider?: boolean;
  readonly documentSymbolProvider?: boolean;
  readonly codeActionProvider?: boolean | CodeActionOptions;
  readonly codeLensProvider?: { readonly resolveProvider?: boolean };
  readonly documentFormattingProvider?: boolean;
  readonly documentRangeFormattingProvider?: boolean;
  readonly renameProvider?: boolean | RenameOptions;
  readonly foldingRangeProvider?: boolean;
  readonly inlayHintProvider?: boolean;
  readonly semanticTokensProvider?: SemanticTokensOptions;
  readonly diagnosticProvider?: DiagnosticOptions;
  readonly workspace?: {
    readonly workspaceFolders?: {
      readonly supported: boolean;
      readonly changeNotifications?: boolean | string;
    };
  };
}

export interface InitializeResult {
  readonly capabilities: ServerCapabilities;
  readonly serverInfo?: { readonly name: string; readonly version?: string };
}

export interface DidChangeConfigurationParams {
  readonly settings: unknown;
}

export interface LogMessageParams {
  readonly type: number;
  readonly message: string;
}

export const MessageType = {
  error: 1,
  warning: 2,
  info: 3,
  log: 4,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];
