/**
 * Front matter (SPEC 3.4) and version negotiation (SPEC 15.3).
 *
 * Front matter is real YAML — unlike a block header, which is the deliberately
 * small subset of SPEC 5.3 — so this is the one place the `yaml` dependency is
 * used. It is parsed here rather than through `micromark-extension-frontmatter`
 * for two reasons: SPEC 3.4 allows `...` as a terminator, which that extension's
 * default configuration does not, and the CST gives per-key source ranges that
 * an `attrsPosition` needs.
 *
 * Unknown keys are preserved verbatim in `extra` and MUST NOT produce an error
 * (SPEC 3.4) — static site generators put their own keys here all the time.
 */

import { SPEC_VERSION } from '@mdv/spec';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { AttrMap, AttrValue, FrontMatter, Range } from '../types.js';
import type { DiagnosticBag } from './diagnostics.js';
import type { SourceIndex } from './source.js';

/** SPEC 3.4 reserved top-level keys. Everything else lands in `extra`. */
const RESERVED: ReadonlySet<string> = new Set([
  'mdv',
  'title',
  'subtitle',
  'author',
  'date',
  'lang',
  'theme',
  'locale',
  'timezone',
  'defaults',
  'datasets',
  'pdf',
  'security',
  'plugins',
  'toc',
  'numbering',
]);

/** A line containing exactly `---`. */
const OPEN = /^---[ \t]*$/;
/** A line containing exactly `---` or `...`. */
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

export interface FrontMatterResult {
  readonly frontmatter: FrontMatter | null;
  /** 0-based line at which the Markdown body starts. */
  readonly bodyLine: number;
}

/**
 * Read front matter from the top of a document.
 *
 * Emits `MDV1300` for malformed YAML, `MDV1100` when no `mdv:` version is
 * declared, and `MDV1510`/`MDV1511` when the document targets a newer spec.
 */
export function parseFrontMatter(
  root: SourceIndex,
  bag: DiagnosticBag,
  enabled: boolean,
): FrontMatterResult {
  if (!enabled || !OPEN.test(root.lineText(0))) {
    noVersion(bag, root.range(0, 0));
    return { frontmatter: null, bodyLine: 0 };
  }

  let close = -1;
  for (let line = 1; line < root.lineCount; line += 1) {
    if (CLOSE.test(root.lineText(line))) {
      close = line;
      break;
    }
  }
  if (close === -1) {
    bag.add('MDV1300', root.range(0, root.lineEnd(0)), {
      detail:
        'Front matter opens with `---` but is never terminated by a line containing ' +
        'exactly `---` or `...`.',
    });
    noVersion(bag, root.range(0, 0));
    return { frontmatter: null, bodyLine: 0 };
  }

  const base = root.lineStart(1);
  const text = root.text.slice(base, root.lineStart(close));
  const range = root.range(0, root.lineEnd(close));

  const attrs: AttrMap = {};
  const positions: Record<string, Range> = {};
  try {
    const document = parseDocument(text, { prettyErrors: false });
    for (const error of document.errors) {
      const from = error.pos[0] ?? 0;
      const to = error.pos[1] ?? from;
      bag.add('MDV1300', root.range(base + from, base + to), {
        detail: firstLine(error.message),
      });
    }
    collectPositions(document.contents, '', base, root, positions);
    const value = toAttrValue(document.toJS({ maxAliasCount: 100 }));
    if (isAttrMap(value)) {
      for (const [key, entry] of Object.entries(value)) attrs[key] = entry;
    } else if (value !== null) {
      bag.add('MDV1300', range, {
        detail: 'Front matter must be a mapping of keys to values.',
      });
    }
  } catch (error) {
    // `yaml` throws only for non-YAML failures, but parse must never propagate.
    bag.add('MDV1300', range, { detail: describe(error) });
  }

  const frontmatter = buildFrontMatter(attrs, positions, range, root);
  checkVersion(frontmatter, positions, bag, range);
  return { frontmatter, bodyLine: close + 1 };
}

// ─────────────────────────────────────────────────────────────────────────────

