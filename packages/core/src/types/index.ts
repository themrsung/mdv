/**
 * The `@mdv/core` type surface — the integration contract between every package.
 *
 * One module per concern:
 *
 * | Module          | Concern |
 * |-----------------|---------|
 * | `scene.ts`      | the scene graph (SPEC 20) — the IR every backend consumes |
 * | `theme.ts`      | theme tokens, palettes, mark specs (SPEC 11) |
 * | `config.ts`     | `MdvConfig` and the injected `Capabilities` (SPEC 25) |
 * | `data.ts`       | the table, datasets, transforms (SPEC 6) |
 * | `attrs.ts`      | block attributes after the cascade (SPEC 8.1, 5.5) |
 * | `encode.ts`     | channels, scales, series identity, marks (SPEC 7, 18.5) |
 * | `layout.ts`     | `LayoutContext`, `TextMetrics`, geometry primitives (SPEC 18.6) |
 * | `resolved.ts`   | `ResolvedDocument`, `ResolvedBlock` (SPEC 18.2) |
 * | `diagnostics.ts`| the `Diagnostic` re-export plus its constructors (SPEC 14) |
 */

// Scene graph (SPEC 20)
export type {
  A11yColumn,
  A11yRole,
  A11yTable,
  A11yTree,
  ArcCommand,
  CircleNode,
  ClipDef,
  ClosePathCommand,
  CubicCommand,
  Def,
  Font,
  GradientPaint,
  GradientStop,
  GradientUnits,
  GroupNode,
  HitRegion,
  ImageNode,
  LineCommand,
  LineNode,
  LinearGradientDef,
  MoveCommand,
  Paint,
  PathCommand,
  PathNode,
  PatternDef,
  PatternPaint,
  QuadraticCommand,
  RadialGradientDef,
  ReadoutRow,
  RectNode,
  Scene,
  SceneMeta,
  SceneNode,
  SceneNodeBase,
  SceneNodeKind,
  SolidPaint,
  Stroke,
  SymbolDef,
  TextNode,
  Transform,
  UseNode,
} from './scene.js';

// Theme (SPEC 11)
export { ALL_PAIRS_SERIES_CAP, CATEGORICAL_SLOT_COUNT, STATUS_PALETTE } from './theme.js';
export type {
  CategoricalPalette,
  ColorScheme,
  ColorSchemePreference,
  ColorString,
  DivergingPalette,
  MarkSpec,
  PaletteCheck,
  PaletteFinding,
  PaletteValidation,
  SequentialPalette,
  StatusPalette,
  StatusRole,
  Theme,
  ThemeColorRole,
  ThemeColorTokens,
  ThemeMetricTokens,
  ThemeOverride,
  ThemeTypeTokens,
} from './theme.js';

// Configuration (SPEC 25)
export { MdvConfigError } from './config.js';
export type {
  A11yConfig,
  Capabilities,
  FetchInit,
  FetchResult,
  KeyValueCache,
  Logger,
  MdvConfig,
  MdvPlugin,
  RenderConfig,
  ResolvedConfig,
  SceneSerializer,
  SecurityConfig,
} from './config.js';

// Data model (SPEC 6)
export type {
  AggregateArg,
  AggregateOp,
  AggregateStep,
  BinStep,
  Column,
  DataFormat,
  DataRegistry,
  DataType,
  DatasetNode,
  DatasetOrigin,
  DatasetState,
  DeriveStep,
  Expression,
  Field,
  FieldDecl,
  FieldRef,
  FieldType,
  FilterStep,
  FormatSpec,
  JoinStep,
  LimitStep,
  PivotStep,
  RenameStep,
  RowIndex,
  SelectStep,
  SortStep,
  Table,
  TableRef,
  TransformPipeline,
  TransformStep,
  UnpivotStep,
  Value,
  WindowOp,
  WindowStep,
} from './data.js';

// Block attributes (SPEC 8.1)
export {
  DATA_FORMATS,
  columnsAttrOf,
  dataFormatOf,
  facetWrapOf,
  formatAttrOf,
  isDataFormat,
  numberFormatOf,
  tableColumnsOf,
} from './attrs.js';
export type {
  BlockAttrs,
  ColumnsAttr,
  ColumnsMeaning,
  Dimension,
  FormatAttr,
  FormatMeaning,
  LegendAttr,
  PaddingAttr,
  TableCellHeat,
  TableCellType,
  TableColumnAttr,
  TableColumnsAttr,
  TableViewAttr,
  TooltipAttr,
} from './attrs.js';

// Encoding (SPEC 7, SPEC 18 stage 5)
export type {
  ArcMark,
  AxisModel,
  AxisSpec,
  BarMark,
  BoxMark,
  CellMark,
  Channel,
  ChannelAggregate,
  ChannelName,
  ChannelSpec,
  Encoding,
  LegendEntry,
  LegendModel,
  LegendPosition,
  LegendRamp,
  LegendRampLabel,
  LegendSymbol,
  LineMark,
  LinePointMark,
  LinkMark,
  Mark,
  MarkBase,
  MarkKind,
  MarkSet,
  NodeMark,
  OhlcMark,
  PointMark,
  RuleMark,
  Scale,
  ScaleBundle,
  ScaleInput,
  ScaleSpec,
  ScaleType,
  SeriesDescriptor,
  TextMark,
} from './encode.js';

// Layout (SPEC 18 stage 6)
export type {
  GlyphMetrics,
  IdFactory,
  Insets,
  LayoutA11yOptions,
  LayoutContext,
  Rect,
  Size,
  TextMetrics,
} from './layout.js';

// Resolved document (SPEC 18 stage 2)
export type { ResolvedBlock, ResolvedDocument } from './resolved.js';

// Diagnostics (SPEC 14)
export {
  DOCUMENT_START,
  applyStrict,
  atLeast,
  compareDiagnostics,
  createDiagnostic,
  isBlocking,
} from './diagnostics.js';
export type {
  CodeFix,
  Diagnostic,
  DiagnosticInit,
  DiagnosticSeverity,
  DiagnosticSource,
  Position,
  Range,
  TextEdit,
} from './diagnostics.js';
