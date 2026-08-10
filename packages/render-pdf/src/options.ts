/**
 * `pdf:` options (SPEC 28.2), fully defaulted.
 *
 * `@mdv/core`'s `PdfOptions` covers the block SPEC 28.2 prints verbatim but not
 * the knobs the later sections introduce — `widows`/`orphans` (28.3),
 * `expandTables` (28.3), `grayscale` (28.5), `fonts` (28.6), `linkAppendix`
 * (28.7). {@link PdfExportOptions} widens it rather than replacing it, so a
 * caller holding a plain `PdfOptions` still type-checks.
 *
 * *CONTRACT: `packages/core/src/index.ts` `PdfOptions` should gain
 * `widows`, `orphans`, `expandTables`, `grayscale`, `linkAppendix` and `fonts`.*
 */

import type { PdfOptions } from '@mdv/core';
import type { Margins, PageBox } from './units.js';
import { orient, resolveMargins, resolvePageSize } from './units.js';

/** Numbering styles for page numbers (SPEC 28.2). */
export type NumberingStyle = 'decimal' | 'roman' | 'alpha';

/** The full option surface of SPEC 28. */
export interface PdfExportOptions extends PdfOptions {
  /** Minimum lines left at the top of a page. @defaultValue 2 */
  widows?: number;
  /** Minimum lines kept at the bottom of a page. @defaultValue 2 */
  orphans?: number;
  /** Render collapsed table views (SPEC 12.3). @defaultValue false */
  expandTables?: boolean;
  /** Desaturate and enable the texture channel (SPEC 28.5). @defaultValue false */
  grayscale?: boolean;
  /** Append a list of external link targets (SPEC 28.7). @defaultValue false */
  linkAppendix?: boolean;
  /** Document title for the info dictionary; defaults to the front-matter title. */
  title?: string;
  author?: string;
  subject?: string;
  keywords?: readonly string[];
}

/** Header/footer slots. */
export interface RunningSlots {
  left: string;
  center: string;
  right: string;
}

/** Every option, resolved. */
export interface ResolvedPdfOptions {
  page: PageBox;
  orientation: 'portrait' | 'landscape';
  margins: Margins;
  header: RunningSlots | undefined;
  footer: RunningSlots | undefined;
  headerOnFirstPage: boolean;
  numbering: { start: number; style: NumberingStyle; restartAt: string | undefined };
  toc: { depth: number; title: string; pageBreakAfter: boolean } | undefined;
  bookmarks: boolean;
  links: boolean;
  embedSource: boolean;
  compress: boolean;
  profile: 'pdf-1.7' | 'pdf-a-3b' | 'pdf-ua-1';
  widows: number;
  orphans: number;
  expandTables: boolean;
  grayscale: boolean;
  linkAppendix: boolean;
  title: string | undefined;
  author: string | undefined;
  subject: string | undefined;
  keywords: readonly string[];
}

function slots(value: { left?: string; center?: string; right?: string } | undefined): RunningSlots | undefined {
  if (value === undefined) return undefined;
  const left = value.left ?? '';
  const center = value.center ?? '';
  const right = value.right ?? '';
  if (left === '' && center === '' && right === '') return undefined;
  return { left, center, right };
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n < 1 ? 1 : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Front matter
// ─────────────────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** `{a: string | undefined}` → `{a?: string}`, which is what `pdf:` options are. */
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drop the `undefined`s.
 *
 * Necessary, not cosmetic: under `exactOptionalPropertyTypes` a present-but-
 * undefined key is not the same as an absent one, and spreading one options
 * object over another would otherwise let a missing field erase a set one.
 */
function compact<T extends object>(value: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as Defined<T>;
}

function readSlots(value: unknown): { left?: string; center?: string; right?: string } | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return compact({
    left: asString(record['left']),
    center: asString(record['center']),
    right: asString(record['right']),
  });
}

function readMargin(value: unknown): PdfExportOptions['margin'] {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  return compact({
    top: asString(record['top']),
    right: asString(record['right']),
    bottom: asString(record['bottom']),
    left: asString(record['left']),
  });
}

function readPageSize(value: unknown): PdfExportOptions['pageSize'] {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 2) {
    const w = asString(value[0]);
    const h = asString(value[1]);
    if (w !== undefined && h !== undefined) return [w, h];
  }
  return undefined;
}

/**
 * Read the document's own `pdf:` front-matter block (SPEC 28.2).
 *
 * Front matter is untrusted data, not a typed object: every field is checked
 * and a wrong-typed one is dropped rather than coerced. A `pageSize: 42` that
 * silently became `"42"` would be a worse outcome than falling back to A4 —
 * and the reader has already reported the type error at parse time.
 */
