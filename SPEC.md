# MDV — Markdown Visual

**Specification 1.0 — Draft**

A superset of Markdown that carries charts, financial plots, heatmaps and other
data visuals **as plain text**, rendered at view time by a conforming reader.

| | |
|---|---|
| **Spec version** | 1.0.0-draft.1 |
| **Status** | Draft — normative for the reference implementation |
| **File extension** | `.mdv` (also `.md` when a reader opts in) |
| **Media type** | `text/vnd.mdv` (fallback `text/markdown`) |
| **Base syntax** | CommonMark 0.31.2 + GFM tables, strikethrough, task lists, autolinks |
| **Reference impl.** | TypeScript (ESM), React web renderer, PDF exporter, VS Code extension |
| **License** | Spec: CC BY 4.0 · Reference implementation: MIT |

---

## Table of contents

**Part 0 — Preliminaries**
[0. About this document](#0-about-this-document) ·
[1. Introduction](#1-introduction) ·
[2. Terminology](#2-terminology)

**Part I — The format**
[3. File format](#3-file-format) ·
[4. Base syntax](#4-base-syntax) ·
[5. The visual block](#5-the-visual-block) ·
[6. Data model](#6-data-model) ·
[7. Encoding model](#7-encoding-model) ·
[8. Chart catalog](#8-chart-catalog) ·
[9. Directives](#9-directives-inline-and-block) ·
[10. Enhanced tables](#10-enhanced-tables) ·
[11. Theming and rendering defaults](#11-theming-and-rendering-defaults) ·
[12. Accessibility](#12-accessibility) ·
[13. Security model](#13-security-model) ·
[14. Errors and diagnostics](#14-errors-and-diagnostics) ·
[15. Extensibility](#15-extensibility) ·
[16. Conformance](#16-conformance)

**Part II — The reader**
[17. Architecture](#17-architecture) ·
[18. Pipeline](#18-processing-pipeline) ·
[19. AST](#19-the-mdv-ast) ·
[20. Scene graph](#20-the-scene-graph) ·
[21. Core API](#21-core-typescript-api) ·
[22. React binding](#22-react-binding) ·
[23. Render backends](#23-render-backends) ·
[24. Performance](#24-performance-requirements) ·
[25. Configuration](#25-configuration) ·
[26. Plugin API](#26-plugin-api) ·
[27. CLI](#27-cli)

**Part III — PDF export**
[28. PDF export](#28-pdf-export)

**Part IV — VS Code extension**
[29. VS Code extension](#29-vs-code-extension)

**Part V — Appendices**
[A. Grammar](#appendix-a--grammar) ·
[B. Attribute index](#appendix-b--attribute-index) ·
[C. Error codes](#appendix-c--error-codes) ·
[D. JSON Schema](#appendix-d--json-schema-excerpt) ·
[E. Worked example](#appendix-e--worked-example) ·
[F. Repository layout & milestones](#appendix-f--repository-layout--milestones) ·
[G. Open questions](#appendix-g--open-questions)

---

# 0. About this document

## 0.1 Scope

This document specifies four things:

1. **The MDV format** — the textual syntax and semantics of a `.mdv` document
   (Part I). This is the interoperability surface: any implementation that reads
   MDV must agree here.
2. **The reader software** — architecture, module boundaries, TypeScript API and
   React binding of the reference implementation (Part II).
3. **PDF export** — the page model and the requirements that make exported PDFs
   deterministic, vector, and accessible (Part III).
4. **The VS Code extension** — contributions, preview, and language server
   (Part IV).

Parts II–IV describe the *reference* implementation. Another implementation may
differ in architecture and remain conforming, provided it satisfies Part I and
the conformance requirements of [§16](#16-conformance).

## 0.2 Conformance keywords

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be
interpreted as described in BCP 14 ([RFC 2119], [RFC 8174]) when, and only when,
they appear in all capitals.

Examples are non-normative unless introduced by "the following is normative".

## 0.3 Versioning

The specification is versioned with [Semantic Versioning](https://semver.org):

- **PATCH** — editorial fixes, clarifications that do not change conforming behaviour.
- **MINOR** — new chart types, new attributes, new directives. Backward compatible:
  a 1.0 document MUST render identically under a 1.<em>n</em> reader.
- **MAJOR** — removal or redefinition of existing syntax.

A document declares the spec version it targets in front matter (`mdv: "1.0"`).
Readers MUST implement the compatibility rules in [§15.3](#153-version-negotiation).

---

# 1. Introduction

## 1.1 Motivation

Markdown won because it is *legible as source*. A table in Markdown is a table
even in a terminal. Charts never got that treatment: today a chart in a document
is either a binary image (opaque, unreviewable, undiffable, stale the moment the
data changes) or a code block in some plotting language (executable, unsafe,
and requiring a runtime).

MDV takes the third path. A chart is **data plus a declaration of intent**, both
in plain text, both diffable, neither executable:

````markdown
```mdv bar
title: Quarterly revenue
x: quarter
y: revenue
---
quarter | revenue
Q1      | 1240
Q2      | 1516
Q3      | 1402
Q4      | 1893
```
````

That block is a legible table in *any* Markdown viewer, a reviewable diff in any
code-review tool, and a rendered bar chart in a conforming reader.

## 1.2 Design principles

Normative tie-breakers. When a design question arises, these decide it, in order:

1. **Source legibility first.** If a construct is unreadable as plain text, it is
   the wrong construct. Data lives in tables, not in escaped JSON blobs.
2. **Graceful degradation.** Every MDV construct MUST be valid CommonMark. A
   non-MDV renderer shows the block as a code block containing readable data,
   never a parse error and never a broken document.
3. **Declarative, never executable.** A document describes *what to draw*. It
   never contains code, and a reader never evaluates document-supplied code.
   ([§13](#13-security-model))
4. **Deterministic rendering.** Same source + same theme + same version ⇒
   byte-identical output. This is what makes visual regression tests, PDF
   diffing, and content-addressed caching possible. ([§24.3](#243-determinism))
5. **Accessible by construction.** A visual that cannot be read by a screen
   reader, in grayscale, or by a reader with CVD is not finished.
   ([§12](#12-accessibility))
6. **Progressive disclosure.** Five lines produce a correct chart. Fifty lines
   produce a precisely controlled one. Nothing in the middle is required.
7. **One canonical spelling.** Where two syntaxes would both be reasonable, the
   spec picks one. Aliases fragment tooling.

## 1.3 Non-goals

MDV is explicitly **not**:

- A general-purpose grammar of graphics. Vega-Lite already exists and is better
  at that. MDV covers the visuals people actually put in documents, and provides
  an escape hatch ([§26](#26-plugin-api)) for the rest.
- A notebook or computation format. There are no cells, no kernels, no outputs.
  Transforms ([§6.7](#67-transforms)) are deliberately limited to a
  non-Turing-complete set.
- A dashboard framework. Live-updating data is a Level 3 optional feature
  ([§16.1](#161-levels)), off by default, and never required to read a document.
- A replacement for Markdown. It is a superset; a `.md` file is a valid `.mdv`
  file.

---

# 2. Terminology

| Term | Definition |
|---|---|
| **Document** | A complete `.mdv` source text. |
| **Front matter** | The optional YAML block at the head of a document ([§3.4](#34-front-matter)). |
| **Visual block** | A fenced code block whose info string begins with `mdv` ([§5](#5-the-visual-block)). |
| **Block type** | The identifier selecting what to draw: `bar`, `line`, `heatmap`, … |
| **Header section** | The attribute section of a visual block, before the `---` separator. |
| **Data section** | The tabular payload of a visual block, after the `---` separator. |
| **Attribute** | A `key: value` pair configuring a block. |
| **Dataset** | A named, reusable table declared by a `mdv dataset` block ([§6.3](#63-datasets-and-references)). |
| **Field** | A named column of a dataset. Also "column". |
| **Channel** | A visual property a field is mapped onto: `x`, `y`, `color`, `size`, … |
| **Encoding** | The complete mapping of fields to channels for one block. |
| **Mark** | An individual drawn primitive: a bar, a point, a candle, a cell. |
| **Series** | A group of marks sharing an identity and therefore a color slot. |
| **Scene graph** | The renderer-agnostic drawing IR produced by layout ([§20](#20-the-scene-graph)). |
| **Reader** | Software that parses and renders MDV. |
| **Target** | An output backend: DOM/SVG, Canvas, SVG string, PDF. |
| **Level** | A conformance tier: Core (1), Standard (2), Extended (3). |

---

# Part I — The format

# 3. File format

## 3.1 Identification

| Property | Value |
|---|---|
| Extension | `.mdv` (primary). `.mdown.mdv`, `.markdown` are not recognised. |
| Media type | `text/vnd.mdv` — registration to be filed; `text/markdown` is an acceptable fallback for transport. |
| Charset parameter | `charset=utf-8` is the only supported value. |
| Magic | None. MDV is text. Detection is by extension, media type, or the `mdv:` front-matter key. |

A reader MAY be configured to process `.md` files as MDV. When it does, it MUST
behave identically: MDV constructs are a strict superset, so a plain Markdown
file is unaffected.

## 3.2 Encoding

- A document **MUST** be valid UTF-8.
- A leading U+FEFF BYTE ORDER MARK **MUST** be stripped before parsing and
  **MUST NOT** be treated as content.
- Line endings **MAY** be LF or CRLF; a reader MUST normalise CRLF and CR to LF
  before parsing. Emitters (formatters, export) **MUST** write LF.
- U+0000 **MUST** be replaced by U+FFFD, per CommonMark.
- Documents **SHOULD** end with a trailing newline.
- Tabs inside a data section are significant only for `format: tsv`; elsewhere a
  tab is whitespace.

## 3.3 Document structure

```
document   := [ front-matter ] , { markdown-block | visual-block | directive } ;
```

Nothing else is structurally special. Visual blocks and directives are ordinary
Markdown leaf/container nodes as far as document structure is concerned, so they
nest inside lists, block quotes, and container directives exactly as code blocks
and HTML blocks do.

## 3.4 Front matter

A document MAY begin with YAML front matter: a line containing exactly `---`,
followed by YAML, terminated by a line containing exactly `---` or `...`. It
MUST start at byte 0 (after any BOM).

```yaml
---
mdv: "1.0"                    # spec version this document targets
title: Q4 Financial Review
author: Analytics
date: 2026-08-10
lang: en
theme: default                # or: dark, print, or a theme name/URL
locale: en-US
timezone: UTC

defaults:                     # attribute defaults for every visual block
  height: 320
  legend: auto
  numberFormat: ",.0f"

datasets:                     # front-matter-declared datasets
  targets:
    format: csv
    data: |
      quarter,target
      Q1,1200
      Q4,1800

pdf:                          # PDF export settings (§28)
  pageSize: A4
  margin: 20mm
  header: "{title}"
  footer: "{page} / {pages}"
---
```

**Reserved top-level keys.** `mdv`, `title`, `subtitle`, `author`, `date`,
`lang`, `theme`, `locale`, `timezone`, `defaults`, `datasets`, `pdf`, `security`,
`plugins`, `toc`, `numbering`. Unknown keys are preserved in the AST, exposed to
plugins, and otherwise ignored — they are conventionally used by static site
generators and MUST NOT produce an error.

**`mdv` key.** If absent, the reader assumes the latest version it implements
and MUST emit an `MDV1100` info diagnostic. Documents intended for archival
**SHOULD** declare it.

`lang` sets the document language for accessibility and hyphenation; it MUST be
a BCP 47 tag. `locale` governs number/date formatting defaults
([§6.9](#69-formatting)); it defaults to `lang` and then to `en-US`.

---

# 4. Base syntax

An MDV reader MUST implement:

| Feature | Source | Notes |
|---|---|---|
| CommonMark | [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) | Full. |
| Tables | GFM | Extended by [§10](#10-enhanced-tables). |
| Strikethrough | GFM | |
| Task lists | GFM | |
| Autolink literals | GFM | |
| Footnotes | GFM | Rendered as endnotes; in PDF as page or section notes ([§28.7](#287-notes-and-cross-references)). |
| Front matter | [§3.4](#34-front-matter) | YAML only. |
| Directives | [§9](#9-directives-inline-and-block) | Generic directive syntax. |
| Math | LaTeX in `$…$` / `$$…$$` | **SHOULD** at Level 2, MUST at Level 3. |

**Raw HTML is disabled by default.** CommonMark HTML blocks and inline HTML MUST
be escaped and rendered as text unless the embedder explicitly enables and
sanitises them ([§13.4](#134-html-and-embedded-content)). This differs from
CommonMark's default and is a deliberate security posture: MDV documents are
frequently third-party content.

---

# 5. The visual block

## 5.1 Syntax overview

````
```mdv <type> [key=value …]
<header section>
---
<data section>
```
````

- The opening fence MAY use backticks or tildes, three or more, per CommonMark.
  A fence containing backticks in its info string MUST use tildes.
- The info string **MUST** begin with the token `mdv`, followed by optional
  whitespace and the block type.
- The header section is [MDV attribute notation](#53-header-section).
- The `---` separator line, if present, ends the header and begins the data.
- Everything after the separator is the data section
  ([§6.2](#62-data-formats)).

### Determinism rule for the separator

> **A block body with no separator line is parsed entirely as a header section.**

There is no content sniffing. To supply data, write the separator — with an
empty header if there are no attributes:

````
```mdv pie
---
region | revenue
APAC   | 4210
EMEA   | 3180
```
````

Rationale: any heuristic that guesses whether a body is "attributes" or "data"
misfires on real documents (a CSV whose first column header contains a colon; an
attribute whose value contains a pipe). One rule, no ambiguity, and the error
message when an author forgets the separator is precise (`MDV1203`).

## 5.2 Info string

```abnf
info-string   = "mdv" [ 1*WSP block-type ] *( 1*WSP inline-attr )
block-type    = ALPHA *( ALPHA / DIGIT / "-" )
inline-attr   = attr-key "=" attr-value
attr-key      = ALPHA *( ALPHA / DIGIT / "-" / "_" )
attr-value    = bare-value / quoted-value
bare-value    = 1*( %x21-26 / %x28-7E )        ; no whitespace, no "'"
quoted-value  = DQUOTE *( qchar ) DQUOTE / "'" *( sqchar ) "'"
```

- The block type is case-insensitive and normalised to lowercase.
- If the block type is omitted, the header MUST supply `type:`; otherwise
  `MDV1201`.
- Inline attributes are a shorthand, useful for one-liners:
  `` ```mdv sparkline data="1,4,2,8" ``.
- Unknown block types trigger the fallback behaviour of
  [§15.2](#152-unknown-constructs), not an error.

**Reserved non-chart types:** `dataset`, `config`, `theme`, `include`, `raw`.

## 5.3 Header section

The header uses **MDV attribute notation** — a deliberately small, deterministic
subset of YAML 1.2. It is specified as a subset rather than "YAML" so that
implementations in any language agree, and so a full YAML parser is not a
dependency. A conforming YAML parser will parse any valid header identically; the
converse does not hold.

### 5.3.1 Supported constructs

| Construct | Example | Notes |
|---|---|---|
| Mapping entry | `title: Revenue` | Key: `[A-Za-z_][A-Za-z0-9_-]*`, case-sensitive. |
| Nested mapping | `axis:`<br>`  x:`<br>`    title: Quarter` | Indentation MUST be exactly 2 spaces per level. Tabs are an error (`MDV1210`). |
| Block sequence | `- filter: x > 1` | Items at the parent's indent + 2. |
| Flow sequence | `y: [revenue, profit]` | |
| Flow mapping | `range: {min: 0, max: 100}` | |
| Plain scalar | `stack: percent` | Trimmed; may contain spaces. |
| Quoted scalar | `title: "Q1: results"` | `"` or `'`. Required if the value begins with `[ { " ' #` or contains `: ` or a trailing `#`. |
| Multiline scalar | `desc: \|` then indented lines | Literal (`\|`) and folded (`>`) styles. |
| Comment | `# whole-line only` | A `#` beginning a line, or preceded by whitespace outside quotes. |
| Null | `label: null` or `label: ~` | Also an empty value. |
| Boolean | `true` / `false` | **Only** these two spellings. `yes`/`no`/`on`/`off` are strings (avoiding the "Norway problem"). |
| Number | `120`, `-3.5`, `1e6` | JSON number grammar. |
| Reference | `data: "@sales"` | [§6.3](#63-datasets-and-references) |

### 5.3.2 Explicitly unsupported

Anchors/aliases (`&`/`*`), tags (`!!str`), multiple documents (`---` is the data
separator), complex keys (`? `), and octal/sexagesimal literals. Encountering
one is `MDV1211` (error), never a silent misparse.

### 5.3.3 Value typing

Values are typed by the attribute's declared schema, not by their spelling. A
value declared `string` is taken literally even if it looks numeric
(`title: 2026` is the string `"2026"`); a value declared `number` MUST parse as
a JSON number or raise `MDV1220`. Dimensions accept a bare number (device pixels)
or a CSS-like unit string: `320`, `"320px"`, `"100%"`, `"16rem"`, `"8cm"`.
Colors accept `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `hsl()`, `oklch()`, CSS
named colors, and theme tokens (`"@series-1"`, `"@text-muted"`).

## 5.4 Data section

Everything after the separator, verbatim, with the block's indentation removed.
Its interpretation is governed by `format` ([§6.2](#62-data-formats)). A data
section MUST NOT be present when the header declares an out-of-band source
(`data: "@id"`, `src:`); doing so is `MDV1204`.

## 5.5 The attribute cascade

Attributes resolve lowest to highest precedence:

| # | Source | Example |
|---|---|---|
| 1 | Built-in defaults for the block type | `height: 300` |
| 2 | Active theme | `palette`, `fontFamily` |
| 3 | Document `defaults:` in front matter | `defaults: {height: 320}` |
| 4 | Reader/embedder configuration | `MdvConfig.defaults` |
| 5 | Block info-string attributes | `` ```mdv bar height=200 `` |
| 6 | Block header attributes | `height: 200` |

Reader configuration outranks the document's own `defaults` so that an embedder
can enforce a house style; a block always outranks both so an author can override
locally. Merging is **deep for mappings, replacing for sequences and scalars**:
`axis: {x: {title: T}}` in a block merges with a themed `axis.y`, but
`y: [a, b]` wholly replaces an inherited `y`.

## 5.6 Degradation

In a non-MDV Markdown renderer, a visual block renders as a code block whose
content is the header and the data — legible, greppable, copyable. This is not
incidental; it is a conformance requirement on the *format*: any construct that
would degrade into gibberish is out of scope.

Authors who want a static image fallback in non-MDV contexts use `fallback:`:

```yaml
fallback: ./charts/revenue.svg      # rendered instead by non-MDV pipelines
```

Readers ignore `fallback`. Export tooling (`mdv export --degrade`) can rewrite
visual blocks into image references pointing at pre-rendered files, producing a
plain `.md` for GitHub or other non-MDV surfaces.

## 5.7 Complete example

````markdown
```mdv bar
title: Revenue by quarter
subtitle: FY2026, millions USD
desc: >
  Revenue grows each quarter, from 1.24 B in Q1 to 1.89 B in Q4,
  with the largest step between Q3 and Q4.
x: quarter
y: [revenue, profit]
stack: none
height: 340
axis:
  y:
    title: USD (millions)
    format: ",.0f"
legend: top
---
quarter | revenue | profit
Q1      |    1240 |    310
Q2      |    1516 |    402
Q3      |    1402 |    366
Q4      |    1893 |    551
```
````

---

# 6. Data model

## 6.1 The table

Every visual block resolves its input to a **table**: an ordered list of named
fields and an ordered list of rows. This is the only data structure in MDV.
Hierarchical visuals (treemap, sankey, gantt) express hierarchy through
*fields* — a parent key, a source/target pair — not through nested data.

```ts
type Value = number | string | boolean | Date | null;

interface Field {
  name: string;
  type: FieldType;          // inferred or declared
  format?: FormatSpec;
}

type FieldType =
  | 'number' | 'integer' | 'string' | 'boolean'
  | 'date' | 'datetime' | 'time' | 'duration'
  | 'category' | 'unknown';

interface Table {
  fields: Field[];
  rows: Value[][];          // row-major; rows[i][j] belongs to fields[j]
}
```

### 6.1.1 Type inference

If `fields:` does not declare a type, the reader infers per column by examining
**all** rows (not a sample — sampling makes rendering data-dependent and
therefore non-deterministic across implementations):

1. All values null/empty → `unknown`.
2. All non-null values match the boolean spellings `true`/`false` → `boolean`.
3. All non-null values parse as JSON numbers → `integer` if every value is an
   integer, else `number`. Values with grouping separators or a trailing
   `%`/currency symbol are **not** numbers under inference; declare a type and a
   `parse` format to accept them.
4. All non-null values parse as ISO 8601 → `date` (date-only), `datetime`
   (with a time part), or `time`.
5. Distinct-value count ≤ 100 **and** ≤ 50 % of row count → `category`.
6. Otherwise → `string`.

Declaring types explicitly is RECOMMENDED for documents under version control,
because inference results can change when data changes:

```yaml
fields:
  quarter: {type: category}
  revenue: {type: number, format: ",.0f"}
  opened:  {type: date, parse: "%d/%m/%Y"}
```

### 6.1.2 Field naming

Field names come from the data's header row. They are compared **case-sensitively**
and after trimming surrounding whitespace. A name may be referenced in
attributes bare (`x: quarter`) when it matches `[A-Za-z_][A-Za-z0-9_]*`, and
otherwise MUST be bracketed: `x: "[Net revenue (USD)]"`. Duplicate names are
`MDV2110`; the reader disambiguates by suffixing `_2`, `_3` and continues.

## 6.2 Data formats

`format:` selects the data-section syntax. Default is `auto`.

| `format` | Description |
|---|---|
| `table` | GFM-style pipe table. The canonical format. |
| `csv` | RFC 4180. Comma-separated, `"` quoting, doubled quotes escape. |
| `tsv` | Tab-separated; no quoting, no embedded tabs. |
| `json` | An array of objects, or an array of arrays with `columns:` declared. |
| `ndjson` | One JSON object per line. |
| `columns` | A mapping of field name → sequence of values. |
| `matrix` | A rectangular grid of numbers with row and column labels. |
| `auto` | Detected per [§6.2.6](#626-auto-detection). |

### 6.2.1 `table`

```
quarter | revenue | profit
--------|---------|-------
Q1      |    1240 |    310
Q2      |    1516 |    402
```

- The first non-blank line is the header row.
- A **delimiter row** (`---|---`) immediately after the header is OPTIONAL. When
  present it is consumed, and for `mdv table` blocks its alignment markers
  (`:---`, `:---:`, `---:`) set column alignment.
- Leading and trailing `|` are optional and MUST be stripped.
- Cell content is trimmed. `\|` is a literal pipe. A cell may be empty (null).
- Rows with fewer cells than the header are padded with nulls (`MDV2120`
  warning); rows with more are truncated (`MDV2121` warning).
- Blank lines are skipped.

### 6.2.2 `csv` / `tsv`

RFC 4180 with these clarifications: the first record is the header unless
`header: false`; `\r\n` and `\n` both terminate records; a quoted field may span
lines; a UTF-8 BOM inside the data section is stripped. `delimiter:` overrides
the separator character for `csv` (e.g. `delimiter: ";"`).

### 6.2.3 `json` / `ndjson`

```yaml
format: json
---
[
  {"quarter": "Q1", "revenue": 1240},
  {"quarter": "Q2", "revenue": 1516}
]
```

Field order is the key order of the **first** object; keys appearing only in
later objects are appended in first-seen order. Nested objects and arrays are
flattened with `.` and `[n]` path segments (`{"a":{"b":1}}` → field `a.b`) up to
`maxFlattenDepth` (default 4). Values that remain non-scalar after flattening
become their JSON text.

### 6.2.4 `columns`

Compact for wide, short series:

```yaml
format: columns
---
month:   [Jan, Feb, Mar, Apr]
actual:  [120, 145, 132, 168]
plan:    [130, 140, 140, 160]
```

All sequences MUST have equal length (`MDV2130`).

### 6.2.5 `matrix`

For heatmaps and correlation grids. The first row is the column key; the first
column of each row is the row key. It is sugar for a three-field long table
(`row`, `column`, `value`), which is what the encoder actually receives.

```yaml
format: matrix
---
       | Mon | Tue | Wed
Alpha  |  12 |  18 |   9
Bravo  |   4 |  22 |  17
```

### 6.2.6 Auto-detection

Applied to the first non-blank line of the data section, in order. The rules are
exhaustive and MUST be applied exactly:

1. Begins with `[` or `{` → `json`.
2. Every non-blank line begins with `{` → `ndjson`.
3. Contains an unescaped `|` → `table`.
4. Contains a TAB → `tsv`.
5. Matches `^\s*[A-Za-z_][\w.-]*\s*:\s*\[` → `columns`.
6. Otherwise → `csv`.

Ambiguity is resolved in favour of `table`, since it is the canonical format.
When detection picks a format the author did not intend, declaring `format:`
explicitly is the fix; readers SHOULD mention this in the `MDV2101` diagnostic.

## 6.3 Datasets and references

A `dataset` block declares reusable data. It renders nothing.

````markdown
```mdv dataset id=sales
fields:
  date: {type: date}
---
date       | region | units | revenue
2026-01-31 | APAC   |  1204 |  482000
2026-01-31 | EMEA   |   980 |  414000
2026-02-28 | APAC   |  1310 |  530000
```
````

Reference it with `@`:

```yaml
data: "@sales"
```

Rules:

- `id` MUST match `[A-Za-z_][A-Za-z0-9_-]*` and be unique per document
  (`MDV2140` on collision; last definition wins and earlier ones are shadowed).
- Resolution is **two-pass**: a dataset may be referenced before it is declared.
- A dataset MAY derive from another (`from: "@sales"` plus `transform:`),
  forming a DAG. Cycles are `MDV2141`.
- Datasets declared in front matter (`datasets:`) and datasets declared in blocks
  share one namespace.
- A reference MAY select a projection: `data: "@sales[date, revenue]"`.
- `dataset` blocks are hidden by default. `show: table` renders the dataset as an
  enhanced table at its location, which is useful for appendices.

## 6.4 External sources

```yaml
src: ./data/2026-revenue.csv
```

`src` accepts a **relative path** or an **absolute URL**. Both are disabled by
default; see [§13.2](#132-external-data). When enabled:

- Relative paths resolve against the document's base URI and MUST NOT escape the
  configured root (`../` traversal is `MDV4020`).
- The response's media type selects the format unless `format:` overrides it.
- Fetches are subject to the size, time, and redirect limits of
  [§13.6](#136-resource-limits).
- A reader MUST render a placeholder with an explicit state (loading / blocked /
  failed) rather than an empty chart, and MUST NOT block document rendering on a
  fetch.
- Content is cached by URL for `cacheTtl` (default 300 s).

For reproducibility, `integrity:` MAY carry an SRI hash
(`integrity: "sha384-…"`); when present, a mismatch is `MDV4021` and the data is
discarded.

## 6.5 Null and missing values

By default, a value is null if it is an empty cell, `null`, `NULL`, `NaN`, or
`-` alone. `nullValues: ["", "N/A", "—"]` replaces that list.

`nullPolicy` controls how continuous marks handle nulls:

| Value | Behaviour |
|---|---|
| `gap` *(default for line/area)* | Break the line; do not connect across the null. |
| `skip` | Connect the neighbours as if the row were absent. |
| `zero` | Treat as 0. |
| `drop` | Remove the row entirely before encoding. |

Nulls are never silently coerced to zero. A chart whose data has gaps MUST look
like it has gaps.

## 6.6 Temporal values

- ISO 8601 is always accepted: `2026-08-10`, `2026-08-10T14:30:00Z`,
  `2026-08-10T14:30:00+09:00`, `2026-W33-1`, `2026-08`.
- Other layouts require `parse:` with a strftime subset:
  `%Y %y %m %d %H %M %S %L %b %B %a %A %j %p %z %%`, plus `%-` to suppress
  zero-padding (`%-d`). Anything else is `MDV2150`.
- A value with no zone offset is interpreted in the document `timezone`
  (default `UTC`). Rendering MUST NOT depend on the machine's local zone — that
  would break determinism and produce different PDFs on different machines.
- Epoch numbers require an explicit type: `{type: datetime, unit: ms}` with
  `unit` ∈ `s | ms | us | ns`.
- Durations use ISO 8601 (`PT2H30M`) or a plain number with `unit`.

## 6.7 Transforms

`transform:` is an ordered pipeline applied after parsing and before encoding.
Each step takes a table and returns a table. Transforms are pure, total, and
deliberately non-Turing-complete: no loops, no recursion, no user functions.

```yaml
transform:
  - filter: "region != 'Other' && revenue > 0"
  - derive: {margin: "profit / revenue", month: "month(date)"}
  - aggregate:
      group: [region, month]
      sum: [revenue, units]
      mean: {avgPrice: price}
  - sort: ["-revenue", "region"]
  - limit: 10
```

| Step | Shape | Semantics |
|---|---|---|
| `filter` | expression → boolean | Keeps rows where the expression is truthy. Null → false. |
| `derive` | map name → expression | Adds or replaces fields, evaluated left to right; later entries see earlier ones. |
| `aggregate` | `group`, plus one or more of `sum`, `mean`, `median`, `min`, `max`, `count`, `first`, `last`, `stddev`, `p<n>` | Each aggregator is a field list (output keeps the name) or a map of output name → input field. `count` takes `true` or an output name. |
| `sort` | field or list | `-` prefix = descending. Sort is **stable**. Nulls sort last. |
| `limit` | integer, or `{n, offset}` | Row slice after sorting. |
| `pivot` | `{key, value, group?}` | Long → wide. New field names come from the `key` column's values, sorted for determinism. |
| `unpivot` | `{fields, key?, value?}` | Wide → long. Defaults `key: "key"`, `value: "value"`. |
| `bin` | `{field, step? \| count?, output?}` | Numeric or temporal binning. `step` wins over `count`. |
| `window` | `{op, field, size, output, partition?}` | `op` ∈ `sum, mean, min, max, count, cumsum, delta, pct_change, rank, lag, lead`. `size` in rows; `partition` groups. Order is the current row order. |
| `join` | `{with: "@other", on, how?}` | `how` ∈ `inner, left` (default `left`). `on` is a field name or `{left, right}`. |
| `rename` | map old → new | |
| `select` | field list | Projection, preserving the listed order. |

Transforms are evaluated once per resolved dataset and memoised by
(dataset identity, transform pipeline) so N charts over one dataset cost one
evaluation.

## 6.8 MDVX — the expression language

MDVX is the *only* place a document supplies something evaluated, and it is
built so that "evaluation" cannot mean "execution".

### 6.8.1 Grammar

```abnf
expr        = ternary
ternary     = or [ "?" expr ":" expr ]
or          = and *( "||" and )
and         = equality *( "&&" equality )
equality    = comparison *( ( "==" / "!=" ) comparison )
comparison  = additive *( ( "<" / "<=" / ">" / ">=" / "in" / "contains" ) additive )
additive    = multiplicative *( ( "+" / "-" ) multiplicative )
multiplicative = unary *( ( "*" / "/" / "%" ) unary )
unary       = [ "!" / "-" ] power
power       = primary [ "**" unary ]
primary     = number / string / boolean / "null"
            / field-ref / func-call / "(" expr ")" / list
field-ref   = identifier / "[" 1*( %x20-5C / %x5E-10FFFF ) "]"
func-call   = identifier "(" [ expr *( "," expr ) ] ")"
list        = "[" [ expr *( "," expr ) ] "]"
string      = SQUOTE *char SQUOTE / DQUOTE *char DQUOTE
```

Operator precedence is as written (lowest to highest). `**` is right-associative;
everything else is left-associative.

### 6.8.2 Function whitelist

Only these identifiers may be called. There is no member access (`a.b`), no
indexing on arbitrary objects, no `this`, and no way to reach a host object.

| Group | Functions |
|---|---|
| Math | `abs ceil floor round trunc sign sqrt cbrt exp log log10 log2 pow min max clamp` |
| Stats (aggregate context only) | `sum mean median mode stddev variance count countDistinct p25 p50 p75 p90 p95 p99` |
| String | `lower upper trim len startsWith endsWith contains replace split substr concat pad` |
| Temporal | `year quarter month week day hour minute second dayOfWeek dateAdd dateDiff dateTrunc now` |
| Logic | `if coalesce isNull isNumber isString toNumber toString toDate` |
| Formatting | `format` (value, format-spec) |

`now()` returns the document's build time — the `buildTime` config value, or the
process start time — never a per-call clock read, so a document renders
identically twice in a row.

### 6.8.3 Semantics and limits

- **Null propagation:** any arithmetic or comparison with null yields null;
  `null` is falsy in boolean contexts. `coalesce` and `isNull` are the escapes.
- **No implicit coercion** between string and number. `'1' + 1` is `MDV2210`.
  `+` on two strings concatenates.
- **Type errors are diagnostics, not exceptions:** the row's derived value
  becomes null, one diagnostic is emitted per expression (not per row), and
  rendering continues.
- **Limits:** expression source ≤ 1024 characters, AST depth ≤ 32, ≤ 64 function
  calls per expression. Exceeding a limit is `MDV4030`.
- Evaluation MUST NOT use `eval`, `new Function`, or any dynamic code
  construction. Reference implementations compile to a closure tree over a fixed
  operator set.

## 6.9 Formatting

`format` accepts either a **format string** or an **options object**.

### 6.9.1 Number format strings

A subset of the d3-format grammar, chosen because it is compact and widely known:

```
[[fill]align][sign][symbol][0][width][,][.precision][~][type]
```

Supported types: `f` fixed · `e` exponent · `g` significant · `r` rounded ·
`s` SI prefix · `%` percent (×100) · `p` percent (rounded) · `d` integer ·
`b`/`o`/`x`/`X` radix · `c` character. `$` as a symbol prefixes the locale
currency; `,` enables grouping; `~` trims insignificant zeros.

Examples: `",.0f"` → `1,240` · `"$,.2f"` → `$1,240.00` · `".1%"` → `12.4%` ·
`"~s"` → `1.24k`.

### 6.9.2 Options object

Maps directly onto `Intl.NumberFormat` / `Intl.DateTimeFormat`:

```yaml
format: {style: currency, currency: USD, notation: compact, maximumFractionDigits: 1}
```

### 6.9.3 Determinism caveat

`Intl` output varies with the host ICU version, which would break
[determinism](#243-determinism). Therefore:

- Conforming readers **MUST** ship a built-in formatter covering the format-string
  grammar and the `en-US` locale, and use it by default.
- `Intl` is used only when the document requests a non-default locale or an
  options object, and in that case the reader **MUST** record the resolved ICU
  version in export metadata ([§28.9](#289-metadata-and-provenance)).

### 6.9.4 Date format strings

The strftime subset of [§6.6](#66-temporal-values), plus the presets
`iso`, `date`, `time`, `datetime`, `month`, `quarter`, `year`, `relative`.

---

# 7. Encoding model

## 7.1 Channels

An encoding maps fields to channels. Which channels a block type accepts is
listed per type in [§8](#8-chart-catalog); the vocabulary is shared.

| Channel | Accepts | Meaning |
|---|---|---|
| `x` | field | Horizontal position. |
| `y` | field \| list of fields | Vertical position. A list creates one series per field ("wide form"). |
| `series` | field | Splits rows into series ("long form"). Mutually exclusive with a list-valued `y` (`MDV3010`). |
| `color` | field \| color \| list | Color encoding, or a fixed color. |
| `size` | field \| number | Mark size / radius. |
| `shape` | field \| shape name | Point shape. |
| `label` | field \| expression | Direct labels on marks. |
| `value` | field | The magnitude for pie, heatmap, treemap, gauge, funnel. |
| `category` | field | The identity for pie, funnel, treemap. |
| `group` | field \| list | Faceting/grouping key where a type defines one. |
| `detail` | field | Splits marks without adding a visual channel. |
| `tooltip` | field list \| `false` | Extra fields in the readout. |
| `row` / `column` | field | Small-multiple facets ([§7.6](#76-faceting)). |

### 7.1.1 Wide vs long form

Both are first-class; the reader normalises to long form internally.

```yaml
# wide: one column per series
x: quarter
y: [revenue, profit]
```

```yaml
# long: a series column
x: quarter
y: amount
series: metric
```

### 7.1.2 Shorthand

A channel may take an object for per-channel configuration:

```yaml
y:
  field: revenue
  title: Revenue (USD)
  format: "$,.0f"
  scale: {type: log, base: 10}
  axis: {ticks: 5, grid: true}
```

The bare form `y: revenue` is exactly `y: {field: revenue}`.

## 7.2 Scales

| `scale.type` | Applies to | Notes |
|---|---|---|
| `linear` | quantitative | Default for numbers. |
| `log` | quantitative | `base` default 10. Domain MUST NOT include ≤ 0 (`MDV3020`; such rows are dropped with a warning). |
| `sqrt`, `pow` | quantitative | `exponent` for `pow`. Default for `size`. |
| `symlog` | quantitative | For data spanning zero. `constant` default 1. |
| `time` | temporal | Ticks chosen from a calendar-aware ladder. |
| `band` | discrete | Default for categorical position. `padding` default 0.2. |
| `point` | discrete | Band with zero width; default for discrete x on line/scatter. |
| `ordinal` | discrete | Discrete → discrete range (colors, shapes). |
| `quantize` / `quantile` / `threshold` | quantitative → discrete | Heatmap and choropleth binning. |

**Domain rules.** By default a quantitative y-domain **includes zero** for
area/bar (`zero: true`) and **does not** for line/scatter (`zero: false`), and is
extended to "nice" round bounds (`nice: true`). `domain: [min, max]` sets it
explicitly; `domain: [null, 100]` pins one end. `clamp: true` clips out-of-domain
values instead of extrapolating.

> **Truncating a bar chart's axis misstates magnitude.** Setting `zero: false`
> on a bar or area block emits `MDV3021` (warning) — deliberate, and visible in
> a lint run.

## 7.3 Axes

```yaml
axis:
  x: {title: Quarter, grid: false, ticks: auto, tickRotate: 0, format: "%b %Y"}
  y: {title: Revenue, grid: true, ticks: 5, format: ",.0f", position: left}
```

| Key | Default | Notes |
|---|---|---|
| `title` | field name, humanised | `false` to suppress. |
| `grid` | `y: true`, `x: false` | Hairline, solid, never dashed ([§11.4](#114-mark-specifications)). |
| `ticks` | `auto` | Count *hint*; the tick generator prefers round values. |
| `tickValues` | — | Explicit tick positions, overriding `ticks`. |
| `format` | field format | |
| `tickRotate` | `0` | Degrees. The layout engine auto-rotates to `-45` only when labels would collide, and MUST NOT clip ([§11.5](#115-labels-and-legends)). |
| `position` | `bottom` / `left` | `top`, `right` allowed. |
| `line` | `true` | The axis line itself. |
| `labels` | `true` | |

### 7.3.1 The one-axis rule

> **A block MUST NOT define two independent y-scales.** There is no
> `y2`, no `secondaryAxis`, no `axis.right.scale`.

Dual-axis charts let the author choose an arbitrary alignment between two
unrelated scales, and every reader draws a different conclusion from the same
data. Where two measures of different magnitude must be compared, MDV offers
three supported answers, all of which preserve a single interpretation:

1. Two blocks stacked (`:::mdv-grid{cols=1}`), sharing an x-domain via
   `syncX: <group>`.
2. Small multiples (`row:` / `column:` faceting).
3. Indexing to a common base: `transform: [{derive: {idx: "value / first(value) * 100"}}]`.

## 7.4 Legends

`legend` accepts `auto` (default), `top`, `right`, `bottom`, `left`, `inline`,
or `false`, or an object `{position, title, orient, columns, maxItems}`.

**`auto` resolves to:** no legend for a single series (the title names it, and a
one-swatch box is pure overhead); otherwise a legend at the top for ≤ 6 series,
right for more. Legend symbols mirror the mark: a rect for bars/areas/cells, a
line segment for lines, the point shape for scatter.

Series beyond `maxItems` (default 12) fold into an "Other" entry rather than
generating new hues ([§11.2](#112-categorical-color)).

## 7.5 Tooltips and interaction

Interactive targets (DOM/Canvas) MUST implement the hover layer by default; it
is part of the deliverable, not an enhancement. Static targets (PDF, SVG string)
ignore it.

| Block family | Behaviour |
|---|---|
| line, area, OHLC/OHLCV | A **vertical crosshair** snaps to the nearest x position and the readout lists **every series** at that x. The reader aims at a date, never at a 2 px stroke. |
| bar, heatmap, pie, treemap, funnel, waterfall | The **mark is the hit target**; no crosshair. The hovered mark lifts (lightened fill or a surface-colored outline). |
| scatter, bubble | Nearest-point (Voronoi) hit testing, so the pointer only has to be *closest*. |

Requirements:

- Every hit target MUST be at least **24 × 24 px**, extending beyond the painted
  mark. An 8 px dot with an 8 px target is unhittable.
- Keyboard focus MUST produce the same readout as hover
  ([§12.4](#124-keyboard-interaction)).
- Tooltips **enhance, never gate**: every value shown in a tooltip MUST also be
  reachable through direct labels or the table view. This is what makes the PDF
  export lossless.
- In a tooltip row, the **value is the prominent element** and the series name is
  secondary — the reader already knows which series they are pointing at.
  Series keys are short line strokes, not filled boxes.
- Series and field names originate in untrusted data and MUST be inserted as
  text nodes, never as markup ([§13.3](#133-output-sanitisation)).

`tooltip: false` disables the layer; `tooltip: [field, …]` adds fields to it.

## 7.6 Faceting

`row:` and `column:` split one block into small multiples over a field's values.

```yaml
column: region
columns: 3          # wrap after 3
shareY: true        # default true — a shared scale is what makes them comparable
shareX: true
```

Facets are laid out on a uniform grid; each panel keeps the block's height unless
`facetHeight` is given. `shareY: false` requires a diagnostic-worthy reason, and
emits `MDV3030` (info) because unshared scales invite false comparison.

---

# 8. Chart catalog

## 8.1 Attributes common to all visual blocks

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `type` | string | — | Only when omitted from the info string. |
| `title` | string | — | Rendered above the plot. |
| `subtitle` | string | — | |
| `caption` | string | — | Rendered below; the figure caption in PDF. |
| `desc` | string | *auto* | The accessible description ([§12.2](#122-descriptions)). |
| `id` | string | — | Anchor and cross-reference target. |
| `data` | ref | — | `"@dataset"`; mutually exclusive with a data section and `src`. |
| `src` | path/URL | — | External source ([§6.4](#64-external-sources)). |
| `format` | enum | `auto` | Data-section syntax. |
| `fields` | map | — | Declared field types and formats. |
| `transform` | list | — | [§6.7](#67-transforms) |
| `width` | dimension | `100%` | |
| `height` | dimension | `300` | |
| `aspect` | number | — | Width : height; overrides `height` when width is fluid. |
| `padding` | dimension \| box | `{top: 8, right: 8, bottom: 8, left: 8}` | Inside the block's frame. |
| `theme` | string | inherited | Per-block theme override. |
| `palette` | list \| string | theme | Named palette or explicit colors. |
| `legend` | see [§7.4](#74-legends) | `auto` | |
| `tooltip` | see [§7.5](#75-tooltips-and-interaction) | `true` | |
| `animate` | boolean | `true` | Forced off under `prefers-reduced-motion` and on static targets. |
| `class` | string | — | Passed through to the container element for embedder styling. |
| `fallback` | path | — | [§5.6](#56-degradation) |
| `table` | enum | `details` | Data-table fallback: `details`, `visible`, `hidden`, `none`. |
| `x-*` | any | — | Reserved for extensions; never interpreted by core ([§15.1](#151-extension-attributes)). |

Sizing: `width: 100%` means "fill the container". A reader MUST render correctly
at any width ≥ 240 px and MUST NOT produce horizontal document overflow; below
the type's minimum useful width it MUST switch to the compact variant declared
per type (usually: drop the legend to below the plot, thin the ticks).

---

## 8.2 `bar` — magnitude by category

**Use when** comparing a measure across a discrete set of categories; the
workhorse form.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `x` | field | *required* | The category (or time bucket). |
| `y` | field \| list | *required* | The measure(s). |
| `series` | field | — | Long form alternative to a list `y`. |
| `stack` | `none`\|`normal`\|`percent`\|`center` | `none` | `none` = grouped side-by-side. |
| `orientation` | `vertical`\|`horizontal` | `vertical` | Horizontal for long category labels or > 12 categories. |
| `barWidth` | number \| `auto` | `auto` | Capped at 24 px ([§11.4](#114-mark-specifications)). |
| `barPadding` | number | `0.2` | Band padding, 0–1. |
| `groupPadding` | number | `0.1` | Between bars within a group. |
| `corner` | number | `4` | Radius on the data end only. |
| `baseline` | number | `0` | Bars grow from here; supports diverging bars. |
| `sort` | `none`\|`asc`\|`desc`\|field | `none` | Sorts categories by the measure. |
| `label` | field \| boolean | `false` | Direct value labels. |

**Data shape.** One row per category per series.

````markdown
```mdv bar
title: Revenue by region
x: region
y: revenue
sort: desc
orientation: horizontal
label: true
---
region        | revenue
North America |   48200
EMEA          |   31800
APAC          |   42100
LATAM         |   12400
```
````

**Rendering notes.** Bars grow from a single baseline. The data end is rounded
(4 px), the baseline end is square. Adjacent and stacked bars are separated by a
**2 px gap in the surface color**, never by a stroke. Grouped bars use the
categorical palette in fixed slot order. `stack: percent` forces the y-domain to
[0, 1] and the axis format to `.0%`.

---

## 8.3 `line` — change over a continuous domain

**Use when** the x-domain is ordered and continuous (time, most often) and the
shape of change matters more than individual magnitudes.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `x` | field | *required* | Temporal or quantitative. |
| `y` | field \| list | *required* | |
| `series` | field | — | |
| `curve` | `linear`\|`monotone`\|`step`\|`stepBefore`\|`stepAfter`\|`natural`\|`basis` | `linear` | `monotone` only when interpolation is meaningful; never on step-change data. |
| `strokeWidth` | number | `2` | |
| `dash` | list \| name | — | For forecast/projection segments; identity MUST NOT rely on dash alone. |
| `points` | `none`\|`all`\|`ends`\|`extremes` | `none` | Marker policy. |
| `pointSize` | number | `8` | Diameter; ≥ 8 px. |
| `nullPolicy` | see [§6.5](#65-null-and-missing-values) | `gap` | |
| `label` | `none`\|`end`\|`extremes`\|field | `none` | Direct labels. |
| `annotations` | list | — | [§8.14](#814-annotations) |
| `syncX` | string | — | Shares an x-domain and crosshair with other blocks in the same group. |

````markdown
```mdv line
title: Daily active users
x: date
y: [ios, android, web]
curve: monotone
label: end
axis: {x: {format: "%b %d"}}
---
date       |  ios | android | web
2026-07-01 | 4210 |    5180 | 2240
2026-07-02 | 4380 |    5240 | 2190
2026-07-03 | 4120 |    5310 | 2260
```
````

**Rendering notes.** 2 px stroke, round join and cap. Markers carry a 2 px ring
in the surface color so they stay legible where lines cross. End labels are
placed only when they fit without collision; when series converge the reader MUST
use leader lines or fall back to the legend rather than stacking labels away from
their lines.

---

## 8.4 `area` — magnitude over a continuous domain

Identical encoding to `line`, plus:

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `stack` | `none`\|`normal`\|`percent`\|`center` | `normal` when > 1 series | `center` = streamgraph. |
| `fillOpacity` | number | `0.10` | A wash, not a block. Stacked areas use a higher, per-slot opacity so segments read as distinct bands. |
| `line` | boolean | `true` | Draw the boundary stroke at full series color. |
| `baseline` | number \| field | `0` | A field produces a band (see `band` below). |
| `band` | `{lower, upper}` | — | Confidence/range band; drawn beneath the line, no stroke. |

Unstacked overlapping areas are limited to **two series** (`MDV3040` beyond
that): three translucent fills over one another are unreadable, and the correct
form is a line chart or small multiples.

---

## 8.5 `pie` / `donut` — parts of one whole

**Use when** there are ≤ 6 parts, they sum to a meaningful whole, and the reader
needs "roughly what share", not precise comparison. Otherwise a horizontal bar
chart answers the same question better; readers SHOULD emit `MDV3050` (info)
when a pie has more than 6 slices.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `category` | field | *required* | Also accepted as `x` or `label`. |
| `value` | field | *required* | Also accepted as `y`. |
| `innerRadius` | number \| % | `0` (`pie`), `0.6` (`donut`) | |
| `padAngle` | degrees | `1` | The 2 px surface gap, expressed angularly. |
| `sort` | `desc`\|`asc`\|`none` | `desc` | |
| `startAngle` | degrees | `-90` | 12 o'clock. |
| `label` | `none`\|`outside`\|`inside`\|`auto` | `auto` | `auto` = outside with leader lines, suppressed under 5 %. |
| `labelFormat` | format | `"{category}: {value:,.0f} ({percent:.0%})"` | Template over `category`, `value`, `percent`. |
| `center` | string \| `{title, value}` | — | Donut center content. |
| `other` | number \| `false` | `0.02` | Slices below this share fold into "Other". |

````markdown
```mdv donut
title: Traffic by channel
category: channel
value: sessions
center: {title: Total, value: "sum(sessions)"}
---
channel  | sessions
Organic  |    48210
Direct   |    31980
Referral |    12440
Paid     |     8710
```
````

---

## 8.6 `scatter` / `bubble` — relationship between two measures

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `x`, `y` | field | *required* | Both quantitative (or temporal x). |
| `series` | field | — | Identity → color. |
| `size` | field \| number | `8` | `bubble` requires a field; area-proportional (`sqrt` scale), never radius-proportional. |
| `shape` | field \| name | `circle` | `circle square triangle diamond cross star`. Secondary encoding for CVD. |
| `opacity` | number | `0.85` | |
| `trend` | `none`\|`linear`\|`loess` | `none` | Adds a fitted line; `MDV3060` (info) reminds that a trend line is an assertion. |
| `jitter` | number | `0` | For discrete-valued scatter. |

**Series cap.** Scatter and bubble compare *all* pairs of colors at once, not
just adjacent ones. The default palette validates all-pairs for its **first three
slots** only ([§11.2](#112-categorical-color)); beyond three series, a conforming
reader MUST either facet (`column:`) or fold to "Other", and emits `MDV3061`.

---

## 8.7 `histogram` — distribution of one measure

| Attribute | Type | Default |
|---|---|---|
| `x` | field *(required)* | |
| `bins` | number \| `auto` | `auto` (Freedman–Diaconis, clamped to 5–50) |
| `binStep` | number | — (overrides `bins`) |
| `domain` | `[min, max]` | data extent |
| `normalize` | `count`\|`frequency`\|`density` | `count` |
| `cumulative` | boolean | `false` |

Bars in a histogram touch by default (no band padding) but keep the 2 px surface
gap, because the x-axis is continuous.

## 8.8 `box` — distribution across categories

| Attribute | Type | Default |
|---|---|---|
| `x` | field (category) | *required* |
| `y` | field (values) | *required* |
| `whisker` | `tukey`\|`minmax`\|`stddev`\|`p<lo>-p<hi>` | `tukey` (1.5 IQR) |
| `outliers` | boolean | `true` |
| `points` | `none`\|`all`\|`jitter` | `none` |
| `notch` | boolean | `false` |

Accepts either raw observations (one row per observation) or pre-computed
five-number summaries (`fields: min, q1, median, q3, max`), detected by presence
of a `median` field.

## 8.9 `heatmap` — magnitude across two discrete dimensions

**Use when** the question is "where are the hot spots" over a grid, not "what is
the exact value here".

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `x` | field | *required* | Columns. |
| `y` | field | *required* | Rows. |
| `value` | field | *required* | The magnitude. |
| `colorScale` | `sequential`\|`diverging`\|`quantize`\|`quantile`\|`threshold` | `sequential` | `diverging` requires `midpoint`. |
| `scheme` | string \| list | theme sequential | One hue, light → dark ([§11.3](#113-sequential-and-diverging-color)). |
| `midpoint` | number | `0` | Diverging only. |
| `domain` | `[min, max]` | data extent | |
| `bins` | number | — | Discretises a continuous ramp. |
| `cellLabel` | boolean \| format | `auto` | `auto` = labels when cells exceed 32 × 24 px. |
| `cellGap` | number | `2` | Surface-colored gap. |
| `cellRadius` | number | `2` | |
| `nullFill` | color | `transparent` | Missing combinations. |
| `sort` | `{x, y}` | data order | `asc`, `desc`, `cluster`, or an explicit list. |

````markdown
```mdv heatmap
title: Deploys by day and hour
x: hour
y: weekday
value: deploys
scheme: blue
cellLabel: false
sort: {y: [Mon, Tue, Wed, Thu, Fri, Sat, Sun]}
---
weekday | hour | deploys
Mon     |    9 |      12
Mon     |   10 |      31
Tue     |    9 |       8
Tue     |   10 |      44
```
````

The `matrix` data format ([§6.2.5](#625-matrix)) is often more legible for dense
grids and is equivalent.

**Rendering notes.** Sequential means **one hue, light → dark** — never a
rainbow, because a rainbow has no perceptual ordering and readers cannot rank
two cells without consulting the legend. Diverging means two hues with a
**neutral gray midpoint**, never a hue at zero. The legend is a continuous ramp
with labelled ends and midpoint. Cell labels, when shown, pick white or ink by
the fill's luminance so they always clear contrast.

---

## 8.10 `ohlc` — open/high/low/close

**Use when** showing price action per period without volume.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `x` | field | *required* | Temporal. Also accepted as `date` or `time`. |
| `open`, `high`, `low`, `close` | field | *required* | Auto-detected from field names `open/high/low/close` (case-insensitive, and the abbreviations `o/h/l/c`) when omitted. |
| `style` | `bar`\|`candle`\|`hlc` | `candle` | `bar` = classic OHLC tick bars. |
| `upColor` / `downColor` | color | theme | Defaults are the status palette's `good`/`critical`, not the categorical slots. |
| `hollow` | boolean | `false` | Hollow candles for up periods. |
| `wickWidth` | number | `1` | |
| `bodyWidth` | number \| `auto` | `auto` | Capped at 24 px. |
| `gaps` | `collapse`\|`preserve` | `collapse` | `collapse` uses an ordinal-time axis that skips non-trading periods; `preserve` uses a true time scale. |
| `overlay` | list | — | Indicators, [§8.11.1](#8111-overlays). |
| `precision` | integer | inferred | Decimal places for price. |

````markdown
```mdv ohlc
title: ACME — daily
x: date
style: candle
gaps: collapse
overlay:
  - {type: sma, period: 20}
  - {type: bollinger, period: 20, k: 2}
---
date       |  open |  high |   low | close
2026-08-03 | 41.20 | 42.05 | 40.90 | 41.85
2026-08-04 | 41.90 | 42.40 | 41.10 | 41.30
2026-08-05 | 41.35 | 41.60 | 39.80 | 40.05
2026-08-06 | 40.10 | 41.75 | 40.00 | 41.60
```
````

**Rendering notes.** Direction is encoded by **color and body fill together**
(filled = down, hollow or lighter = up when `hollow: true`), so red/green is
never the only channel — this is what makes the chart readable with CVD and in
grayscale print. `gaps: collapse` is the default because weekends rendered as
empty space is the single most common complaint about financial charts; the axis
remains labelled with real dates.

---

## 8.11 `ohlcv` / `candlestick` — price with volume

`candlestick` is an alias of `ohlc` with `style: candle`. `ohlcv` extends `ohlc`
with a volume panel.

| Attribute | Type | Default | Notes |
|---|---|---|---|
| *(all `ohlc` attributes)* | | | |
| `volume` | field | *required* | |
| `volumeHeight` | dimension | `0.25` | Fraction of total height, or an absolute dimension. |
| `volumeColor` | `direction`\|color | `direction` | `direction` tints volume bars by the period's up/down. |
| `panels` | list | — | Additional stacked panels ([§8.11.2](#8112-panels)). |

Price and volume occupy **separate stacked panels sharing one x-axis**. They are
never overlaid on a shared y-axis — that is the dual-axis anti-pattern
([§7.3.1](#731-the-one-axis-rule)) in its most common disguise.

### 8.11.1 Overlays

Computed price overlays. They are declarative, deterministic, and computed by
the reader; the formulas are fixed by this spec so that two implementations draw
the same line.

| `type` | Parameters | Definition |
|---|---|---|
| `sma` | `period`, `field` (default `close`) | Simple moving average; first `period-1` values null. |
| `ema` | `period`, `field` | α = 2/(period+1); seeded with the SMA of the first `period` values. |
| `wma` | `period`, `field` | Linear weights 1…n. |
| `bollinger` | `period`, `k` (default 2) | SMA ± k × population stddev; renders as a band. |
| `vwap` | `anchor` (`session`\|`start`) | Σ(typical × volume)/Σ(volume); requires `volume`. |
| `channel` | `period` | Highest high / lowest low (Donchian). |
| `line` | `value` or `field` | A horizontal reference or an arbitrary series. |

Indicators that require their own scale (RSI, MACD, ATR) are **panels**, not
overlays.

### 8.11.2 Panels

```yaml
panels:
  - {type: volume, height: 0.2}
  - {type: rsi, period: 14, height: 0.15, bands: [30, 70]}
  - {type: macd, fast: 12, slow: 26, signal: 9, height: 0.2}
```

Panels stack below the price panel, share the x-scale and the crosshair, and each
carry their own y-scale. Total panel height is subtracted from the block height.

---

## 8.12 Remaining Level 2 types

Each is specified in the same shape; attributes not listed are the common set of
[§8.1](#81-attributes-common-to-all-visual-blocks).

| Type | Required channels | Key attributes | Notes |
|---|---|---|---|
| `radar` | `category`, `value`, opt. `series` | `fill`, `maxValue`, `gridShape` (`polygon`\|`circle`) | ≤ 8 axes; the axis order is meaningful and MUST be stable. |
| `gauge` | `value` | `min`, `max`, `thresholds`, `arc`, `showValue` | The unfilled track is a **lighter step of the fill's own ramp**, so state reads across the whole arc. |
| `funnel` | `category`, `value` | `orientation`, `showDropoff`, `shape` | Uses an *ordinal* ramp ([§11.3](#113-sequential-and-diverging-color)), whose lightest step must still clear 2:1 contrast. |
| `waterfall` | `category`, `value` | `total` (field marking subtotal rows), `connector` | Increase/decrease use the status palette, not categorical slots. |
| `treemap` | `category`, `value`, opt. `parent` | `tile` (`squarify`\|`slice`\|`dice`), `depth`, `labelMinArea` | Hierarchy via a `parent` field. |
| `sankey` | `source`, `target`, `value` | `nodeWidth`, `nodePadding`, `align`, `linkOpacity` | Cycles are `MDV3070`. |
| `gantt` | `task`, `start`, `end`, opt. `group` | `today`, `dependencies`, `progress` | A time-scaled bar chart with row identity. |
| `sparkline` | `y` (or `data`) | `curve`, `points`, `band`, `width`, `height` | Chromeless: no axes, no legend, no tooltip. Also available inline ([§9.2](#92-inline-directives)). |
| `metric` | `value` | `label`, `delta`, `deltaOf`, `trend`, `goodDirection`, `format` | A stat tile, not a chart ([§8.13](#813-metric--the-stat-tile)). |
| `table` | — | [§10](#10-enhanced-tables) | |
| `map` *(Level 3)* | `region`, `value` | `projection`, `topology`, `scheme` | Requires a topology resource; disabled when external resources are. |
| `network` *(Level 3)* | `source`, `target` | `layout`, `nodeSize`, `directed` | Layout MUST be deterministic (seeded, fixed iteration count). |

## 8.13 `metric` — the stat tile

The correct form when the answer is **one number**. A chart of a single value is
decoration.

```yaml
label: Monthly recurring revenue
value: 1284000
format: "$~s"
delta: 0.082
deltaOf: vs. last month
goodDirection: up
trend: [1.08, 1.11, 1.14, 1.19, 1.22, 1.28]
```

Contract: `label` in sentence case with no trailing colon; `value` auto-compacted
(`1,284` / `12.9K` / `$4.2M`) in the UI sans with **proportional** figures;
`delta` signed and always naming its comparison period, colored by
direction × `goodDirection`; `trend` an optional 12-point sparkline in the
de-emphasis hue with the current period accented.

A `:::mdv-grid` of metric blocks is the canonical KPI row. Exactly one **hero
figure** (`size: hero`, ≥ 48 px) per view.

## 8.14 Annotations

Available on any cartesian block:

```yaml
annotations:
  - {type: line, y: 1500, label: Target, style: dashed}
  - {type: band, x: [2026-03-01, 2026-03-15], label: Outage}
  - {type: point, x: 2026-05-02, y: 1820, label: Launch}
  - {type: text, x: 2026-06-01, y: 1900, text: "Peak", anchor: start}
```

Annotation ink is chrome, not data: it uses text and border tokens, never a
series color, so it can never be mistaken for a series.

---

# 9. Directives (inline and block)

MDV adopts the [generic directives] convention, which reserves `:` at three
levels for extension syntax. All MDV directive names are prefixed `mdv-`.

## 9.1 Block directives

```
:::mdv-grid{cols=2 gap=16}
… any Markdown, including visual blocks …
:::
```

| Directive | Attributes | Purpose |
|---|---|---|
| `mdv-grid` | `cols`, `gap`, `align`, `breakpoint` | Lays children on a grid. The canonical dashboard/KPI-row container. Collapses to one column below `breakpoint` (default 640 px). |
| `mdv-figure` | `id`, `label`, `caption` | Wraps content as a numbered figure; the target of `:mdv-ref[]`. |
| `mdv-callout` | `type` (`note`\|`tip`\|`warning`\|`danger`), `title` | Admonition. Status colors ship with an icon and a label, never color alone. |
| `mdv-tabs` / `mdv-tab` | `title`, `default` | Tabbed panels. In PDF all tabs render sequentially, each with its title as a subheading. |
| `mdv-columns` | `count`, `gap` | Multi-column text flow. |
| `mdv-page` | `break`, `orientation`, `size` | Print/PDF control ([§28.4](#284-pagination-control)). On screen it is a semantic marker with no visuals; an editor draws a page rule. |
| `mdv-details` | `summary`, `open` | Collapsible section; always expanded in PDF. |

Filters, where an embedder provides them, sit in **one row above** the content
they scope, never inside a chart, and scope every block below them.

## 9.2 Inline directives

| Directive | Example | Renders |
|---|---|---|
| `mdv-spark` | `:mdv-spark[12,15,13,19,24]{type=line}` | An inline sparkline sized to the line box. |
| `mdv-metric` | `:mdv-metric[1284000]{format="$~s"}` | An inline formatted number. |
| `mdv-delta` | `:mdv-delta[0.082]{good=up}` | A signed, colored delta with an arrow glyph *and* a sign. |
| `mdv-badge` | `:mdv-badge[Beta]{type=note}` | A status pill (icon + label). |
| `mdv-ref` | `:mdv-ref[fig-revenue]` | A cross-reference resolving to "Figure 3". |
| `mdv-value` | `:mdv-value[@sales.revenue.sum]{format=",.0f"}` | A value pulled from a dataset, so prose and charts cannot disagree. |

`mdv-value` is the one construct that lets narrative text stay in sync with the
data: the paragraph and the chart read from the same dataset, so an updated CSV
updates both.

**Degradation.** In a non-MDV renderer, an inline directive appears as its
literal source text. This is legible but noisy, so directives are Level 2 and
authors targeting mixed pipelines should prefer visual blocks.

---

# 10. Enhanced tables

Tables are the one visual that Markdown already has. MDV extends them in two
compatible ways.

## 10.1 The `mdv table` block

````markdown
```mdv table
title: Regional performance
columns:
  region:  {label: Region, align: left}
  revenue: {label: Revenue, type: number, format: "$,.0f", align: right}
  growth:  {label: YoY, type: number, format: "+.1%", heat: diverging, midpoint: 0}
  trend:   {type: sparkline, curve: monotone}
sort: [-revenue]
total: {revenue: sum, growth: mean}
zebra: true
sticky: header
---
region | revenue | growth | trend
APAC   |   42100 |  0.182 | 31,34,38,42
EMEA   |   31800 | -0.041 | 34,33,32,32
```
````

| Attribute | Type | Default | Notes |
|---|---|---|---|
| `columns` | map | inferred | Per-column config, ordered as written. |
| `columns.*.type` | field type \| `sparkline` \| `bar` \| `link` \| `badge` | inferred | Cell renderers. |
| `columns.*.heat` | `none`\|`sequential`\|`diverging`\|`bar` | `none` | In-cell magnitude encoding. |
| `columns.*.width` | dimension | auto | |
| `columns.*.wrap` | boolean | `true` | |
| `sort` | list | — | Initial sort; `-` = descending. |
| `sortable` | boolean | `true` (interactive) | Client-side sorting. |
| `total` | map | — | Footer aggregates. |
| `group` | field | — | Row grouping with group headers and subtotals. |
| `zebra` | boolean | `false` | |
| `sticky` | `none`\|`header`\|`first`\|`both` | `header` | |
| `pageSize` | integer | — | Paginates interactively; PDF renders all rows. |
| `caption` | string | — | |

**In-cell encodings.** A `bar` column draws a proportional bar behind the number;
a `sparkline` column parses a comma-separated list per cell; a `heat` column
tints the cell background. All three keep the number visible and legible — the
encoding supplements the value, never replaces it, and the text color flips
between white and ink by the fill's luminance.

## 10.2 GFM table attributes

A plain GFM table may be configured by an attached attribute directive on the
line immediately following it, so existing tables can gain formatting without
being rewritten:

```markdown
| region | revenue |
|--------|--------:|
| APAC   |   42100 |
{.mdv-table sortable=true total="revenue:sum"}
```

## 10.3 Table ↔ chart duality

Every visual block can render its underlying table
(`table: visible | details | hidden`), and every `mdv table` block can be
promoted to a chart by changing its type. This is a design commitment, not a
convenience: it is what makes [§12.3](#123-the-table-view) enforceable and PDF
export lossless.

---

# 11. Theming and rendering defaults

Rendering defaults are **normative**. A format whose output depends on each
implementation's taste is not a format. This section specifies the default theme
completely; an embedder may substitute its own values, but the *structure* — the
roles, the slot ordering discipline, the mark specifications — is fixed.

## 11.1 Theme tokens

A theme is a flat map of role → color, plus type and metric tokens. Documents
reference roles, never raw hex, so light/dark swap in one place.

| Role | Light | Dark |
|---|---|---|
| `surface` (chart surface) | `#fcfcfb` | `#1a1a19` |
| `page` (page plane) | `#f9f9f7` | `#0d0d0d` |
| `text-primary` | `#0b0b0b` | `#ffffff` |
| `text-secondary` | `#52514e` | `#c3c2b7` |
| `text-muted` (axis labels) | `#898781` | `#898781` |
| `grid` (hairline) | `#e1e0d9` | `#2c2c2a` |
| `axis` (baseline) | `#c3c2b7` | `#383835` |
| `border` (hairline ring) | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` |
| `success-text` | `#006300` | `#0ca30c` |

Type tokens: `fontFamily` = `system-ui, -apple-system, "Segoe UI", sans-serif`
for everything, including large figures. No display or serif face. Metric
tokens: `radius` 4, `hairline` 1, `gap` 2, `ring` 2.

Dark mode is a **selected** set of steps validated against the dark surface, not
an algorithmic inversion of the light theme.

## 11.2 Categorical color

Identity encoding. Eight slots, assigned **in fixed order and never cycled**:

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#4a3aa7` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

Normative rules:

1. **Color follows the entity, not its rank.** A series keeps its slot when a
   filter or a sort removes another series. Implementations MUST key the slot
   assignment on the series' identity (its value in the `series` field, or the
   field name in wide form), resolved in first-appearance order over the
   *unfiltered* domain.
2. **A ninth series is never a generated hue.** Beyond eight (or beyond the
   type's cap), series fold into "Other", facet into small multiples, or gain a
   second channel (shape, texture). Interpolating new hues destroys the CVD
   guarantees below.
3. **All-pairs forms cap at three.** The ordering above clears every adjacent-pair
   gate in both modes (worst adjacent CVD ΔE 9.1 light / 8.4 dark, OKLab ×100;
   worst adjacent normal-vision ΔE 19.6 / 19.3). Forms where *any* two series can
   appear side by side — scatter, bubble, choropleth, small multiples — need
   all-pairs separation, which the full eight cannot provide at any ordering;
   the first **three** slots do (worst pair CVD ΔE 9.2 light / 9.4 dark). Hence
   the cap in [§8.6](#86-scatter--bubble--relationship-between-two-measures).
4. **Three light-mode slots (magenta, yellow, aqua) fall below 3:1 against the
   light surface.** Where they are used, the block MUST ship visible direct
   labels or the table view. This is the *relief rule*: it is an obligation, not
   a suggestion.
5. **A substituted palette MUST be re-validated**, per ordering, against the
   actual surfaces — not reasoned about. See
   [§16.4](#164-palette-validation).

## 11.3 Sequential and diverging color

- **Sequential = one hue, light → dark.** Default hue blue, steps 100→700:
  `#cde2fb #b7d3f6 #9ec5f4 #86b6ef #6da7ec #5598e7 #3987e5 #2a78d6 #256abf #1c5cab #184f95 #104281 #0d366b`.
  Never a rainbow: a rainbow has no perceptual order, so cells cannot be ranked
  without the legend. A second concurrent sequential context takes the next
  categorical hue (orange) as its own one-hue ramp.
- **Ordinal ramps** (discrete ordered marks: funnel stages, tiers) must keep the
  step nearest the surface at ≥ 2:1 — on light, start no lighter than step 250
  (`#86b6ef`); on dark, go no darker than step 600 (`#184f95`).
- **Diverging = two hues + a neutral gray midpoint.** Default blue ↔ red, with
  midpoint `#f0efec` (light) / `#383835` (dark), equal step counts per arm. Never
  a hue at the midpoint — zero must read as "nothing".

## 11.3.1 Status palette (fixed, never themed)

| Role | Hex | Light contrast | Dark contrast |
|---|---|---|---|
| good | `#0ca30c` | 3.27 | 5.19 |
| warning | `#fab219` | 1.79 | 9.49 |
| serious | `#ec835a` | 2.57 | 6.60 |
| critical | `#d03b3b` | 4.68 | 3.62 |

Status colors are **reserved**: they never serve as "series 4", and they always
ship with an icon and a label so meaning never rests on hue. On the light surface
`warning` and `serious` are sub-3:1 by design — the icon+label pairing is the
mitigation. These are the defaults for OHLC direction, waterfall
increase/decrease, deltas, and callouts.

## 11.4 Mark specifications

Fixed across every chart type. The data is the only thing allowed to be loud.

| Mark | Specification |
|---|---|
| Bar / column | **≤ 24 px thick** (cap it; let the band's leftover be air); **4 px rounded data-end, square at the baseline**; grows from a single baseline. |
| Line | **2 px**, round join and cap. |
| Marker / end dot | **≥ 8 px diameter** (r ≥ 4), filled with the series color. |
| Area fill | series hue at **~10 % opacity** — a wash, never a saturated block. |
| Gridlines / axes | one step off surface, **1 px hairline, solid** (never dashed), recessive. |

**The two spacers — white does the separating.**

- **Surface gap:** a **2 px gap in the surface color** separates touching marks —
  every segment of a stacked bar and every adjacent bar, at one consistent width.
- **Surface ring:** dots and end markers carry a **2 px ring in the surface
  color** so they stay legible where they cross a line or each other. The ring is
  part of the hit target.

Never draw a border around a mark to separate it: a stroke adds data-weight ink
that is not data.

## 11.5 Labels and legends

- **Label selectively — never a number on every point.** Label the endpoint, the
  extreme, or the one series the story is about; the axis, legend, and table
  carry the rest. Direct labels work *because* they are sparing.
- **Direct labels before gridlines; gridlines before a second axis** — and there
  is no second axis ([§7.3.1](#731-the-one-axis-rule)).
- **A label that will not fit is not clipped.** The layout engine measures first.
  Outside the bar end if there is room, else the tooltip and the table view.
  `overflow: hidden` on a segment is never an acceptable solution — cropping the
  first characters is worse than no label.
- Bars → value at the tip. Columns → value on the cap. Lines → value at the end.
- **Text never wears the data color.** Values, labels, legends, and axis text use
  text tokens; identity comes from the colored mark *beside* the text. The one
  exception is a label set inside a colored fill, which picks white or ink by the
  fill's luminance.
- Y-axis ticks round to clean numbers, thousands-separated, `tabular-nums`.
  Large standalone figures use proportional figures instead.
- **Converging end labels** get leader lines or small multiples — never vertical
  nudging, which detaches a label from its line.

## 11.6 Custom themes

```yaml
---
theme:
  extends: default
  tokens:
    surface: "#ffffff"
    text-primary: "#111827"
  categorical: ["#2563eb", "#f97316", "#059669"]
  sequential: {hue: "#2563eb", steps: 13}
  diverging: {low: "#2563eb", high: "#dc2626", mid: "#f3f4f6"}
  font: {family: "Inter, system-ui, sans-serif", size: 13}
---
```

A theme may also be a named built-in (`default`, `dark`, `print`,
`high-contrast`) or a path to a theme file. **A reader MUST run palette
validation on a custom categorical palette and MUST report failures as
`MDV3080` warnings** — silently accepting an unreadable palette defeats the
purpose of specifying one.

## 11.7 Color scheme selection

Light/dark follows, in precedence order: the block's `theme`, the document's
`theme`, the embedder's setting, then `prefers-color-scheme`. A conforming web
renderer MUST support both under a single stylesheet, declaring dark values under
both `@media (prefers-color-scheme: dark)` and an explicit `[data-theme]` scope,
so a viewer's toggle wins in both directions.

Under `forced-colors: active`, charts switch to system colors plus the texture
channel ([§12.6](#126-texture--the-backup-channel)).

---

# 12. Accessibility

Normative. A visual that fails these is non-conforming, not merely imperfect.

## 12.1 Accessible name

Every visual block MUST expose an accessible name: `title` if present, else
`desc`, else a generated summary. The container carries `role="img"` (or
`role="figure"` when it has a caption) with `aria-label` or
`aria-labelledby`.

## 12.2 Descriptions

`desc` supplies the long description. When absent, the reader MUST generate one
from the encoding and the data — chart type, series count, domain extent, and the
notable extreme:

> "Bar chart. Revenue by quarter, 4 categories. Values range from 1,240 in Q1 to
> 1,893 in Q4. Highest: Q4."

Generated descriptions are marked as such in the AST (`descGenerated: true`) so
authoring tools can prompt for a better one. They are attached via
`aria-describedby` and become the PDF `/Alt` text.

## 12.3 The table view

**Every visual block MUST make its underlying data reachable as a table.**
Default `table: details` renders a collapsed `<details>` element after the chart
containing an accessible `<table>` with a `<caption>`, proper header scopes, and
formatted values. `table: none` is permitted only when the same data appears in a
visible table elsewhere in the document, and emits `MDV3090` (info).

This requirement is why tooltips may never gate a value
([§7.5](#75-tooltips-and-interaction)) and why PDF export is lossless.

## 12.4 Keyboard interaction

- The chart container is one tab stop (`tabindex="0"`).
- Arrow keys move between marks; <kbd>Home</kbd>/<kbd>End</kbd> jump to the
  extremes; <kbd>Page Up</kbd>/<kbd>Page Down</kbd> move between series;
  <kbd>Esc</kbd> exits to the container.
- The focused mark shows the **same readout as hover**, in a polite live region.
- The focus indicator MUST be visible against both the surface and the mark
  (a 2 px surface ring plus a 2 px ink ring).
- <kbd>T</kbd> toggles the table view when it is collapsed.

## 12.5 Color and contrast

- Identity MUST NOT rest on color alone: for ≥ 2 series a legend is always
  present, and ≤ 4 series are also direct-labelled.
- Graphical objects meet **3:1** against the surface (WCAG 1.4.11); text meets
  **4.5:1** (**3:1** for ≥ 18.66 px bold or ≥ 24 px). Where a categorical slot
  falls below 3:1 ([§11.2](#112-categorical-color) rule 4), the relief rule
  applies.
- Under `prefers-reduced-motion: reduce`, all animation and transitions are
  disabled; charts render in their final state immediately.
- Interactive targets ≥ 24 × 24 px.

## 12.6 Texture — the backup channel

Where hue fails (full-severity CVD, grayscale print, `forced-colors`), texture
carries identity: **one directional fill at 45° and its 135° mirror only** —
never horizontal or vertical, which read as gridlines or bars — inked
tone-on-tone from the fill's own ramp, equal loudness across slots. On value
scales the texture is *ordered* (rotation steps with magnitude; arm angle carries
the diverging sign) so it never misstates the value. Triggered by
`accessibility.texture: true`, print, or `forced-colors` — never on by default.

## 12.7 Document structure

Headings map to `h1`–`h6` without skipping levels; figures are `<figure>` with
`<figcaption>`; the reader exposes a document outline; `lang` sets the root
language and inline `lang` is honoured.

---

# 13. Security model

**Threat model.** MDV documents are treated as untrusted input: they arrive from
users, repositories, and the network. The reader is assumed to run inside a
privileged application (a browser page holding a session, an editor, a build
server). The goal is that rendering an arbitrary MDV document cannot execute
code, exfiltrate data, or exhaust the host.

## 13.1 No code execution

- A document MUST NOT be able to introduce executable code. There is no script
  attribute, no event handler attribute, no expression that can reach a host
  object.
- MDVX ([§6.8](#68-mdvx--the-expression-language)) MUST NOT be implemented with
  `eval`, `new Function`, `setTimeout(string)`, or any dynamic code construction,
  and MUST NOT expose property access, prototypes, or globals.
- Plugin code comes from the **embedder**, never from the document. A document's
  `plugins:` key is a *request*; the embedder decides
  ([§26.3](#263-plugin-trust)).

## 13.2 External data

`src:` and remote themes/topologies are **disabled by default**
(`security.allowExternal: false`). When an embedder enables them:

- An **allowlist** of origins is REQUIRED; `*` is permitted only for explicit
  opt-in and SHOULD be refused by CLI defaults.
- Requests are `GET` only, `credentials: 'omit'`, `redirect: 'error'` beyond
  `maxRedirects` (default 2), with `Accept` restricted to the data media types.
- **SSRF defence:** hostnames resolving to loopback, link-local (`169.254/16`,
  `fe80::/10`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), or
  metadata addresses (`169.254.169.254`) MUST be refused (`MDV4022`), including
  after redirects. `file:` is allowed only for local CLI use with an explicit
  `--allow-file` flag and a root confinement.
- Timeouts (default 5 s), response size caps (default 8 MiB), and decompression
  bomb limits apply.
- Fetch failures degrade to a placeholder with a stated reason; they never throw
  into the host application and never leave a chart looking like it has no data.

## 13.3 Output sanitisation

- All text originating in a document — field names, category values, titles,
  labels — is inserted as **text nodes** (`textContent` / `createTextNode`),
  never via `innerHTML`.
- The SVG serialiser escapes `& < > " '` in text content and attribute values,
  and rejects attribute names outside a fixed allowlist.
- Generated element `id`s are namespaced and derived from a per-render counter,
  never from document content, so a document cannot collide with host DOM ids or
  break `aria-labelledby` wiring.
- URLs in `link` columns and autolinks are restricted to `http:`, `https:`,
  `mailto:`, and same-document `#` fragments; `javascript:`, `data:`, and `vbscript:`
  are stripped (`MDV4010`). External links get `rel="noopener noreferrer"`.

## 13.4 HTML and embedded content

Raw HTML is disabled by default ([§4](#4-base-syntax)). When an embedder enables
it, the reader MUST sanitise with an allowlist (elements, attributes, URL
schemes) before insertion, and MUST NOT allow `<script>`, `<style>`, `<iframe>`,
`<object>`, `<embed>`, `<form>`, or event handler attributes. Images are subject
to the same origin policy as `src:`.

## 13.5 Content Security Policy

The web renderer MUST function under
`default-src 'none'; img-src 'self' data:; style-src 'self' 'nonce-…'` with **no**
`unsafe-inline` and **no** `unsafe-eval`. Styles are emitted with a nonce or as
an external stylesheet. This is a hard requirement because the VS Code webview
([§29.3](#293-preview)) enforces exactly this.

## 13.6 Resource limits

Defaults, all configurable, all producing a diagnostic and a partial render
rather than a hang:

| Limit | Default |
|---|---|
| Document size | 8 MiB |
| Visual blocks per document | 500 |
| Rows per block (after transforms) | 100,000 |
| Marks per block | 50,000 (above `canvasThreshold`, Canvas is used) |
| Fields per table | 512 |
| Transform steps per block | 32 |
| Expression length / depth / calls | 1024 chars / 32 / 64 |
| Parse time per document | 5 s |
| Render time per block | 2 s |
| Total memory per document | 256 MiB |

Parsing MUST be linear in input size. Regular expressions used in parsing MUST
be verified free of catastrophic backtracking, or replaced with hand-written
scanners — the header, table, and CSV scanners in the reference implementation
are hand-written for this reason.

## 13.7 Privacy

Rendering MUST NOT emit telemetry, MUST NOT fetch fonts or assets from third
parties (fonts are bundled or system), and MUST NOT include document content in
generated identifiers or in error reports sent anywhere.

---

# 14. Errors and diagnostics

## 14.1 Principles

1. **A document always renders.** No single bad block may prevent the rest of the
   document from rendering.
2. **Failures are visible, not silent.** A block that cannot render shows an
   error card carrying the code, the message, and the raw data — never an empty
   frame.
3. **Every diagnostic carries a precise source range**, so an editor can underline
   exactly the offending attribute value.
4. **Errors are data, not exceptions.** The API returns diagnostics; it does not
   throw for document-level problems. Exceptions are reserved for programmer
   error in the host.

## 14.2 Diagnostic shape

```ts
interface Diagnostic {
  code: string;                 // "MDV3010"
  severity: 'error' | 'warning' | 'info';
  message: string;              // one sentence, no trailing period
  detail?: string;              // explanation and fix
  range: Range;                 // { start: Position, end: Position }
  blockId?: string;
  source: 'parse' | 'data' | 'encode' | 'security' | 'render';
  fixes?: CodeFix[];            // machine-applicable, surfaced by the LSP
}
interface Position { offset: number; line: number; column: number } // 1-based line/col
```

## 14.3 Severity semantics

| Severity | Meaning | Rendering |
|---|---|---|
| `error` | The block cannot render as specified. | Error card with the data table. |
| `warning` | Renders, but the result probably misleads (truncated axis, unvalidated palette, dropped rows). | Renders, badge in dev mode. |
| `info` | A better form exists (pie with 9 slices, unshared facet scales). | Renders silently; visible in lint. |

`strict: true` promotes warnings to errors; CI uses
`mdv lint --max-severity warning`.

## 14.4 Ranges

Every diagnostic's range refers to the **original document**, not to a
reconstructed fragment. Parsers MUST therefore track offsets through the header
sub-parse and the data sub-parse, mapping a bad cell at data row 4 column 2 back
to its absolute source position. This is what makes editor squiggles land on the
right character.

The full code list is [Appendix C](#appendix-c--error-codes).

---

# 15. Extensibility

## 15.1 Extension attributes

Attributes beginning `x-` are reserved for extensions. Core MUST preserve them in
the AST, pass them to plugins, and otherwise ignore them without diagnostics.

## 15.2 Unknown constructs

| Construct | Behaviour |
|---|---|
| Unknown block type | Render the data as a table with a notice naming the type. `MDV1500` (warning). Never an error: a document using a Level 3 type must stay readable in a Level 1 reader. |
| Unknown attribute | Ignore; `MDV1501` (info). |
| Unknown enum value | Fall back to the default; `MDV1502` (warning). |
| Unknown directive | Render children as ordinary content; `MDV1503` (info). |
| Unknown front-matter key | Preserve, ignore, no diagnostic. |
| Unknown transform step | `MDV2500` (error) on that block — silently skipping a filter would show wrong data, which is worse than failing. |

The asymmetry is deliberate: unknown *presentation* degrades, unknown *data
semantics* fails loudly.

## 15.3 Version negotiation

| Situation | Behaviour |
|---|---|
| `mdv` major > reader major | Render with a prominent document-level notice; `MDV1510` (warning). Best effort. |
| `mdv` minor > reader minor | Render; `MDV1511` (info). Unknown constructs degrade per §15.2. |
| `mdv` ≤ reader | Render, applying the compatibility profile of that version. |
| `mdv` absent | Assume the reader's version; `MDV1100` (info). |

Readers MUST NOT change the meaning of an existing attribute across minor
versions. When behaviour must change, the old spelling is deprecated (diagnostic
`MDV15xx`) and a new one is added.

---

# 16. Conformance

## 16.1 Levels

| Level | Name | Requirements |
|---|---|---|
| **1** | Core | Front matter, base syntax, visual blocks, `table`/`csv`/`tsv` data, datasets, type inference, the attribute cascade, and the types `bar`, `line`, `area`, `pie`, `donut`, `scatter`, `table`, `metric`. Theme tokens, mark specs, the table view, accessible names, error cards. |
| **2** | Standard | All of Level 1, plus `json`/`ndjson`/`columns`/`matrix`, transforms, MDVX, faceting, directives, inline sparklines, and the types `histogram`, `box`, `heatmap`, `ohlc`, `ohlcv`, `candlestick`, `radar`, `gauge`, `funnel`, `waterfall`, `treemap`, `sankey`, `sparkline`. Full keyboard interaction, PDF export, custom themes. |
| **3** | Extended | All of Level 2, plus `map`, `network`, `gantt`, math, external data, live data sources, plugins, and cross-document `include`. |

A reader MUST advertise its level and MUST implement every feature of the levels
below the one it claims. The reference implementation targets Level 2 in v1.0,
Level 3 in v1.1 ([Appendix F](#appendix-f--repository-layout--milestones)).

## 16.2 Test suite

The normative test suite lives in `packages/spec/tests/` and is versioned with
the spec. Each case is a directory:

```
tests/bar/stacked-percent/
  input.mdv           # source
  expected.ast.json   # canonical AST (§19), after resolution
  expected.svg        # canonical SVG at 800×400, default theme, light
  expected.dark.svg
  expected.pdf.json   # PDF operator trace (not bytes — see §28.10)
  diagnostics.json    # expected diagnostics, ordered
  meta.json           # { level: 2, tags: ["bar","stack"] }
```

Categories: `syntax/` (parsing, degradation, malformed input), `data/`
(formats, inference, nulls, transforms), `encode/` (channels, scales, domains),
`render/` (per type, per theme, edge cases: empty data, one row, 10 000 rows,
extreme aspect ratios, RTL text, CJK labels), `a11y/` (names, descriptions,
table views, focus order), `security/` (injection attempts, SSRF, limits),
`pdf/`, `perf/`.

A claim of conformance at level *N* means: every case tagged ≤ *N* passes; SVG
output matches byte-for-byte after canonicalisation
([§24.3](#243-determinism)); no case produces an unhandled exception.

## 16.3 Golden-file policy

Golden files are regenerated only by an explicit `pnpm test:update`, and a
regeneration commit MUST NOT also contain source changes — that is the only way a
reviewer can tell an intentional rendering change from an accidental one.

## 16.4 Palette validation

A conforming implementation MUST include an executable palette validator and MUST
run it in CI over the built-in themes and over any theme fixture. It checks, per
mode and against that mode's actual surface: the lightness band, the chroma
floor, adjacent-pair CVD separation (target ΔE ≥ 8, OKLab ×100; 6–8 legal only
with secondary encoding), the normal-vision floor (ΔE ≥ 15 — a hard fail), and
contrast. A contrast warning obligates visible labels or the table view; it is
not dismissable.

Palette safety is computed, never eyeballed.

---

# Part II — The reader

# 17. Architecture

## 17.1 Shape of the system

The central architectural decision: **one layout engine, several dumb backends.**
Layout produces a renderer-agnostic [scene graph](#20-the-scene-graph); SVG,
Canvas, and PDF backends translate that scene graph into their own primitives and
make no layout decisions of their own.

This is what buys:

- **PDF that matches the screen** — the same geometry, not a re-implementation.
- **Determinism and testability** — the scene graph is a plain data structure and
  can be snapshot-tested without a DOM.
- **Server rendering** — no `document`, no `window`, no measurement of live DOM;
  text measurement goes through an injectable metrics provider.

```
                        ┌───────────────────┐
   .mdv  ──────────────▶│  @mdv/parser      │──▶ MDV AST
                        └───────────────────┘
                                  │
                        ┌───────────────────┐
                        │  @mdv/core        │  datasets · transforms · MDVX
                        │  (resolve→validate│  type inference · scales
                        │   →encode→layout) │  theme cascade · a11y text
                        └───────────────────┘
                                  │
                            Scene graph (IR)
                    ┌─────────────┼─────────────┬──────────────┐
              ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐ ┌──────▼──────┐
              │ render-svg│ │render-can-│ │ render-pdf│ │ render-text │
              │ (DOM+str) │ │  vas      │ │           │ │ (a11y/CLI)  │
              └───────────┘ └───────────┘ └───────────┘ └─────────────┘
                    │
              ┌─────▼─────┐   ┌──────────┐   ┌──────────┐
              │ @mdv/react│   │ @mdv/cli │   │ @mdv/lsp │
              └───────────┘   └──────────┘   └──────────┘
                                                  │
                                            ┌─────▼─────┐
                                            │vscode-mdv │
                                            └───────────┘
```

## 17.2 Packages

| Package | Responsibility | Depends on | Env |
|---|---|---|---|
| `@mdv/spec` | This document, JSON Schemas, the test suite, error-code table. No runtime code. | — | — |
| `@mdv/parser` | Text → MDV AST. CommonMark + GFM + visual blocks + directives + front matter. Position-accurate. | `micromark`, `mdast-util-*` | universal |
| `@mdv/core` | Datasets, data formats, type inference, transforms, MDVX, scales, ticks, formatting, theme cascade, validation, encoding, layout → scene graph, accessible-text generation. **No DOM.** | `@mdv/parser` | universal |
| `@mdv/charts` | Per-type encoders and layout algorithms, registered into core. Tree-shakeable per type. | `@mdv/core` | universal |
| `@mdv/render-svg` | Scene graph → SVG (DOM nodes or a string). Interaction layer for DOM. | `@mdv/core` | universal |
| `@mdv/render-canvas` | Scene graph → Canvas2D, with a hit-test index. Used above `canvasThreshold`. | `@mdv/core` | browser/node-canvas |
| `@mdv/render-pdf` | Scene graph + document flow → PDF. Font subsetting, tagging. | `@mdv/core`, `pdf-lib`, `fontkit` | node/browser |
| `@mdv/react` | React components and hooks. | `@mdv/core`, `@mdv/render-svg` | browser |
| `@mdv/themes` | Built-in themes and the palette validator. | — | universal |
| `@mdv/cli` | `render`, `export`, `lint`, `fmt`, `watch`, `serve`. | all | node |
| `@mdv/lsp` | Language server: diagnostics, completion, hover, formatting, symbols, code actions. | `@mdv/core` | node |
| `vscode-mdv` | The extension: preview, grammar, commands, client. | `@mdv/lsp`, `@mdv/react` | vscode |

Rules: every package is ESM-only with `exports` maps and `sideEffects: false`;
`@mdv/core` MUST NOT import from any DOM or Node built-in; each package ships its
own `.d.ts` generated from source, not hand-written.

## 17.3 Non-negotiable invariants

1. `@mdv/core` never touches the DOM, the filesystem, the network, or the clock.
   All four arrive through injected capabilities
   ([§25.2](#252-capabilities)).
2. Layout is pure: `(ResolvedBlock, Theme, Size, TextMetrics) → Scene`.
3. Backends are total: any valid scene graph renders on any backend, or the
   backend declares the node type unsupported at registration time.
4. No global mutable state. Two documents render concurrently without
   interference — required for a server and for the VS Code preview.

---

# 18. Processing pipeline

Seven stages. Each is separately callable and separately cacheable.

| # | Stage | In → Out | Notes |
|---|---|---|---|
| 1 | **Parse** | text → `MdvDocument` (AST) | Position-accurate. Never fails on malformed content; produces diagnostics and `error` nodes. |
| 2 | **Resolve** | AST → AST + `DataRegistry` | Builds the dataset DAG, fetches `src:` (async), applies the attribute cascade, resolves themes. The only async stage. |
| 3 | **Validate** | resolved block → diagnostics | Schema check, channel/type compatibility, security limits. Produces `fixes` for the LSP. |
| 4 | **Prepare** | table → table | Type inference/coercion, null normalisation, transform pipeline, memoised per (dataset, pipeline). |
| 5 | **Encode** | table + encoding → marks | Series identity and slot assignment, scale construction, domain computation, mark data. Renderer-agnostic. |
| 6 | **Layout** | marks + size + metrics → `Scene` | Axis/tick/legend/label geometry, collision resolution, faceting, panel splits. Pure. |
| 7 | **Render** | `Scene` → target output | SVG nodes/string, Canvas ops, PDF operators, text. |

**Incremental behaviour.** The VS Code preview and any live editor re-runs from
the earliest stage whose inputs changed, keyed by content hash: editing a title
re-runs 5–7 for one block; editing a dataset re-runs 4–7 for its dependents;
resizing re-runs 6–7 only. Stage 2's network results are cached separately, so a
resize never refetches.

---

# 19. The MDV AST

An extension of [mdast]. Standard mdast node types are unchanged; MDV adds four.
Every node carries `position` with absolute offsets.

```ts
interface MdvDocument extends Parent {
  type: 'root';
  frontmatter?: FrontMatter;
  children: (Content | MdvBlock | MdvDirective)[];
  diagnostics: Diagnostic[];
  datasets: Record<string, DatasetNode>;   // populated at resolve
}

interface MdvBlock extends Node {
  type: 'mdvBlock';
  blockType: string;                 // 'bar' | 'ohlcv' | 'dataset' | …
  attrs: AttrMap;                    // parsed header ∪ info-string attrs
  attrsPosition: Record<string, Range>;  // per-key ranges, for diagnostics & LSP
  raw: { header: string; data: string; fence: string };
  data?: TableRef;                   // set at resolve
  level: 1 | 2 | 3;                  // conformance level required
}

interface MdvDirective extends Node {
  type: 'mdvDirective';
  kind: 'inline' | 'leaf' | 'container';
  name: string;                      // 'mdv-grid'
  attrs: AttrMap;
  label?: string;                    // bracketed content
  children?: Content[];
}

interface MdvError extends Node {
  type: 'mdvError';
  diagnostic: Diagnostic;
  raw: string;                       // preserved source, shown in the error card
}
```

**Canonical form.** For test fixtures the AST is serialised with sorted object
keys, `position` reduced to `[startOffset, endOffset]`, and floats formatted to
6 significant digits, so `expected.ast.json` diffs are meaningful.

`toMarkdown` MUST round-trip: parse → serialise → parse produces an identical
AST. This is what makes `mdv fmt` and the LSP's formatter safe.

---

# 20. The scene graph

The IR every backend consumes. Deliberately small, flat, and free of styling
abstractions: all values are resolved absolutes in a single coordinate space with
the origin at the block's top-left, y increasing downward, units in CSS pixels.

```ts
interface Scene {
  width: number;
  height: number;
  background?: Paint;
  defs: Def[];                 // gradients, clips, patterns (textures)
  root: GroupNode;
  a11y: A11yTree;              // accessible name/desc/table + focus order
  hitIndex: HitRegion[];       // resolved once, shared by DOM and Canvas
  meta: { blockId: string; type: string; theme: string; version: string };
}

type SceneNode =
  | GroupNode | RectNode | LineNode | PathNode | CircleNode
  | TextNode | ImageNode | UseNode;

interface GroupNode  { kind: 'group'; id?: string; transform?: Transform;
                       clip?: string; opacity?: number; children: SceneNode[];
                       role?: A11yRole; label?: string }
interface RectNode   { kind: 'rect'; x, y, w, h: number;
                       r?: number | [number, number, number, number];  // per-corner
                       fill?: Paint; stroke?: Stroke }
interface LineNode   { kind: 'line'; x1, y1, x2, y2: number; stroke: Stroke }
interface PathNode   { kind: 'path'; d: PathCommand[];      // structured, not a string
                       fill?: Paint; stroke?: Stroke; fillRule?: 'nonzero' | 'evenodd' }
interface CircleNode { kind: 'circle'; cx, cy, r: number; fill?: Paint; stroke?: Stroke }
interface TextNode   { kind: 'text'; x, y: number; text: string; font: Font;
                       fill: Paint; anchor: 'start'|'middle'|'end';
                       baseline: 'top'|'middle'|'alphabetic'|'bottom';
                       rotate?: number; width?: number;   // measured, for collision
                       tabular?: boolean }
```

Design constraints, all load-bearing:

- **Paths are structured commands**, not SVG `d` strings. A PDF backend that has
  to re-parse `d` strings is a source of divergence, and structured commands
  round to a fixed precision for determinism.
- **Text nodes carry measured width.** Measurement happens once, in layout,
  through the injected metrics provider — so SVG, Canvas, and PDF agree on
  whether a label fits, and PDF pagination never disagrees with the screen.
- **No CSS.** Backends do not inherit, cascade, or resolve custom properties.
  The theme was resolved in stage 6.
- **`hitIndex` is computed in layout**, so DOM and Canvas hit-testing behave
  identically and a 24 px minimum target is enforced in one place.
- **`a11y` is part of the scene**, not a DOM afterthought, so the PDF exporter can
  emit the same descriptions as tagged content.

---

# 21. Core TypeScript API

```ts
// ─────────────────────────── parse ───────────────────────────
export function parse(source: string, options?: ParseOptions): MdvDocument;

// ────────────────────────── resolve ──────────────────────────
export function resolve(
  doc: MdvDocument,
  config?: MdvConfig,
): Promise<ResolvedDocument>;

export function resolveSync(          // no `src:`; throws MDV4001 if one is present
  doc: MdvDocument,
  config?: MdvConfig,
): ResolvedDocument;

// ─────────────────────── layout & render ─────────────────────
export function layoutBlock(
  block: ResolvedBlock,
  size: { width: number; height: number },
  ctx: LayoutContext,               // theme, metrics, locale, level
): Scene;

export interface Renderer<T> {
  readonly target: 'svg' | 'canvas' | 'pdf' | 'text';
  render(scene: Scene, host: T): RenderHandle;
}

// ─────────────────────────── facade ──────────────────────────
export class Mdv {
  constructor(config?: MdvConfig);
  async render(source: string, host: HTMLElement): Promise<MdvInstance>;
  async toSVG(source: string, opts?: { width?: number }): Promise<string[]>;
  async toHTML(source: string, opts?: HtmlOptions): Promise<string>;
  async toPDF(source: string, opts?: PdfOptions): Promise<Uint8Array>;
  async lint(source: string): Promise<Diagnostic[]>;
  format(source: string, opts?: FormatOptions): string;
}

export interface MdvInstance {
  readonly document: ResolvedDocument;
  readonly diagnostics: readonly Diagnostic[];
  update(source: string): Promise<void>;   // incremental
  setTheme(theme: string | Theme): void;
  resize(): void;
  getBlock(id: string): BlockHandle | undefined;
  exportBlock(id: string, as: 'svg' | 'png' | 'csv'): Promise<Blob>;
  destroy(): void;
}
```

### Error contract

`parse` and `layoutBlock` never throw on document content; they return
diagnostics and `mdvError` nodes. `resolve` rejects only on **capability**
failures (a filesystem the embedder promised but did not provide). Host
programmer errors — an unknown renderer target, a malformed config — throw
`MdvConfigError` synchronously.

### Text metrics

```ts
export interface TextMetrics {
  measure(text: string, font: Font): { width: number; ascent: number; descent: number };
}
```

Three implementations ship: `CanvasMetrics` (browser), `FontkitMetrics` (Node
and PDF; exact, from the embedded font), and `TableMetrics` (a bundled width
table for the default font stack — the deterministic default, used whenever
output must be reproducible across machines).

---

# 22. React binding

## 22.1 Components

```tsx
import { MdvDocument, MdvBlock, MdvProvider } from '@mdv/react';

<MdvProvider theme="auto" config={{ security: { allowExternal: false } }}>
  <MdvDocument
    source={markdown}
    onDiagnostics={setDiagnostics}
    onSelect={(blockId) => reveal(blockId)}
    components={{ h2: Heading, a: Link }}   // override rendered markdown elements
    loading={<Skeleton />}
  />
</MdvProvider>
```

```tsx
// A single chart, without a surrounding document
<MdvBlock
  type="line"
  attrs={{ x: 'date', y: 'value', title: 'Signups' }}
  data={rows}
  height={280}
/>
```

## 22.2 Hooks

```ts
const { doc, diagnostics, status } = useMdv(source, config);
const scene  = useMdvScene(block, { width, height });   // memoised on content hash
const theme  = useMdvTheme();                            // resolved tokens
const size   = useElementSize(ref);                      // ResizeObserver, debounced
```

## 22.3 Rendering behaviour

- **React 18+**, function components, no class components, `StrictMode`-clean
  (all effects idempotent; no work in render).
- The DOM is **React-owned**: `@mdv/render-svg` exposes a `toReactElements(scene)`
  path in addition to its imperative DOM path, so charts are ordinary JSX and
  reconcile normally. Canvas blocks render a `<canvas>` and draw in an effect.
- **Server rendering** works: `resolveSync` + `TableMetrics` + SVG-string output.
  Hydration attaches interaction only; markup MUST match, which the deterministic
  id scheme guarantees.
- **Virtualisation:** blocks below the fold render a correctly-sized placeholder
  and mount on `IntersectionObserver` (`rootMargin: '200px'`). Off-screen blocks
  do not lay out. `renderPolicy: 'eager'` disables this for printing.
- **Resize:** a `ResizeObserver` per block, debounced to one animation frame,
  re-running stages 6–7 only. Width changes below 1 px are ignored.
- Suspense boundaries wrap external-data blocks; each block is its own error
  boundary so a plugin crash cannot take out the document.

## 22.4 Styling

The renderer ships one stylesheet of ~2 KB using custom properties for every
token and no global selectors — all rules are scoped under `.mdv-root`. Consumers
may re-theme entirely with custom properties, or pass `unstyled` and supply their
own. Class names are stable and namespaced (`mdv-axis`, `mdv-legend-item`) and
are part of the public API, versioned with the package.

---

# 23. Render backends

## 23.1 SVG

The default. Accessible (real text, real focus), scalable, printable,
diff-friendly.

- One `<svg>` per block with `role="img"`/`"figure"`, `aria-labelledby`, and a
  `viewBox`; `preserveAspectRatio="xMidYMid meet"`.
- Text is real `<text>`, never paths, so it is selectable, searchable, and
  translatable.
- Interaction lives in an overlay `<g>` of transparent hit rects driven by
  `hitIndex`, so hit targets are independent of mark size.
- The string serialiser is deterministic: attribute order fixed, numbers rounded
  to 3 decimals with `-0` normalised to `0`, no whitespace between elements.

## 23.2 Canvas

Selected automatically when a scene exceeds `canvasThreshold` (default 5 000
marks), or forced with `render: canvas`.

- Renders at `devicePixelRatio`, capped at 2 for memory.
- Hit-testing uses the same `hitIndex` (a uniform grid over mark bounds), never
  a per-pixel scan.
- **Accessibility does not regress:** the accessible name, description, and the
  table view are DOM as usual, and a keyboard focus proxy walks the same focus
  order, drawing the focus ring on the canvas. A canvas chart is never a
  black box to a screen reader.
- Text still measured through the same provider, so layout matches SVG exactly.

## 23.3 SVG string / static HTML

For SSR, `mdv export --html`, and embedding in other pipelines. Emits either a
single self-contained HTML file (inlined CSS, inlined fonts as WOFF2 data URLs,
no scripts) or per-block SVG strings.

## 23.4 Text

Renders a document to plain text or ANSI for CLI use: charts become their table
views plus the generated description, and sparklines become Unicode block
characters. This is the fallback that keeps `mdv render` useful in a terminal and
in diff tooling.

---

# 24. Performance requirements

## 24.1 Budgets

Measured on a 2020-class laptop (4-core, no GPU acceleration assumed), median of
20 runs, cold cache.

| Operation | Budget |
|---|---|
| Parse 100 KB document (≈50 blocks) | ≤ 30 ms |
| Parse 1 MB document | ≤ 250 ms |
| Prepare + encode + layout, 1 000-row line chart | ≤ 8 ms |
| Layout + render, 10 000-point scatter (canvas) | ≤ 40 ms |
| First contentful chart, 50-block document | ≤ 100 ms after parse |
| Interaction frame (hover, crosshair) | ≤ 8 ms; never drops below 60 fps |
| Resize reflow, 20 visible blocks | ≤ 50 ms |
| Incremental update, one attribute changed | ≤ 5 ms |
| PDF export, 50-page document | ≤ 3 s |
| Bundle: `@mdv/core` + `@mdv/react` + `bar,line,area` | ≤ 65 KB gzipped |
| Bundle: every Level 2 chart type | ≤ 140 KB gzipped |

Budgets are enforced by `perf/` fixtures in CI; a regression beyond 10 % fails
the build.

## 24.2 Techniques

- **Structure-of-arrays** for prepared tables (one typed array per numeric
  column) — avoids per-row object allocation on large data.
- **Memoise by content hash** at every stage boundary; a 64-bit FNV-1a over the
  canonical stage input.
- **Downsample for display, never for values:** line and area blocks over
  `downsampleThreshold` (default 4 000 points per series) use LTTB, which
  preserves visual extrema. The table view and tooltips always read the full
  data, and `MDV5010` (info) records that downsampling occurred.
- **Lazy chart-type registration:** each type is a dynamic import registered on
  first use, so a document with only bar charts never loads the sankey layout.
- **No layout thrash:** the DOM renderer batches all reads before all writes;
  measurement never happens inside a render loop.
- **Web Worker (optional):** stages 4–6 run in a worker when
  `worker: true`, transferring the scene graph. The scene graph is
  structured-clone-safe by construction — another reason it holds no functions.

## 24.3 Determinism

> Same source + same config + same version ⇒ **byte-identical** output.

Required for: golden-file tests, content-addressed caching, PDF diffing, and
reproducible builds.

Rules:
1. No `Math.random()`. Any algorithm needing randomness (force layout, jitter,
   Poisson label placement) takes a seed derived from the block id, defaulting to
   a constant.
2. No wall-clock reads. `now()` is `config.buildTime`.
3. No locale/timezone from the host: both come from config, defaulting to `en-US`
   and `UTC`.
4. Numbers are serialised through one formatter: round-half-even to 3 decimals,
   strip trailing zeros, normalise `-0`.
5. Iteration order over maps is insertion order, and any set derived from data is
   sorted before use.
6. Font metrics come from the deterministic table or from the embedded font file,
   never from the host's font stack.
7. Element ids are `mdv-{blockIndex}-{counter}`, never content-derived (which
   would leak content into markup) and never random.

---

# 25. Configuration

```ts
interface MdvConfig {
  level?: 1 | 2 | 3;
  strict?: boolean;                      // warnings become errors
  theme?: string | Theme;
  colorScheme?: 'light' | 'dark' | 'auto';
  locale?: string;                       // default 'en-US'
  timezone?: string;                     // default 'UTC'
  buildTime?: Date;                      // pins now()
  defaults?: Partial<BlockAttrs>;        // cascade level 4 (§5.5)

  security?: {
    allowExternal?: boolean;             // default false
    allowedOrigins?: string[];
    allowHtml?: boolean;                 // default false
    allowFileUrls?: boolean;             // default false
    maxDocumentBytes?: number;
    maxRowsPerBlock?: number;
    fetchTimeoutMs?: number;
  };

  render?: {
    target?: 'svg' | 'canvas' | 'auto';
    canvasThreshold?: number;            // default 5000
    downsampleThreshold?: number;        // default 4000
    animate?: boolean;
    renderPolicy?: 'lazy' | 'eager';
    worker?: boolean;
  };

  a11y?: { texture?: boolean; tableView?: 'details'|'visible'|'hidden'; generateDesc?: boolean };
  plugins?: MdvPlugin[];
  capabilities?: Capabilities;
  onDiagnostic?: (d: Diagnostic) => void;
}
```

Configuration merges: built-in defaults ← embedder config ← front matter (only
for keys a document is permitted to set; **`security` is never document-settable**).

## 25.2 Capabilities

Everything impure is injected, which is what keeps `@mdv/core` portable and
testable:

```ts
interface Capabilities {
  fetch?: (url: string, init: FetchInit) => Promise<FetchResult>;
  readFile?: (path: string) => Promise<Uint8Array>;
  metrics?: TextMetrics;
  cache?: KeyValueCache;
  logger?: Logger;
}
```

Omitting a capability disables the features that need it, with a diagnostic
rather than a crash.

---

# 26. Plugin API

## 26.1 Shape

```ts
interface MdvPlugin {
  name: string;
  version: string;
  level?: 1 | 2 | 3;

  chartTypes?: ChartTypeDefinition[];
  transforms?: TransformDefinition[];
  functions?: ExpressionFunction[];     // added to the MDVX whitelist
  dataFormats?: DataFormatDefinition[];
  themes?: Theme[];
  directives?: DirectiveDefinition[];
}

interface ChartTypeDefinition {
  name: string;
  level: 1 | 2 | 3;
  schema: JSONSchema;                   // validated attributes
  channels: ChannelSpec[];
  encode(table: PreparedTable, attrs: ResolvedAttrs, ctx: EncodeContext): MarkSet;
  layout(marks: MarkSet, size: Size, ctx: LayoutContext): Scene;
  describe?(table: PreparedTable, attrs: ResolvedAttrs): string;  // a11y text
}
```

A plugin adds *declarative capability*, and its chart type is a pure function to
a scene graph like any built-in — so a plugin chart automatically gets PDF export,
the table view, keyboard interaction, and determinism testing. A plugin that
wants to draw its own DOM is out of scope by design.

## 26.2 Registration

```ts
const mdv = new Mdv({ plugins: [ganttPlugin, corporateTheme] });
```

Plugins are ordered; later registrations override earlier ones for the same name,
and overriding a built-in emits `MDV1520` (info).

## 26.3 Plugin trust

A document's `plugins:` front-matter key is a **declaration of requirement**, not
an instruction to load. The reader checks the requested names against the
registered set and, if any are missing, renders those blocks per
[§15.2](#152-unknown-constructs) with a notice. **No code is ever fetched or
loaded because a document asked for it.**

---

# 27. CLI

```
mdv render <file>            Render to the terminal (text backend)
mdv export <file>            Export: --to pdf|html|svg|png|md|json
mdv lint <glob>              Diagnostics; --max-severity, --format json|pretty|sarif
mdv fmt <glob>               Canonical formatting; --check for CI
mdv watch <file>             Rebuild on change; --serve for a live preview server
mdv data <file>              Print a block's resolved table; --block <id> --to csv|json
mdv validate-theme <file>    Run the palette validator (§16.4)
mdv init                     Scaffold a document with front matter
```

Global flags: `--config`, `--theme`, `--level`, `--strict`, `--locale`,
`--timezone`, `--build-time`, `--allow-external`, `--allow-file`, `--quiet`,
`--no-color`.

Exit codes: `0` success · `1` diagnostics at or above `--max-severity` ·
`2` usage error · `3` I/O error · `4` security refusal.

`mdv fmt` canonicalises: attribute key order (a fixed canonical order, then
alphabetical), 2-space indentation, pipe-table column alignment padding, a
delimiter row inserted in `table` data, quoting only where required, and a
trailing newline. It MUST be idempotent and MUST NOT change the resolved AST —
enforced by a property test over the fixture corpus.

---

# Part III — PDF export

# 28. PDF export

## 28.1 Approach

Two strategies exist. This spec mandates the first and permits the second.

| | **Direct** (normative) | **Browser print** (optional) |
|---|---|---|
| How | Scene graph → PDF operators via `pdf-lib` + `fontkit` | Headless Chromium, `Page.printToPDF` |
| Determinism | Byte-identical across machines | Varies with browser build |
| Dependencies | None beyond npm | A ~150 MB browser |
| Runs in-browser | Yes | No |
| Text | Real, embedded, subsetted | Real |
| Tagged PDF / PDF-UA | Full control | Limited |
| Fidelity to screen | Exact — same layout engine | Exact — same CSS |

The direct exporter is the reference: the same `Scene` that draws the screen
emits the PDF, so a chart cannot look different in the export. The browser
profile exists for documents that lean on raw HTML/CSS features
(`mdv export --engine browser`) and is explicitly non-deterministic.

## 28.2 Page model

```yaml
pdf:
  pageSize: A4                 # A0–A6, Letter, Legal, Tabloid, or [w, h] with units
  orientation: portrait
  margin: {top: 24mm, right: 18mm, bottom: 22mm, left: 18mm}
  header: {left: "{title}", right: "{date}"}
  footer: {center: "{page} / {pages}"}
  headerOnFirstPage: false
  numbering: {start: 1, style: decimal, restartAt: h1}
  toc: {depth: 3, title: Contents, pageBreakAfter: true}
  bookmarks: true
  links: true
  embedSource: true            # attach the .mdv (§28.9)
  compress: true
  profile: pdf-1.7             # or pdf-a-3b, pdf-ua-1
```

Units: `mm`, `cm`, `in`, `pt`, `px` (1 px = 0.75 pt at 96 dpi). Interpolations
available to header/footer: `{title} {subtitle} {author} {date} {page} {pages}
{section} {chapter}`.

## 28.3 Flow and pagination

The exporter runs the same stages 1–6, then a **paginator** that flows blocks
into the text column:

1. Text blocks flow with widow/orphan control (≥ 2 lines kept together;
   configurable `widows`/`orphans`, default 2).
2. **A visual block is atomic.** It is never split across pages. If it does not
   fit in the remaining space it moves to the next page; if it does not fit on a
   whole page it is scaled down to fit, to a floor of 60 %, below which it is
   rotated to landscape on its own page.
3. A heading is never the last thing on a page (`break-after: avoid`), and a
   block's `title`/`caption` stays with it.
4. Tables split at row boundaries, repeating the header row on each page with
   "(continued)" appended to the caption, and never leaving a single row alone.
5. Footnotes render at the foot of the page carrying their reference; if a note
   cannot fit, it moves with its reference.
6. `:::mdv-tabs` renders every tab sequentially, each titled.
   `:::mdv-details` renders expanded. Collapsed table views
   ([§12.3](#123-the-table-view)) render only when `pdf.expandTables: true`
   (default false) — the description and the chart carry the content otherwise.
7. Content wrapped in `:::mdv-page{break=avoid}` ([§28.4](#284-pagination-control))
   is kept on one page, tables included. It is a request, not a guarantee:
   content taller than a page is split and reported as `MDV5121` (warning),
   because dropping it or letting it run off the paper would be worse.

## 28.4 Pagination control

`mdv-page` is an ordinary block directive ([§9.1](#91-block-directives)) and
follows the same grammar as every other one: three colons, the `mdv-` prefix, an
attribute block, and a closing `:::`. There is no separate page-break keyword and
no leaf form — a page break is a `:::mdv-page` whose attributes say where to
break.

It carries no content of its own, so the usual shape is an empty container, the
**marker** form:

````markdown
:::mdv-page{break=before}
:::

## Appendix — data
````

Written with content inside, the attributes apply to that content — the
**wrapping** form, which is the only way to say "keep all of this together":

````markdown
:::mdv-page{break=avoid}
### Pricing
| Plan | Price |
|---|---|
| Team | $19 |
:::
````

| Attribute | Values | Effect |
|---|---|---|
| `break` | `before` \| `after` \| `avoid` | `before` and `after` force a page break at the marker, or around the wrapped content. `avoid` keeps the wrapped content on one page (rule 7) and does nothing in the marker form, because there is nothing to keep. |
| `orientation` | `portrait` \| `landscape` | Page geometry from here on. Defaults to `pdf.orientation`. |
| `size` | any `pdf.pageSize` value | Page geometry from here on. Defaults to `pdf.pageSize`. |

- A geometry change opens a new page whether or not `break` is present: a page
  has one size and one orientation.
- Geometry **persists** until the next `:::mdv-page` that changes it. It is not
  scoped to the wrapped content, even in the wrapping form.
- A break at the very start or the very end of a document produces no blank page.
- Unknown attribute values are ignored rather than an error, per
  [§15.2](#152-forbidden-behavior) — an unrecognised `break` leaves the flow
  untouched.

Equivalent per-block attributes for a single visual block:
`pdf: {break: before, scale: 0.8}`, where `pdf: {break: avoid}` means "do not
break after this block".

**On screen** the directive draws nothing. `@mdv/react` emits a semantic marker
— an empty `<div class="mdv-page-break">` carrying `data-mdv-break` and, when
present, `data-mdv-orientation` and `data-mdv-size`; the wrapping form renders
its children inside that element. The stylesheet gives it no visuals, so an
embedded document is not littered with rules an embedder never asked for, but it
is addressable, and under `@media print` it maps to the CSS fragmentation
properties (`break-before: page`, `break-inside: avoid`) so that printing the
HTML agrees with exporting the PDF. **Editors SHOULD show it**, since an
invisible block is an uneditable one: the MDV editor draws a labelled page rule.

## 28.5 Charts in PDF

- Charts are emitted as **vector content**, never rasterised, so they stay sharp
  at any zoom and print. Raster appears only for `image` nodes.
- Interactive affordances are dropped; everything a tooltip would have shown is
  present via direct labels or the table view — which is exactly what
  [§7.5](#75-tooltips-and-interaction) guarantees.
- The layout re-runs at the print width, so labels are re-fitted rather than
  scaled — a chart in a narrow column has fewer ticks, not smaller type.
- `theme: print` is applied by default: white surface, ink text, hairlines
  thickened to 0.5 pt minimum (thinner strokes disappear on some printers), and
  the texture channel enabled when `pdf.grayscale: true`.
- Minimum rendered type size is 7 pt; below that the layout drops labels rather
  than shrinking them.

## 28.6 Fonts

- Fonts are **embedded and subsetted**. The default family bundles as WOFF2 →
  converted to CFF for embedding.
- The default stack ships with Latin, Greek, and Cyrillic; CJK requires
  `pdf.fonts: [{family, src, subset}]` because a full CJK face is 5–20 MB.
- Missing glyphs are reported once as `MDV5100` (warning) with the codepoints, and
  render as `.notdef` — never silently dropped.
- Bidi and complex-script shaping: the exporter applies the Unicode Bidirectional
  Algorithm and, at Level 3, HarfBuzz shaping. Level 2 exporters MUST declare
  shaping unsupported for scripts requiring it, rather than misrendering.

## 28.7 Notes and cross-references

Headings become bookmarks (outline) at their nesting depth. `:mdv-ref[]` resolves
to a numbered label and an internal link. Figures and tables are numbered per
`numbering.restartAt`. Internal links become PDF `/Link` annotations; external
links are preserved with their URLs shown in a link appendix when
`pdf.linkAppendix: true`.

## 28.8 Tagged PDF and accessibility

When `profile: pdf-ua-1` (RECOMMENDED for any published document):

- A full structure tree: `/Document`, `/H1`–`/H6`, `/P`, `/L`/`/LI`, `/Table`
  with `/TH` scope and `/TD`, `/Figure`, `/Caption`.
- Every chart is a `/Figure` with `/Alt` set to the accessible description
  ([§12.2](#122-descriptions)) and, when `pdf.expandTables` is on, an adjacent
  tagged `/Table` carrying the data.
- `/Lang` from the document, marked content for artifacts (headers, footers,
  gridlines, decorative rules), a logical reading order that matches the visual
  order, and `/ViewerPreferences /DisplayDocTitle true`.
- The exporter MUST fail the export with `MDV5110` if a required `/Alt` is
  missing under this profile — an untagged chart in a PDF/UA document is a
  silent accessibility failure otherwise.

## 28.9 Metadata and provenance

- Document info and XMP: title, author, subject, keywords, creator
  (`MDV <version>`), producer, creation date (= `buildTime`, so exports are
  reproducible).
- `embedSource: true` attaches the original `.mdv` as an embedded file
  (`/EmbeddedFiles`, MIME `text/vnd.mdv`, relationship `/Source`). The PDF then
  carries its own source: a reader can extract, edit, and re-export. With
  `profile: pdf-a-3b` this is standards-conformant archival.
- The XMP packet records spec version, reader version, theme id, locale, and the
  ICU version if `Intl` was used ([§6.9.3](#693-determinism-caveat)) — everything
  needed to reproduce the bytes.

## 28.10 Determinism and testing

Byte-identical output requires pinning: `buildTime` (creation/mod dates), the
document `/ID` (derived from a hash of content + buildTime, never random), font
subset ordering (glyphs in codepoint order), object numbering (allocation in a
fixed traversal order), and no compression nondeterminism (fixed zlib level, or
`compress: false` for tests).

Tests compare an **operator trace** (`expected.pdf.json`: a normalised list of
page content-stream operations, resource names, and the structure tree) rather
than raw bytes, so a `pdf-lib` version bump does not fail every fixture, while a
real geometry change does. One byte-equality test per release guards the pinning
rules themselves.

## 28.11 Other export targets

| Target | Notes |
|---|---|
| `html` | Single self-contained file: inlined CSS, fonts as data URLs, no scripts unless `--interactive`. |
| `svg` | One file per block, or one per page with `--paginate`. |
| `png` | Rasterised at `--scale` (default 2) via the Canvas backend. |
| `md` | Degraded Markdown with charts replaced by pre-rendered images ([§5.6](#56-degradation)). |
| `json` | The resolved AST plus scene graphs, for downstream tooling. |
| `csv` | A block's resolved table (`--block`). |

---

# Part IV — VS Code extension

# 29. VS Code extension

## 29.1 Overview

The extension makes `.mdv` a first-class language: highlighting, a live preview,
diagnostics as you type, completion that knows your data's column names, and
export commands. It is a thin client over `@mdv/lsp` and `@mdv/react`, so the
editor and the web app never disagree about what a document means.

**Requirements:** VS Code ≥ 1.90; the extension activates on `onLanguage:mdv`,
`onLanguage:markdown` (for `.md` files containing `mdv` fences), and its own
commands. It works in `vscode.dev` (browser host) with the Node-only parts
(`fs`, PDF) gated behind a capability check.

## 29.2 Contributions

```jsonc
{
  "contributes": {
    "languages": [{
      "id": "mdv",
      "extensions": [".mdv"],
      "aliases": ["Markdown Visual", "mdv"],
      "configuration": "./language-configuration.json",
      "icon": { "light": "./icons/mdv-light.svg", "dark": "./icons/mdv-dark.svg" }
    }],
    "grammars": [
      { "language": "mdv", "scopeName": "text.html.markdown.mdv",
        "path": "./syntaxes/mdv.tmLanguage.json" },
      { "scopeName": "markdown.mdv.codeblock",
        "path": "./syntaxes/mdv-injection.json",
        "injectTo": ["text.html.markdown"],
        "embeddedLanguages": { "meta.embedded.block.mdv": "mdv-block" } }
    ],
    "markdown.markdownItPlugins": true,
    "snippets": [{ "language": "mdv", "path": "./snippets/mdv.json" }],
    "commands": [...], "keybindings": [...], "configuration": {...},
    "customEditors": [{
      "viewType": "mdv.reader",
      "displayName": "MDV Reader",
      "selector": [{ "filenamePattern": "*.mdv" }],
      "priority": "option"
    }]
  }
}
```

The `markdown.markdownItPlugins` contribution makes MDV blocks render inside
VS Code's **built-in** Markdown preview too, so `.md` files with charts work
without opening the custom preview.

## 29.3 Preview

A webview panel, opened beside the editor.

- **Rendering** is `@mdv/react` in the webview, using the same packages as the
  web app. Updates arrive as incremental patches over `postMessage`, debounced to
  150 ms, re-running only the pipeline stages whose inputs changed.
- **Theme** follows the editor: `vscode-*` CSS variables map onto MDV tokens, and
  the light/dark/high-contrast kinds map to `default`/`dark`/`high-contrast`.
- **Scroll sync**, bidirectional, on by default: the editor's top visible line
  maps to a source-position → block index table maintained by the parser, and
  clicking a chart in the preview reveals its source (and vice versa, with a
  brief highlight).
- **CSP** is strict: `default-src 'none'; img-src ${webview.cspSource} data:;
  style-src ${webview.cspSource} 'nonce-…'; script-src 'nonce-…'`. No inline
  handlers, no `eval` — which the reader already satisfies
  ([§13.5](#135-content-security-policy)). `localResourceRoots` is limited to the
  extension bundle and the document's own folder.
- **External data** is off unless the workspace opts in via
  `mdv.security.allowExternal`, and the preview shows a dismissible banner naming
  the origins a document wants, with an "Allow for this workspace" action —
  never an automatic grant.
- **State** (scroll position, expanded tables, active tab) survives panel
  serialisation via `setState`/`getState` and a `WebviewPanelSerializer`.

## 29.4 Language server

`@mdv/lsp`, over stdio in the desktop host and a web worker in the browser host.

| Capability | Behaviour |
|---|---|
| **Diagnostics** | Full pipeline validation on change (debounced 300 ms), on save, and on open. Ranges from [§14.4](#144-ranges). |
| **Completion** | Block types after `` ```mdv ``; attribute keys valid for the current type; enum values; **column names read from the block's own data section or referenced dataset**; `@dataset` ids; theme tokens; format-string presets. Snippets carry documentation and an example. |
| **Hover** | Attribute documentation with type, default, and a one-line example; on a column name, its inferred type and value range; on a dataset ref, its shape and row count. |
| **Signature help** | Inside `transform:` and MDVX expressions: parameters of the current step or function. |
| **Code actions** | "Add a description for accessibility"; "Convert table to chart"; "Extract to dataset"; "Add missing separator"; "Declare field types"; "Set `zero: true` on a truncated bar axis"; "Fix palette contrast". All machine-applicable, sourced from `Diagnostic.fixes`. |
| **Formatting** | Document and range formatting via `mdv fmt` ([§27](#27-cli)); `formatOnSave` supported. |
| **Document symbols** | Headings, plus one symbol per visual block (`title` or `type` + index), so the outline and breadcrumbs show charts. |
| **Folding** | Front matter, sections, each visual block, and its data section independently. |
| **Definition / references** | On `@dataset` → its declaration; find-references over a dataset id. |
| **Rename** | Dataset ids and, within a block, column names (renaming a header updates every attribute that references it). |
| **Inlay hints** | Inferred field types beside data headers; the resolved row count after transforms. |
| **CodeLens** | Above each block: `Preview` · `Export PNG` · `Export SVG` · `Show data`. |
| **Semantic tokens** | Attribute keys, values, references, and column names inside blocks, so highlighting is data-aware and not just regex-deep. |

The server is a thin adapter: it must contain no MDV semantics of its own, only
translation between LSP types and `@mdv/core` types. Anything it knows, the CLI
and the web app know too.

## 29.5 Commands

| Command | Id | Default binding |
|---|---|---|
| Open Preview | `mdv.showPreview` | <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> |
| Open Preview to the Side | `mdv.showPreviewToSide` | <kbd>Ctrl/Cmd</kbd>+<kbd>K</kbd> <kbd>V</kbd> |
| Export to PDF | `mdv.export.pdf` | |
| Export to HTML / SVG / PNG | `mdv.export.*` | |
| Export Block as Image | `mdv.exportBlock` | context menu |
| Insert Chart… | `mdv.insertChart` | quick-pick of types with a live preview |
| Convert Table to Chart | `mdv.tableToChart` | context menu on a GFM table |
| Paste as Dataset | `mdv.pasteData` | pastes CSV/TSV from the clipboard as a dataset block |
| Show Resolved Data | `mdv.showData` | opens the block's table in a virtual document |
| Validate Theme | `mdv.validateTheme` | runs the palette validator, output channel |
| Toggle Dark Preview | `mdv.togglePreviewTheme` | |

Export commands report progress with `withProgress`, are cancellable, and write
beside the source file unless a path is chosen.

## 29.6 Settings

```jsonc
"mdv.preview.theme": "auto",             // auto | light | dark | high-contrast
"mdv.preview.scrollSync": true,
"mdv.preview.debounceMs": 150,
"mdv.preview.openOnStartup": false,
"mdv.validate.enable": true,
"mdv.validate.level": 2,
"mdv.validate.strict": false,
"mdv.format.enable": true,
"mdv.format.attributeOrder": "canonical", // canonical | alphabetical | preserve
"mdv.security.allowExternal": false,
"mdv.security.allowedOrigins": [],
"mdv.export.pdf.pageSize": "A4",
"mdv.export.defaultDirectory": "",
"mdv.completion.columnNames": true,
"mdv.codeLens.enable": true,
"mdv.trace.server": "off"
```

`mdv.security.*` is `machine-overridable` and MUST NOT be settable from a
workspace `.vscode/settings.json` without the workspace-trust prompt — a
repository must not be able to turn on network access for its own documents.

## 29.7 Syntax highlighting

The TextMate grammar injects into fenced blocks whose info string starts with
`mdv`, and highlights the header as MDV attribute notation (keys, values,
references, comments) and the data section by its detected format — pipe tables
get column-aware scopes, JSON gets JSON scopes. The separator gets its own scope
so it is visually obvious when it is missing.

Semantic tokens from the LSP then refine what the grammar can only guess at:
which identifiers are real column names, which references resolve.

## 29.8 Packaging and quality bars

- Bundled with esbuild into one `extension.js` plus one `webview.js`; target
  ≤ 2 MB VSIX excluding fonts.
- `browser` entry point for `vscode.dev`, with PDF export and filesystem features
  gated behind `vscode.env.uiKind` checks and hidden from the command palette via
  `when` clauses rather than failing at invocation.
- Activation must not block: heavy work happens after `activate` resolves; target
  ≤ 50 ms activation.
- Tests: unit tests for the LSP over the spec fixture corpus, integration tests
  with `@vscode/test-electron`, and a webview smoke test that renders every
  fixture and asserts no console errors.
- Telemetry: none.

---

# Part V — Appendices

# Appendix A — Grammar

ABNF per [RFC 5234]. Core rules (`ALPHA`, `DIGIT`, `WSP`, `DQUOTE`, `CRLF`) are
imported. `LINE` is any sequence of characters excluding CR and LF.

```abnf
; ── document ───────────────────────────────────────────────
document      = [ front-matter ] *( block )
front-matter  = "---" LF *( LINE LF ) ( "---" / "..." ) LF
block         = visual-block / directive-block / markdown-block

; ── visual block ───────────────────────────────────────────
visual-block  = fence-open LF [ header ] [ separator data ] fence-close
fence-open    = 3*"`" info-string / 3*"~" info-string
fence-close   = 3*"`" / 3*"~"
info-string   = "mdv" [ 1*WSP block-type ] *( 1*WSP inline-attr )
block-type    = ALPHA *( ALPHA / DIGIT / "-" )
inline-attr   = attr-key "=" ( bare-value / quoted-value )
separator     = "---" *WSP LF

; ── header (MDV attribute notation) ────────────────────────
header        = *( attr-line / comment-line / blank-line )
attr-line     = indent attr-key ":" [ 1*WSP attr-value ] LF
              / indent "-" 1*WSP ( attr-value / attr-key ":" 1*WSP attr-value ) LF
indent        = *( 2SP )                      ; exactly two spaces per level
attr-key      = ALPHA *( ALPHA / DIGIT / "-" / "_" )
attr-value    = flow-seq / flow-map / quoted-value / block-scalar / plain-value
flow-seq      = "[" [ attr-value *( "," [WSP] attr-value ) ] "]"
flow-map      = "{" [ pair *( "," [WSP] pair ) ] "}"
pair          = attr-key ":" [WSP] attr-value
block-scalar  = ( "|" / ">" ) LF 1*( indent 1*SP LINE LF )
quoted-value  = DQUOTE *qchar DQUOTE / "'" *sqchar "'"
plain-value   = 1*( %x20-23 / %x25-10FFFF )   ; no "#" after WSP; trimmed
comment-line  = *WSP "#" LINE LF

; ── data ───────────────────────────────────────────────────
data          = table-data / csv-data / json-data / ndjson-data / columns-data
table-data    = table-row [ delim-row ] *table-row
table-row     = [ "|" ] cell *( "|" cell ) [ "|" ] LF
cell          = *( %x20-7B / %x7D-10FFFF / "\|" )     ; trimmed
delim-row     = [ "|" ] delim *( "|" delim ) [ "|" ] LF
delim         = *WSP [ ":" ] 1*"-" [ ":" ] *WSP

; ── directives ─────────────────────────────────────────────
directive-block  = ":::" name [ attr-block ] LF *block ":::" LF
directive-leaf   = "::"  name [ "[" label "]" ] [ attr-block ] LF
directive-inline = ":"   name [ "[" label "]" ] [ attr-block ]
attr-block       = "{" *( WSP ) *( d-attr *( 1*WSP d-attr ) ) "}"
d-attr           = ( "#" ident ) / ( "." ident ) / ( attr-key "=" ( bare-value / quoted-value ) )
name             = "mdv-" ALPHA *( ALPHA / DIGIT / "-" )

; ── MDVX expressions: see §6.8.1 ───────────────────────────
```

---

# Appendix B — Attribute index

Type key: `f` field · `f[]` field or field list · `n` number · `s` string ·
`b` boolean · `e` enum · `d` dimension · `c` color · `o` object · `l` list.

| Attribute | Type | Applies to | Default | § |
|---|---|---|---|---|
| `animate` | b | all | `true` | 8.1 |
| `annotations` | l | cartesian | — | 8.14 |
| `aspect` | n | all | — | 8.1 |
| `axis` | o | cartesian | — | 7.3 |
| `band` | o | area | — | 8.4 |
| `barWidth` | n\|`auto` | bar, histogram | `auto` | 8.2 |
| `baseline` | n\|f | bar, area | `0` | 8.2, 8.4 |
| `bins` | n\|`auto` | histogram, heatmap | `auto` | 8.7, 8.9 |
| `break` | e | `:::mdv-page` | — | 28.4 |
| `caption` | s | all | — | 8.1 |
| `category` | f | pie, funnel, treemap, radar | *req* | 8.5 |
| `cellLabel` | b\|fmt | heatmap | `auto` | 8.9 |
| `cellGap` / `cellRadius` | n | heatmap | `2` / `2` | 8.9 |
| `class` | s | all | — | 8.1 |
| `color` | f\|c\|l | most | palette | 7.1 |
| `colorScale` | e | heatmap, map | `sequential` | 8.9 |
| `columns` | o\|n | table, facet | — | 10.1, 7.6 |
| `corner` | n | bar | `4` | 8.2 |
| `curve` | e | line, area, sparkline | `linear` | 8.3 |
| `data` | ref | all | — | 6.3 |
| `desc` | s | all | *generated* | 12.2 |
| `domain` | l | scales | data extent | 7.2 |
| `fields` | o | all | inferred | 6.1.1 |
| `fillOpacity` | n | area | `0.10` | 8.4 |
| `format` | e | all | `auto` | 6.2 |
| `gaps` | e | ohlc | `collapse` | 8.10 |
| `group` | f\|l | several | — | 7.1 |
| `height` / `width` | d | all | `300` / `100%` | 8.1 |
| `hollow` | b | ohlc | `false` | 8.10 |
| `id` | s | all | — | 8.1 |
| `innerRadius` | n | pie, donut | `0`/`0.6` | 8.5 |
| `label` | f\|b\|e | most | varies | 7.1 |
| `legend` | e\|o | all | `auto` | 7.4 |
| `nullPolicy` | e | line, area | `gap` | 6.5 |
| `nullValues` | l | all | see 6.5 | 6.5 |
| `open`/`high`/`low`/`close` | f | ohlc | auto-detected | 8.10 |
| `orientation` | e | bar, funnel; `:::mdv-page` | `vertical`; `pdf.orientation` | 8.2, 28.4 |
| `other` | n\|`false` | pie | `0.02` | 8.5 |
| `overlay` | l | ohlc | — | 8.11.1 |
| `padding` | d\|o | all | `8` | 8.1 |
| `palette` | l\|s | all | theme | 11.2 |
| `panels` | l | ohlcv | — | 8.11.2 |
| `pdf` | o | all | — | 28.4 |
| `points` | e | line, box | `none` | 8.3 |
| `row` / `column` | f | cartesian | — | 7.6 |
| `scale` | o | channels | by type | 7.2 |
| `scheme` | s\|l | heatmap, map | theme | 8.9 |
| `series` | f | most | — | 7.1 |
| `shape` | f\|s | scatter | `circle` | 8.6 |
| `shareX` / `shareY` | b | facets | `true` | 7.6 |
| `size` | f\|n\|s | scatter, bubble; `:::mdv-page` | `8`; `pdf.pageSize` | 8.6, 28.4 |
| `sort` | e\|f\|l | many | varies | 8.2 |
| `src` | s | all | — | 6.4 |
| `stack` | e | bar, area | varies | 8.2, 8.4 |
| `strokeWidth` | n | line | `2` | 8.3 |
| `style` | e | ohlc | `candle` | 8.10 |
| `syncX` | s | cartesian | — | 8.3 |
| `table` | e | all | `details` | 12.3 |
| `theme` | s\|o | all | inherited | 11.6 |
| `title` / `subtitle` | s | all | — | 8.1 |
| `tooltip` | b\|l | all | `true` | 7.5 |
| `transform` | l | all | — | 6.7 |
| `trend` | e | scatter | `none` | 8.6 |
| `type` | s | all | info string | 5.2 |
| `upColor` / `downColor` | c | ohlc | status palette | 8.10 |
| `value` | f | pie, heatmap, gauge, … | *req* | 7.1 |
| `volume` | f | ohlcv | *req* | 8.11 |
| `whisker` | e | box | `tukey` | 8.8 |
| `x` / `y` | f / f[] | cartesian | *req* | 7.1 |
| `x-*` | any | all | — | 15.1 |

---

# Appendix C — Error codes

| Code | Sev | Meaning |
|---|---|---|
| **MDV1xxx — syntax** | | |
| MDV1100 | info | No `mdv:` version declared; assuming the reader's version |
| MDV1200 | error | Malformed info string |
| MDV1201 | error | No block type in the info string or the header |
| MDV1202 | warning | Empty visual block |
| MDV1203 | error | Data section present but no `---` separator ([§5.1](#51-syntax-overview)) |
| MDV1204 | error | Both a data section and an out-of-band source (`data:`/`src:`) |
| MDV1205 | error | Unterminated fence |
| MDV1210 | error | Tab used for indentation in a header |
| MDV1211 | error | Unsupported YAML construct in a header |
| MDV1212 | error | Inconsistent header indentation (not a multiple of 2) |
| MDV1220 | error | Value does not match the attribute's declared type |
| MDV1221 | error | Malformed dimension or color value |
| MDV1300 | error | Malformed front matter |
| MDV1500 | warning | Unknown block type — rendered as a table |
| MDV1501 | info | Unknown attribute — ignored |
| MDV1502 | warning | Unknown enum value — default used |
| MDV1503 | info | Unknown directive — children rendered as content |
| MDV1510 | warning | Document targets a newer major spec version |
| MDV1511 | info | Document targets a newer minor spec version |
| MDV1520 | info | Plugin overrides a built-in definition |
| MDV1530 | warning | Deprecated attribute or spelling |
| **MDV2xxx — data** | | |
| MDV2100 | warning | Empty data section |
| MDV2101 | info | Data format auto-detected; declare `format:` if this is wrong |
| MDV2102 | error | Data does not parse as the declared format |
| MDV2110 | warning | Duplicate field name — suffixed |
| MDV2111 | error | Referenced field does not exist |
| MDV2120 | warning | Row has fewer cells than the header — padded |
| MDV2121 | warning | Row has more cells than the header — truncated |
| MDV2130 | error | `columns` sequences have unequal length |
| MDV2140 | warning | Duplicate dataset id — later definition wins |
| MDV2141 | error | Cycle in the dataset dependency graph |
| MDV2142 | error | Unresolved dataset reference |
| MDV2150 | error | Unsupported directive in a `parse:` format string |
| MDV2151 | warning | Value did not parse as its declared type — treated as null |
| MDV2200 | error | Malformed MDVX expression |
| MDV2210 | warning | Type error in an expression — result is null |
| MDV2220 | error | Unknown function in an expression |
| MDV2500 | error | Unknown transform step |
| MDV2501 | error | Malformed transform parameters |
| MDV2502 | warning | Aggregate over a non-numeric field |
| **MDV3xxx — encoding** | | |
| MDV3000 | error | Required channel missing |
| MDV3001 | error | Channel bound to an incompatible field type |
| MDV3010 | error | `series` and a list-valued `y` are mutually exclusive |
| MDV3020 | warning | Non-positive values dropped from a log scale |
| MDV3021 | warning | Bar/area axis does not include zero — magnitudes are misstated |
| MDV3030 | info | Facets do not share a scale — panels are not comparable |
| MDV3040 | warning | More than two overlapping unstacked areas |
| MDV3050 | info | Pie has more than 6 slices — consider a bar chart |
| MDV3060 | info | A trend line is an assertion about the data |
| MDV3061 | warning | Scatter/bubble exceeds the all-pairs series cap of 3 |
| MDV3062 | warning | More series than palette slots — folded into "Other" |
| MDV3070 | error | Cycle in a sankey graph |
| MDV3080 | warning | Custom palette failed validation ([§16.4](#164-palette-validation)) |
| MDV3081 | warning | Series color below 3:1 contrast — labels or table view required |
| MDV3090 | info | `table: none` — data is not otherwise reachable |
| MDV3091 | warning | No accessible description and none could be generated |
| **MDV4xxx — security & limits** | | |
| MDV4000 | error | Document exceeds the size limit |
| MDV4001 | error | `src:` encountered in a synchronous resolve |
| MDV4002 | error | External data is disabled |
| MDV4003 | error | Origin not in the allowlist |
| MDV4010 | warning | Unsafe URL scheme stripped |
| MDV4011 | warning | Raw HTML escaped (HTML disabled) |
| MDV4020 | error | Path traversal outside the document root |
| MDV4021 | error | Subresource integrity mismatch |
| MDV4022 | error | Request blocked: private, loopback, or metadata address |
| MDV4023 | error | Fetch failed or timed out |
| MDV4030 | error | Expression exceeds a length, depth, or call limit |
| MDV4031 | error | Row, mark, block, or field limit exceeded |
| MDV4032 | error | Render time limit exceeded |
| **MDV5xxx — render & export** | | |
| MDV5000 | error | Block failed to render |
| MDV5001 | warning | Container has zero width or height |
| MDV5010 | info | Series downsampled for display; values are unchanged |
| MDV5011 | info | Labels omitted to avoid collision — see the table view |
| MDV5100 | warning | Missing glyphs for the embedded font |
| MDV5101 | warning | Complex-script shaping unsupported at this level |
| MDV5110 | error | PDF/UA export requires an accessible description |
| MDV5120 | warning | Chart scaled below 60 % to fit the page — rotated to landscape |
| MDV5121 | warning | `break=avoid` content is taller than one page and was split |

---

# Appendix D — JSON Schema (excerpt)

Schemas live in `packages/spec/schemas/`, one per block type plus shared
definitions, and are the single source of truth for validation, LSP completion,
and the attribute documentation in this appendix. Excerpt:

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://mdv.dev/schema/1.0/block/bar.json",
  "title": "MDV bar block",
  "type": "object",
  "allOf": [{ "$ref": "../common/block.json" }],
  "properties": {
    "x":     { "$ref": "../common/channel.json", "description": "Category or time bucket" },
    "y":     { "oneOf": [ { "$ref": "../common/channel.json" },
                          { "type": "array", "items": { "$ref": "../common/channel.json" } } ] },
    "series":{ "$ref": "../common/channel.json" },
    "stack": { "enum": ["none", "normal", "percent", "center"], "default": "none" },
    "orientation": { "enum": ["vertical", "horizontal"], "default": "vertical" },
    "barWidth": { "oneOf": [ { "type": "number", "exclusiveMinimum": 0, "maximum": 24 },
                             { "const": "auto" } ], "default": "auto" },
    "corner": { "type": "number", "minimum": 0, "default": 4 },
    "sort":   { "oneOf": [ { "enum": ["none", "asc", "desc"] }, { "type": "string" } ],
                "default": "none" }
  },
  "required": ["x", "y"],
  "not": { "required": ["series"], "properties": { "y": { "type": "array" } } },
  "patternProperties": { "^x-": true },
  "unevaluatedProperties": false
}
```

`"not"` encodes the [§7.1](#71-channels) rule that `series` and a list `y` are
mutually exclusive, so `MDV3010` comes out of schema validation rather than
hand-written code.

---

# Appendix E — Worked example

````markdown
---
mdv: "1.0"
title: FY2026 Business Review
author: Analytics
date: 2026-08-10
theme: default
pdf:
  pageSize: A4
  footer: {center: "{page} / {pages}"}
  profile: pdf-ua-1
  embedSource: true
defaults:
  height: 300
---

# FY2026 Business Review

Revenue reached :mdv-value[@quarterly.revenue.sum]{format="$,.0f"} for the year,
up :mdv-delta[0.184]{good=up} against FY2025.

```mdv dataset id=quarterly
fields:
  quarter: {type: category}
---
quarter | revenue | profit | region
Q1      |    1240 |    310 | APAC
Q2      |    1516 |    402 | APAC
Q3      |    1402 |    366 | APAC
Q4      |    1893 |    551 | APAC
```

:::mdv-grid{cols=3 gap=16}

```mdv metric
label: Annual revenue
value: 6051000
format: "$~s"
delta: 0.184
deltaOf: vs. FY2025
goodDirection: up
```

```mdv metric
label: Gross margin
value: 0.271
format: ".1%"
delta: 0.012
goodDirection: up
```

```mdv metric
label: Customers
value: 4821
delta: -0.03
goodDirection: up
```

:::

## Revenue and profit

```mdv bar
id: fig-revenue
title: Revenue and profit by quarter
desc: >
  Grouped bars. Revenue rises from 1,240 in Q1 to 1,893 in Q4;
  profit rises from 310 to 551. The largest step is Q3 to Q4.
data: "@quarterly"
x: quarter
y: [revenue, profit]
label: true
axis:
  y: {title: USD (thousands), format: ",.0f"}
```

See :mdv-ref[fig-revenue] for the quarterly detail.

## Price action

```mdv ohlcv
title: ACME — daily, with volume
x: date
volume: volume
style: candle
gaps: collapse
volumeHeight: 0.22
overlay:
  - {type: sma, period: 3}
panels:
  - {type: rsi, period: 14, height: 0.15, bands: [30, 70]}
---
date       |  open |  high |   low | close |  volume
2026-08-03 | 41.20 | 42.05 | 40.90 | 41.85 | 1204000
2026-08-04 | 41.90 | 42.40 | 41.10 | 41.30 |  980000
2026-08-05 | 41.35 | 41.60 | 39.80 | 40.05 | 1810000
2026-08-06 | 40.10 | 41.75 | 40.00 | 41.60 | 1442000
2026-08-07 | 41.55 | 43.20 | 41.40 | 43.05 | 2110000
```

## Support load

```mdv heatmap
title: Tickets by weekday and hour
x: hour
y: weekday
value: tickets
scheme: blue
sort: {y: [Mon, Tue, Wed, Thu, Fri]}
format: matrix
---
      |  9 | 10 | 11 | 12
Mon   | 12 | 31 | 28 |  9
Tue   |  8 | 44 | 39 | 12
Wed   | 15 | 38 | 41 | 14
Thu   | 11 | 29 | 33 | 10
Fri   |  6 | 18 | 21 |  7
```

:::mdv-callout{type=note title="Method"}
Ticket counts exclude automated alerts. See the appendix dataset for the raw
extract.
:::

:::mdv-page{break=before}
:::

## Appendix — data

```mdv table
data: "@quarterly"
columns:
  quarter: {label: Quarter}
  revenue: {label: Revenue, format: "$,.0f", align: right, heat: sequential}
  profit:  {label: Profit,  format: "$,.0f", align: right}
total: {revenue: sum, profit: sum}
```
````

---

# Appendix F — Repository layout & milestones

## F.1 Layout

```
mdv/
├── SPEC.md                      ← this document
├── package.json                 ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── spec/                    schemas/ · tests/ · errors.json
│   ├── parser/
│   ├── core/                    data/ · transform/ · expr/ · scale/ · encode/ · layout/ · a11y/
│   ├── charts/                  one module per type, lazily registered
│   ├── render-svg/
│   ├── render-canvas/
│   ├── render-pdf/
│   ├── react/
│   ├── themes/                  themes + validate-palette
│   ├── cli/
│   └── lsp/
├── apps/
│   ├── docs/                    the spec + a live playground (also the demo)
│   └── vscode/                  the extension
└── .github/workflows/           test · perf · golden · package
```

Toolchain: pnpm workspaces, TypeScript 5.x `strict` with `exactOptionalPropertyTypes`
and `noUncheckedIndexedAccess`, Vitest, Playwright for visual tests, esbuild for
bundles, `tsc` for types, Changesets for releases, ESLint + Prettier.

## F.2 Milestones

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| **M0** | Spec freeze | This document; JSON Schemas; the fixture corpus skeleton | Schemas validate every example in this document |
| **M1** | Parser | `@mdv/parser`, position accuracy, round-trip serialisation | `syntax/` fixtures pass; round-trip property test green |
| **M2** | Core data | Formats, inference, nulls, datasets, transforms, MDVX | `data/` fixtures pass; MDVX fuzzed for limits and injection |
| **M3** | Level 1 render | Scales, axes, legends, layout, scene graph, SVG backend; `bar line area pie donut scatter table metric` | `render/` L1 goldens byte-stable in light and dark |
| **M4** | React + a11y | `@mdv/react`, SSR, virtualisation, keyboard layer, table view, generated descriptions | `a11y/` fixtures pass; axe clean; keyboard walkthrough test |
| **M5** | Level 2 charts | `histogram box heatmap ohlc ohlcv candlestick radar gauge funnel waterfall treemap sankey sparkline`; directives; faceting | L2 goldens; perf budgets met |
| **M6** | PDF | `@mdv/render-pdf`, pagination, fonts, tagging, `embedSource` | Operator-trace fixtures; PDF/UA validation via veraPDF |
| **M7** | CLI + LSP | `@mdv/cli`, `@mdv/lsp`, formatter | `mdv fmt --check` idempotent over the corpus |
| **M8** | VS Code | Preview, grammar, commands, settings, markdown-it plugin | Extension tests green in desktop and web hosts |
| **M9** | 1.0 | Docs site, playground, conformance report | Level 2 conformance claim substantiated by the suite |

Milestones M1–M3 are strictly ordered; M4/M5 and M6/M7 may run in parallel.

## F.3 Definition of done (every milestone)

Fixtures added to `@mdv/spec`; goldens reviewed in a commit containing no source
changes ([§16.3](#163-golden-file-policy)); perf budgets measured; a11y checks
run; public API documented with TSDoc; a changeset written.

---

# Appendix G — Open questions

Tracked for resolution before 1.0 final. Each names the decision that would close
it.

1. **Inline directive degradation.** `:mdv-spark[…]` renders as literal text in
   non-MDV pipelines. Should MDV also define a code-span profile
   (`` `mdv:spark 1,2,3` ``) that degrades to monospace, at the cost of two
   spellings? *Leaning: no — [§1.2](#12-design-principles) principle 7.*
2. **Media type registration.** `text/vnd.mdv` requires an IANA vendor-tree
   filing. Do so before 1.0, or ship with `text/markdown` and a `variant`
   parameter?
3. **`ohlc` field auto-detection** is convenient but implicit, and implicitness
   is against principle 1. Keep it, or require explicit channels and provide a
   quick fix in the LSP instead?
4. **Scatter's three-series cap** is a real constraint that authors will hit.
   Should shape be applied automatically as the secondary encoding beyond three,
   rather than requiring facets? *Leaning: yes, with `MDV3061` downgraded to
   info once shape is applied.*
5. **`include`** (composing documents from fragments) is deferred to Level 3.
   Does it need path confinement rules beyond
   [§13.2](#132-external-data), and does it interact badly with dataset scoping?
6. **Live data** (`src` with a poll interval) — worth defining, or does it belong
   entirely to the embedder, outside the document?
7. **Downsampling defaults.** LTTB preserves extrema but changes which exact
   points are drawn. Should `downsampleThreshold` default to *off* for
   correctness, accepting the performance cost?
8. **Locale determinism.** Bundling a full CLDR subset would make non-`en-US`
   output deterministic too, at a bundle-size cost. Which locales, if any, ship
   in core?

---

## References

- [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/)
- [GitHub Flavored Markdown Spec](https://github.github.com/gfm/)
- [mdast](https://github.com/syntax-tree/mdast) · [micromark](https://github.com/micromark/micromark)
- [Generic directives proposal](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444)
- [RFC 2119] / [RFC 8174] — requirement keywords · [RFC 4180] — CSV · [RFC 5234] — ABNF
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/), notably 1.4.11 Non-text Contrast
- [PDF 2.0 (ISO 32000-2)], [PDF/UA (ISO 14289)], [PDF/A-3 (ISO 19005-3)]
- [Language Server Protocol 3.17](https://microsoft.github.io/language-server-protocol/)

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174
[RFC 4180]: https://www.rfc-editor.org/rfc/rfc4180
[RFC 5234]: https://www.rfc-editor.org/rfc/rfc5234
[mdast]: https://github.com/syntax-tree/mdast
[generic directives]: https://talk.commonmark.org/t/generic-directives-plugins-syntax/444
[PDF 2.0 (ISO 32000-2)]: https://www.iso.org/standard/75839.html
[PDF/UA (ISO 14289)]: https://www.iso.org/standard/64599.html
[PDF/A-3 (ISO 19005-3)]: https://www.iso.org/standard/57229.html





