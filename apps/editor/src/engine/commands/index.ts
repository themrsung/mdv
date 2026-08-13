/**
 * The command layer.
 *
 * Everything a UI can do to a document is here, as a factory returning a
 * {@link Command}. Commands are values: bind them to keys, compose them with
 * `sequence`, or call them in a test without a DOM in sight.
 */

export {
  ancestorIds,
  blocksBetween,
  caretNear,
  deleteCellRange,
  deleteSelection,
  deleteTextRange,
  isMergeable,
  pruneEmptyContainers,
  removeBlocks,
  spliceAt,
} from './shared.js';
export type { EditOutcome } from './shared.js';

export {
  clearSelection,
  deleteBackward,
  deleteForward,
  insertText,
  setContainerText,
} from './text.js';

export {
  deleteBlocks,
  indent,
  indentItem,
  mergeBackward,
  mergeBlocks,
  mergeForward,
  nextLeaf,
  outdent,
  outdentItem,
  previousLeaf,
  selectBlock,
  setBlockType,
  setCodeInfo,
  splitBlock,
  touchedBlocks,
} from './structure.js';
export type { BlockTypeSpec } from './structure.js';

export { activeMarks, clearMarks, isMarkActive, selectedSpans, toggleMark } from './marks.js';

export {
  appendParagraph,
  blockPlainText,
  insertBlocksAtSelection,
  insertFragment,
  insertImage,
  insertParagraphAfter,
  insertTable,
  insertThematicBreak,
  insertVisualBlock,
  isEmptyBlock,
  updateImage,
  updateVisualBlock,
} from './insert.js';
export type { InsertImageOptions, InsertVisualOptions } from './insert.js';

export {
  caretInCell,
  copyCells,
  deleteColumns,
  deleteRows,
  insertColumnLeft,
  insertColumnRight,
  insertRowAbove,
  insertRowBelow,
  moveColumn,
  moveRow,
  navigateCell,
  pasteCells,
  selectCells,
  selectWholeTable,
  setColumnAlignment,
  tableFocus,
} from './tables.js';
export type { TableFocus } from './tables.js';