export function pdfOptionsFromFrontMatter(value: unknown): PdfExportOptions {
  const record = asRecord(value);
  if (record === undefined) return {};
  const numbering = asRecord(record['numbering']);
  const toc = asRecord(record['toc']);
  const keywords = record['keywords'];
  return compact({
    pageSize: readPageSize(record['pageSize']),
    orientation: asEnum(record['orientation'], ['portrait', 'landscape'] as const),
    margin: readMargin(record['margin']),
    header: readSlots(record['header']),
    footer: readSlots(record['footer']),
    headerOnFirstPage: asBool(record['headerOnFirstPage']),
    numbering:
      numbering === undefined
        ? undefined
        : compact({
            start: asNumber(numbering['start']),
            style: asEnum(numbering['style'], ['decimal', 'roman', 'alpha'] as const),
            restartAt: asString(numbering['restartAt']),
          }),
    toc:
      toc === undefined
        ? undefined
        : compact({
            depth: asNumber(toc['depth']),
            title: asString(toc['title']),
            pageBreakAfter: asBool(toc['pageBreakAfter']),
          }),
    bookmarks: asBool(record['bookmarks']),
    links: asBool(record['links']),
    embedSource: asBool(record['embedSource']),
    compress: asBool(record['compress']),
    profile: asEnum(record['profile'], ['pdf-1.7', 'pdf-a-3b', 'pdf-ua-1'] as const),
    widows: asNumber(record['widows']),
    orphans: asNumber(record['orphans']),
    expandTables: asBool(record['expandTables']),
    grayscale: asBool(record['grayscale']),
    linkAppendix: asBool(record['linkAppendix']),
    title: asString(record['title']),
    author: asString(record['author']),
    subject: asString(record['subject']),
    keywords: Array.isArray(keywords)
      ? keywords.filter((k): k is string => typeof k === 'string')
      : undefined,
  });
}

/**
 * Layer caller options over document options.
 *
 * The caller wins field by field, not object by object: a host that passes
 * `{ compress: false }` for a byte test must not thereby discard the document's
 * own page size.
 */
export function mergePdfOptions(
  base: PdfExportOptions,
  over: PdfExportOptions | undefined,
): PdfExportOptions {
  if (over === undefined) return base;
  return {
    ...base,
    ...compact(over),
    ...compact({
      header: base.header === undefined && over.header === undefined
        ? undefined
        : { ...base.header, ...compact(over.header ?? {}) },
      footer: base.footer === undefined && over.footer === undefined
        ? undefined
        : { ...base.footer, ...compact(over.footer ?? {}) },
      numbering: base.numbering === undefined && over.numbering === undefined
        ? undefined
        : { ...base.numbering, ...compact(over.numbering ?? {}) },
      toc: base.toc === undefined && over.toc === undefined
        ? undefined
        : { ...base.toc, ...compact(over.toc ?? {}) },
    }),
  };
}

/**
 * Resolve `pdf:` options.
 *
 * @throws PdfUnitError for a malformed page size or margin — host configuration
 * error, which SPEC 21 says is an exception, unlike document content.
 */
export function resolveOptions(opts: PdfExportOptions | undefined): ResolvedPdfOptions {
  const o = opts ?? {};
  const orientation = o.orientation ?? 'portrait';
  const size = Array.isArray(o.pageSize) ? ([o.pageSize[0], o.pageSize[1]] as const) : o.pageSize;
  const page = orient(resolvePageSize(size), orientation);
  const toc = o.toc;
  return {
    page,
    orientation,
    margins: resolveMargins(o.margin),
    header: slots(o.header),
    footer: slots(o.footer),
    headerOnFirstPage: o.headerOnFirstPage ?? false,
    numbering: {
      start: o.numbering?.start ?? 1,
      style: o.numbering?.style ?? 'decimal',
      restartAt: o.numbering?.restartAt,
    },
    toc:
      toc === undefined
        ? undefined
        : {
            depth: positiveInt(toc.depth, 3),
            title: toc.title ?? 'Contents',
            pageBreakAfter: toc.pageBreakAfter ?? true,
          },
    bookmarks: o.bookmarks ?? true,
    links: o.links ?? true,
    embedSource: o.embedSource ?? false,
    compress: o.compress ?? true,
    profile: o.profile ?? 'pdf-1.7',
    widows: positiveInt(o.widows, 2),
    orphans: positiveInt(o.orphans, 2),
    expandTables: o.expandTables ?? false,
    grayscale: o.grayscale ?? false,
    linkAppendix: o.linkAppendix ?? false,
    title: o.title,
    author: o.author,
    subject: o.subject,
    keywords: o.keywords ?? [],
  };
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/**
 * Format a page number.
 *
 * Hand-rolled rather than `toLocaleString`: SPEC 24.3 rule 3 forbids reading the
 * host locale, and `Intl` would make the bytes depend on the ICU build.
 */
export function formatPageNumber(value: number, style: NumberingStyle): string {
  if (value < 1) return String(value);
  if (style === 'decimal') return String(value);
  if (style === 'roman') {
    let n = value;
    let out = '';
    for (const [amount, glyphs] of ROMAN) {
      while (n >= amount) {
        out += glyphs;
        n -= amount;
      }
    }
    return out;
  }
  let n = value;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(97 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
