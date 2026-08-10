import type { ConformanceLevel } from '@mdv/spec';

/** Options for {@link parse} (SPEC 21). */
export interface ParseOptions {
  /**
   * Document URI or path. Used as the base for relative `src:` resolution at
   * stage 2 and as the `uri` on diagnostics. Never fetched by the parser.
   */
  from?: string;
  /**
   * Conformance level to parse at (SPEC 16.1). Constructs above this level are
   * not errors: they degrade per SPEC 15.2 and produce an info diagnostic.
   *
   * @defaultValue 2
   */
  level?: ConformanceLevel;
  /**
   * Keep raw HTML nodes instead of escaping them.
   *
   * @defaultValue false — SPEC 4: raw HTML is disabled by default and escaping
   * emits `MDV4011`. This differs from CommonMark deliberately.
   */
  allowHtml?: boolean;
  /**
   * Parse `$…$` and `$$…$$` as math (SPEC 4: SHOULD at Level 2, MUST at Level 3).
   *
   * @defaultValue true at level 3, false below
   */
  math?: boolean;
  /**
   * Parse generic directives (SPEC 9).
   *
   * @defaultValue true
   */
  directives?: boolean;
  /**
   * Parse leading YAML front matter (SPEC 3.4).
   *
   * @defaultValue true
   */
  frontmatter?: boolean;
  /**
   * Hard size limit in bytes. Exceeding it yields a single `MDV4000` diagnostic
   * and an otherwise empty document — the parser does not attempt partial work.
   */
  maxBytes?: number;
}

/**
 * Options for {@link toMarkdown} — the canonical serialiser behind `mdv fmt` and
 * the LSP formatter (SPEC 27).
 *
 * Serialisation MUST be idempotent and MUST NOT change the resolved AST. The
 * defaults below *are* the canonical form; overriding them produces valid MDV
 * that `mdv fmt --check` will still want to rewrite.
 */
export interface FormatOptions {
  /**
   * Header indentation width. SPEC 5.3.1 requires exactly 2 spaces per level;
   * any other value produces `MDV1212` on re-parse.
   *
   * @defaultValue 2
   */
  indent?: number;
  /**
   * Pad pipe-table columns to a common width.
   *
   * @defaultValue true
   */
  alignTables?: boolean;
  /**
   * Emit attributes in the canonical order (a fixed order, then alphabetical)
   * rather than in source order.
   *
   * @defaultValue true
   */
  canonicalAttrOrder?: boolean;
  /**
   * Insert the delimiter row into `table` block data when it is missing.
   *
   * @defaultValue true
   */
  insertTableDelimiter?: boolean;
  /** @defaultValue '-' */
  bullet?: '-' | '*' | '+';
  /** @defaultValue '`' — tildes are used automatically when the info string contains a backtick. */
  fence?: '`' | '~';
  /** Quote style used only where quoting is required (SPEC 5.3.1). @defaultValue '"' */
  quote?: '"' | "'";
  /**
   * Wrap prose at this column. `0` disables wrapping, which is the default:
   * rewrapping prose creates diff noise that has nothing to do with the document.
   *
   * @defaultValue 0
   */
  lineWidth?: number;
}