function buildFrontMatter(
  attrs: AttrMap,
  positions: Record<string, Range>,
  range: Range,
  root: SourceIndex,
): FrontMatter {
  const extra: AttrMap = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!RESERVED.has(key)) extra[key] = value;
  }

  const text = (key: string): string | undefined => {
    const value = attrs[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'string') return value;
    // SPEC 5.3.3: a value declared `string` is taken literally, so fall back to
    // exactly what the author wrote rather than to a coerced number.
    const position = positions[key];
    if (position !== undefined) {
      return root.text.slice(position.start.offset, position.end.offset).trim();
    }
    return String(value);
  };
  const map = (key: string): AttrMap | undefined => {
    const value = attrs[key];
    return isAttrMap(value) ? value : undefined;
  };
  const mapOrBoolean = (key: string): AttrMap | boolean | undefined => {
    const value = attrs[key];
    if (typeof value === 'boolean') return value;
    return isAttrMap(value) ? value : undefined;
  };

  const themeValue = attrs['theme'];
  const theme = isAttrMap(themeValue) ? themeValue : text('theme');
  const pluginsValue = attrs['plugins'];
  const plugins = Array.isArray(pluginsValue)
    ? pluginsValue.map((entry) => (typeof entry === 'string' ? entry : String(entry)))
    : undefined;

  // Built by assignment rather than by spreading conditionals: under
  // `exactOptionalPropertyTypes` an absent key and a key set to `undefined` are
  // different types, and only the former is what SPEC 3.4 means by "absent".
  const frontmatter: FrontMatter = { extra, range, attrsPosition: positions };
  const mdv = text('mdv');
  if (mdv !== undefined) frontmatter.mdv = mdv;
  const title = text('title');
  if (title !== undefined) frontmatter.title = title;
  const subtitle = text('subtitle');
  if (subtitle !== undefined) frontmatter.subtitle = subtitle;
  const author = text('author');
  if (author !== undefined) frontmatter.author = author;
  const date = text('date');
  if (date !== undefined) frontmatter.date = date;
  const lang = text('lang');
  if (lang !== undefined) frontmatter.lang = lang;
  if (theme !== undefined) frontmatter.theme = theme;
  const locale = text('locale');
  if (locale !== undefined) frontmatter.locale = locale;
  const timezone = text('timezone');
  if (timezone !== undefined) frontmatter.timezone = timezone;
  const defaults = map('defaults');
  if (defaults !== undefined) frontmatter.defaults = defaults;
  const datasets = map('datasets');
  if (datasets !== undefined) frontmatter.datasets = datasets;
  const pdf = map('pdf');
  if (pdf !== undefined) frontmatter.pdf = pdf;
  const security = map('security');
  if (security !== undefined) frontmatter.security = security;
  if (plugins !== undefined) frontmatter.plugins = plugins;
  const toc = mapOrBoolean('toc');
  if (toc !== undefined) frontmatter.toc = toc;
  const numbering = mapOrBoolean('numbering');
  if (numbering !== undefined) frontmatter.numbering = numbering;
  return frontmatter;
}

/** SPEC 15.3 version negotiation. */
function checkVersion(
  frontmatter: FrontMatter | null,
  positions: Record<string, Range>,
  bag: DiagnosticBag,
  fallback: Range,
): void {
  const declared = frontmatter?.mdv;
  if (declared === undefined || declared.length === 0) {
    noVersion(bag, fallback);
    return;
  }
  const range = positions['mdv'] ?? fallback;
  const document = parseVersion(declared);
  const reader = parseVersion(SPEC_VERSION) ?? { major: 1, minor: 0 };
  if (document === null) {
    bag.add('MDV1300', range, {
      message: 'The `mdv:` version is not a `major.minor` version string',
      detail: `Found \`${declared}\`; write \`mdv: "1.0"\`.`,
    });
    return;
  }
  if (document.major > reader.major) {
    bag.add('MDV1510', range, {
      detail: `This document targets MDV ${declared}; this reader implements ${SPEC_VERSION}.`,
    });
    return;
  }
  if (document.major === reader.major && document.minor > reader.minor) {
    bag.add('MDV1511', range, {
      detail: `This document targets MDV ${declared}; this reader implements ${SPEC_VERSION}.`,
    });
  }
}

function noVersion(bag: DiagnosticBag, range: Range): void {
  bag.add('MDV1100', range, {
    detail: `Add \`mdv: "${majorMinor(SPEC_VERSION)}"\` to the front matter to pin the version.`,
  });
}

interface Version {
  readonly major: number;
  readonly minor: number;
}

function parseVersion(value: string): Version | null {
  const match = /^(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function majorMinor(value: string): string {
  const version = parseVersion(value);
  return version === null ? value : `${version.major}.${version.minor}`;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Walk the YAML CST recording a range for every dotted path. */
function collectPositions(
  node: unknown,
  path: string,
  base: number,
  root: SourceIndex,
  out: Record<string, Range>,
): void {
  if (isMap(node)) {
    for (const item of node.items) {
      const key = isScalar(item.key) ? String(item.key.value) : null;
      if (key === null) continue;
      const child = path === '' ? key : `${path}.${key}`;
      const target = item.value ?? item.key;
      record(target, child, base, root, out);
      collectPositions(item.value, child, base, root, out);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      const child = `${path}[${index}]`;
      record(item, child, base, root, out);
      collectPositions(item, child, base, root, out);
    });
  }
}

function record(
  node: unknown,
  path: string,
  base: number,
  root: SourceIndex,
  out: Record<string, Range>,
): void {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (range === undefined || range === null) return;
  out[path] = root.range(base + range[0], base + range[1]);
}

function toAttrValue(value: unknown): AttrValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => toAttrValue(entry));
  if (value instanceof Map) {
    const out: AttrMap = {};
    for (const [key, entry] of value.entries()) out[String(key)] = toAttrValue(entry);
    return out;
  }
  if (typeof value === 'object') {
    const out: AttrMap = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toAttrValue(entry);
    return out;
  }
  return String(value);
}

function isAttrMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLine(message: string): string {
  const index = message.indexOf('\n');
  return index === -1 ? message : message.slice(0, index);
}

function describe(error: unknown): string {
  if (error instanceof Error) return firstLine(error.message);
  return 'The front matter could not be parsed as YAML.';
}
