/**
 * The MDV editing engine.
 *
 * A self-contained, dependency-free, framework-free editing core for `.mdv`
 * documents: an immutable document model, a selection algebra, a command layer
 * that produces transactions, an undo stack, image ingestion, clipboard
 * normalisation, and its own reader and writer for `.mdv` text.
 *
 * It shares no code with the `@mdv/parser` pipeline by design. The parser's job
 * is to be *correct* about a specification; the editor's job is to be *fast* and
 * *reversible* about a live document, which wants a different data structure
 * and a much more forgiving reader. Keeping them apart means neither has to
 * compromise, and it means this package can be loaded without pulling micromark
 * into the editor bundle.
 *
 * @example Wire an editor up
 * ```ts
 * import { createEditor, commands } from './engine/index.js';
 *
 * const editor = createEditor({ text: '# Title\n\nHello.\n' });
 * editor.dispatch(commands.toggleMark('strong'));
 * editor.toText();
 * ```
 *
 * @packageDocumentation
 */

/* -- Identity ------------------------------------------------------------- */

export type { IdFactory, NodeId } from './ids.js';
export { createIdFactory, reassignIds } from './ids.js';

export type { EngineErrorCode } from './errors.js';
export { EngineError } from './errors.js';

/* -- Document model ------------------------------------------------------- */

export type {
  AtomicBlock,
  Block,
  BlockKind,
  BlockquoteBlock,
  BulletListBlock,
  CodeBlock,
  CodeFence,
  CodeMark,
  ColumnAlign,
  ContainerBlock,
  EmphasisMark,
  FenceStyle,
  FrontMatter,
  HeadingBlock,
  HeadingLevel,
  ImageBlock,
  InfoAttribute,
  LinkMark,
  ListBlock,
  ListItem,
  Mark,
  MarkType,
  MdvDocument,
  OrderedListBlock,
  ParagraphBlock,
  RawBlock,
  RawRun,
  Run,
  RunBlock,
  StrikethroughMark,
  StrongMark,
  TableBlock,
  TableCell,
  TableRow,
  TextBlock,
  TextRun,
  ThematicBreakBlock,
  VisualBlock,
} from './model.js';
export { isAtomicBlock, isContainerBlock, isRunBlock, isTextBlock } from './model.js';

/** Constructors for every node kind. Namespaced because `document` and `table` are common words. */
export * as builders from './builders.js';

/* -- Inline runs ---------------------------------------------------------- */

export type { RunOffset } from './inline.js';
export {
  absolute,
  commonMarks,
  findMark,
  hasMarkType,
  locate,
  mapMarks,
  markEquals,
  marksAt,
  marksEqual,
  normalizeRuns,
  rawRun,
  runLength,
  runMarks,
  runsEqual,
  runsLength,
  runsText,
  runText,
  sliceRuns,
  sortMarks,
  spliceRuns,
  textRun,
  withMark,
  withoutMark,
} from './inline.js';

/* -- Grapheme segmentation ------------------------------------------------ */

export type { GraphemeSegmenter } from './grapheme.js';
export {
  defaultSegmenter,
  fallbackSegmenter,
  graphemeLength,
  nextBoundary,
  previousBoundary,
} from './grapheme.js';

/* -- Tree navigation ------------------------------------------------------ */

export type { BlockLocation, ParentRef } from './tree.js';
export {
  allBlocks,
  enclosingListItem,
  findBlock,
  findListItem,
  insertBlocks,
  leafBlocks,
  replaceBlock,
  replaceBlockWith,
  requireBlock,
  ROOT,
  sameParent,
  siblingsOf,
  updateBlock,
  walkBlocks,
  withSiblings,
} from './tree.js';

/* -- Selection ------------------------------------------------------------ */

export type {
  CellRect,
  CellRef,
  CellSelection,
  InlineContainer,
  NodeSelection,
  Point,
  Selection,
  TextSelection,
} from './selection.js';
export {
  blockOrderIndex,
  caret,
  cellRect,
  comparePoints,
  containerLength,
  containerOf,
  containerPath,
  endOfBlock,
  fromAbsolute,
  isCollapsed,
  isNormalized,
  normalizePoint,
  normalizeSelection,
  orderedPoints,
  point,
  pointsEqual,
  range,
  requireContainer,
  resolveContainer,
  runIndex,
  selectionsEqual,
  startOfBlock,
  toAbsolute,
  wholeDocument,
  writeContainer,
} from './selection.js';

export type { ContainerAddress, PointMap } from './mapping.js';
export { addressOf, clampingMap, MappingBuilder, mapSelection, sameAddress } from './mapping.js';

/* -- Tables --------------------------------------------------------------- */

export type { CellDirection, CellGrid, PasteRectOptions } from './table.js';
export {
  appendRow,
  assertRectangular,
  bodyRowCount,
  cellAt,
  clampRect,
  clampRef,
  clearCells,
  columnCount,
  deleteColumn,
  deleteRow,
  extractRect,
  headerCellIds,
  insertColumn,
  insertRow,
  isRectangular,
  makeRectangular,
  moveCell,
  moveColumn,
  moveRow,
  pasteRect,
  refsInRect,
  rowCount,
  setCellRuns,
  setColumnAlign,
  tableFromGrid,
  wholeTableRect,
} from './table.js';

/* -- State, commands, history, store -------------------------------------- */

export type {
  Command,
  CommandLabel,
  CommandResult,
  EditContext,
  EditorState,
  Transaction,
} from './state.js';
export { applyCommand, createContext, createState, sequence, withSelection } from './state.js';

/** Every editing operation, as a command factory. */
export * as commands from './commands/index.js';

export type { History, HistoryEntry, HistoryStep } from './history.js';
export {
  breakCoalescing,
  canRedo,
  canUndo,
  createHistory,
  record,
  redo,
  redoLabel,
  undo,
  undoLabel,
} from './history.js';

export type { Editor, EditorListener, EditorOptions, EditorSnapshot } from './editor.js';
export { createEditor } from './editor.js';

/* -- Serialisation -------------------------------------------------------- */

export type { ReadOptions } from './io/read.js';
export { read } from './io/read.js';
export type { WriteOptions } from './io/write.js';
export { write, writeBlocks } from './io/write.js';

/** Attribute parsing, escaping, and the lower-level reader and writer entry points. */
export * as io from './io/index.js';

/* -- Images and clipboard ------------------------------------------------- */

/** Blob → downscaled, re-encoded, embedded data URI. */
export * as images from './image/index.js';

/** Paste normalisation and the three copy flavours. */
export * as clipboard from './clipboard/index.js';
