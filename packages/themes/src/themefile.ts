/**
 * Reading a theme that arrived as untyped data — a theme file (SPEC 11.6).
 *
 * > A theme may also be a named built-in (`default`, `dark`, `print`,
 * > `high-contrast`) or **a path to a theme file**. A reader MUST run palette
 * > validation on a custom categorical palette and MUST report failures as
 * > `MDV3080` warnings.
 *
 * Every host that can reach a filesystem does the same four things with what it
 * finds there — read the text, shape the value, resolve it against its base,
 * report the palette findings — so all four live here rather than once per host:
 * {@link themeFromText} for a file, {@link themeFromValue} for a value that was
 * already parsed (front matter's inline `theme:` mapping).
 *
 * What stays with the host is the half that is genuinely its own: fetching the
 * bytes, which needs a filesystem or a workspace API this package has no
 * business knowing about, and turning the returned strings into whatever a
 * diagnostic looks like there, since only the host knows the range to attach
 * them to.
 *
 * The shape check exists because `resolveTheme` is typed, not guarded: handed
 * `{categorical: {}}` it would throw a `TypeError` from deep inside a `.map`,
 * and "categorical.map is not a function" is not an author-actionable message.
 * Every rejection below names the key and what was expected instead.
 */

import { MdvConfigError } from '@mdv/core';
import { parseYamlValue } from '@mdv/parser';
import type {
  ColorScheme,
  ColorString,
  PaletteValidation,
  Theme,
  ThemeColorRole,
  ThemeOverride,
} from '@mdv/core';
import { resolveTheme } from './resolve.js';

/** The token roles a theme file may patch (SPEC 11.1). */
const TOKEN_ROLES: readonly ThemeColorRole[] = Object.freeze([
  'surface',
  'page',
  'text-primary',
  'text-secondary',
  'text-muted',
  'grid',
  'axis',
  'border',
  'success-text',
]);

/** The metric tokens a theme file may patch (SPEC 11.5). */
const METRIC_KEYS = Object.freeze(['radius', 'hairline', 'gap', 'ring'] as const);

/** What {@link themeFromValue} produced. */
export interface ThemeFileResult {
  /**
   * The resolved theme, or `undefined` when the value was not a theme at all.
   *
   * A theme that resolved *and* failed validation still comes back here: SPEC
   * 11.6 asks for warnings, not for a refusal. Falling back to the preview theme
   * because a palette slot is 2.9:1 would replace the author's chart with a
   * different one and blame them for it.
   */
  readonly theme: Theme | undefined;
  /**
   * Why the value is not a theme, in the order found. Non-empty exactly when
   * `theme` is `undefined`; the host reports these as `MDV1502`.
   */
  readonly errors: readonly string[];
  /**
   * Palette **failures**, for `MDV3080` (SPEC 11.6, 16.4).
   *
   * Failures only — the `warn`-level findings are the relief rule, and the
   * built-in `default` palette raises three of them by itself. Attaching those
   * to the theme file would blame the author for a palette they inherited and
   * would fire on a file whose only line is a new `surface`. A host that wants
   * the relief obligation reads `validation.reliefRequiredSlots` per block,
   * where the slot is actually in use.
   */
  readonly warnings: readonly string[];
  /**
   * The full validation result, for a host that wants more than the failures —
   * the relief rule (`MDV3081`) reads `reliefRequiredSlots`. `undefined` when
   * nothing resolved.
   */
  readonly validation: PaletteValidation | undefined;
}

/**
 * Shape, resolve and validate a parsed theme file (SPEC 11.6).
 *
 * Never throws: a theme file is document content in the sense of SPEC 14.1, and
 * an unreadable one degrades to `errors` plus the caller's fallback theme.
 *
 * @param value - the parsed file: JSON, YAML, or front matter's `theme:` mapping
 * @param scheme - the scheme in force, for the base the file extends
 */
export function themeFromValue(value: unknown, scheme: ColorScheme): ThemeFileResult {
  const errors: string[] = [];
  const override = toOverride(value, errors);
  if (override === undefined) {
    return { theme: undefined, errors, warnings: [], validation: undefined };
  }

  let theme: Theme;
  try {
    theme = resolveTheme(override, scheme);
  } catch (error) {
    // `resolveTheme` throws `MdvConfigError` for an unparseable colour, an empty
    // palette or an unknown `extends`. Its messages are already author-facing
    // and already name the key, so they pass through unedited.
    errors.push(error instanceof MdvConfigError ? error.message : describe(error));
    return { theme: undefined, errors, warnings: [], validation: undefined };
  }

  const validation = theme.validation;
  return {
    theme,
    errors,
    warnings:
      validation === undefined
        ? []
        : validation.findings.filter((f) => f.level === 'fail').map((f) => f.message),
    validation,
  };
}

/** Which reader {@link themeFromText} should use. */
export type ThemeFileFormat = 'json' | 'jsonc' | 'yaml';

/**
 * The format a theme setting names, or `undefined` when the setting is not a
 * path at all.
 *
 * SPEC 11.6 lets `theme:` be either a built-in name or a path to a file, with
 * nothing but the string to tell them apart. Every host needs that decision and
 * must make it identically — a `.yaml` path mistaken for a name is the CLI bug
 * this replaces, where `theme: corporate.yaml` was looked up as a built-in and
 * reported as an unknown theme.
 *
 * `.jsonc` is JSON with comments and trailing commas, as VS Code means it — a
 * separate format rather than an alias for `json`, because an author who typed
 * `.json` wants `// note` refused and an author who typed `.jsonc` wants it read.
 * Neither is handed to the YAML reader, which would absorb `//` into the next
 * key instead of noticing it.
 */
export function themeFileFormat(setting: string): ThemeFileFormat | undefined {
  const dot = setting.lastIndexOf('.');
  if (dot === -1) return undefined;
  switch (setting.slice(dot + 1).toLowerCase()) {
    case 'json':
      return 'json';
    case 'jsonc':
      return 'jsonc';
    case 'yaml':
    case 'yml':
      return 'yaml';
    default:
      return undefined;
  }
}

/**
 * Read a theme file's text, then shape, resolve and validate it (SPEC 11.6).
 *
 * Never throws, for the same reason {@link themeFromValue} does not: a file the
 * author picked is content, and unreadable content degrades to `errors` plus the
 * caller's fallback theme (SPEC 14.1).
 *
 * The two formats get their own readers on purpose. YAML 1.2 is a superset of
 * JSON and could read both, but it is a *forgiving* superset: `{"a": 1,}` passes
 * and `// a note` is absorbed into the next key instead of failing, so a JSON
 * file with a comment would lose a token silently. `JSON.parse` refuses both,
 * which is what an author who named their file `.json` asked for.
 *
 * @param text - the whole file, already decoded to UTF-16 (SPEC 3.2)
 * @param scheme - the scheme in force, for the base the file extends
 * @param format - from {@link themeFileFormat}, on the path the text came from
 */
export function themeFromText(
  text: string,
  scheme: ColorScheme,
  format: ThemeFileFormat,
): ThemeFileResult {
  const parsed = format === 'yaml' ? readYaml(text) : readJson(text, format === 'jsonc');
  if (!parsed.ok) {
    return { theme: undefined, errors: parsed.errors, warnings: [], validation: undefined };
  }
  return themeFromValue(parsed.value, scheme);
}

// ─────────────────────────────────────────────────────────────────────────────

/** A parsed text, or why it could not be parsed. */
type TextResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly string[] };

function readJson(text: string, comments: boolean): TextResult {
  const source = comments ? stripJsonc(text) : text;
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch (error) {
    const detail = describe(error);
    // `JSON.parse` says "Unexpected token /", which is true and unhelpful. The
    // author wrote a comment; tell them JSON has none and where to go instead.
    const hint = hasJsonComment(source)
      ? ' — JSON has no comments. Remove it, rename the file to `.jsonc`, or move the theme to a `.yaml` file, where `#` starts one.'
      : '';
    return { ok: false, errors: [`JSON syntax error: ${detail}${hint}`] };
  }
}

/**
 * `.jsonc`'s comments and trailing commas, blanked to spaces.
 *
 * Blanked rather than cut, and newlines kept, so every offset and line number
 * survives: `JSON.parse`'s "position 118" still points into the author's file.
 * The scan tracks strings, so `"url": "https://example.com"` is not a comment
 * and the comma in `"a,b"` is not a trailing one.
 */
function stripJsonc(text: string): string {
  const out = text.split(''); // UTF-16 units, so offsets are unchanged
  let inString = false;
  let comma = -1; // a comma with nothing but blanks between it and here

  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      comma = -1;
    } else if (ch === '/' && out[i + 1] === '/') {
      while (i < out.length && out[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      i -= 1; // the `\n` (or the end) is the loop's to advance past
    } else if (ch === '/' && out[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? out.length : close + 2;
      for (let j = i; j < stop; j += 1) if (out[j] !== '\n') out[j] = ' ';
      i = stop - 1;
    } else if (ch === ',') {
      comma = i;
    } else if (ch === '}' || ch === ']') {
      if (comma !== -1) out[comma] = ' ';
      comma = -1;
    } else if (ch !== undefined && !/\s/u.test(ch)) {
      comma = -1;
    }
  }
  return out.join('');
}

function readYaml(text: string): TextResult {
  const result = parseYamlValue(text);
  if (result.errors.length > 0) {
    // `yaml` recovers and keeps going, but a theme file is not worth guessing
    // at: the recovered value may be missing exactly the palette that was asked
    // for, and silently rendering the base theme instead is the worse failure.
    return {
      ok: false,
      errors: result.errors.map(
        (error) => `YAML syntax error at ${lineColumn(text, error.start)}: ${error.message}`,
      ),
    };
  }
  return { ok: true, value: result.value };
}

/**
 * True when the text opens a comment — line or block — outside a string.
 *
 * A scan rather than a `.includes('//')`, so `"url": "https://example.com"` is
 * not accused of being a comment.
 */
function hasJsonComment(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

/** A UTF-16 offset as `line 3, column 12`, both 1-based, for a message. */
function lineColumn(text: string, offset: number): string {
  const upto = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = upto.split('\n').length;
  const column = offset - (upto.lastIndexOf('\n') + 1) + 1;
  return `line ${line}, column ${Math.max(1, column)}`;
}

/** The value → {@link ThemeOverride} shape check. `undefined` on any rejection. */
function toOverride(value: unknown, errors: string[]): ThemeOverride | undefined {
  if (!isRecord(value)) {
    errors.push(`A theme file must be a mapping of keys to values, not ${typeName(value)}`);
    return undefined;
  }

  const out: {
    -readonly [K in keyof ThemeOverride]: ThemeOverride[K];
  } = {};

  const extendsName = optionalString(value, 'extends', errors);
  if (extendsName !== undefined) out.extends = extendsName;
  const name = optionalString(value, 'name', errors);
  if (name !== undefined) out.name = name;

  const scheme = optionalString(value, 'scheme', errors);
  if (scheme !== undefined) {
    if (scheme !== 'light' && scheme !== 'dark') {
      errors.push(`theme.scheme must be "light" or "dark", not ${JSON.stringify(scheme)}`);
    } else {
      out.scheme = scheme;
    }
  }

  const tokens = optionalRecord(value, 'tokens', errors);
  if (tokens !== undefined) {
    const patch: Partial<Record<ThemeColorRole, ColorString>> = {};
    for (const [key, entry] of Object.entries(tokens)) {
      if (!(TOKEN_ROLES as readonly string[]).includes(key)) {
        // An unknown role is SPEC 15.2's unknown construct: it degrades, it is
        // not an error. Naming it is the whole value of noticing.
        errors.push(
          `theme.tokens.${key} is not a colour role; expected one of ${TOKEN_ROLES.join(', ')}`,
        );
        continue;
      }
      const colour = asString(entry);
      if (colour === undefined) {
        errors.push(`theme.tokens.${key} must be a colour string, not ${typeName(entry)}`);
        continue;
      }
      patch[key as ThemeColorRole] = colour;
    }
    out.tokens = patch;
  }

  if ('categorical' in value) {
    const raw = value['categorical'];
    if (!Array.isArray(raw)) {
      errors.push(`theme.categorical must be a list of colours, not ${typeName(raw)}`);
    } else {
      const slots: ColorString[] = [];
      raw.forEach((entry: unknown, i) => {
        const colour = asString(entry);
        if (colour === undefined) {
          errors.push(`theme.categorical[${i}] must be a colour string, not ${typeName(entry)}`);
          return;
        }
        slots.push(colour);
      });
      out.categorical = slots;
    }
  }

  const sequential = optionalRecord(value, 'sequential', errors);
  if (sequential !== undefined) {
    const hue = asString(sequential['hue']);
    if (hue === undefined) {
      errors.push('theme.sequential.hue is required and must be a colour string');
    } else {
      const steps = sequential['steps'];
      if (steps === undefined || steps === null) {
        out.sequential = { hue };
      } else if (typeof steps === 'number') {
        out.sequential = { hue, steps };
      } else {
        errors.push(`theme.sequential.steps must be a number, not ${typeName(steps)}`);
      }
    }
  }

  const diverging = optionalRecord(value, 'diverging', errors);
  if (diverging !== undefined) {
    const low = asString(diverging['low']);
    const high = asString(diverging['high']);
    if (low === undefined || high === undefined) {
      errors.push('theme.diverging needs both `low` and `high` as colour strings');
    } else {
      const mid = asString(diverging['mid']);
      out.diverging = mid === undefined ? { low, high } : { low, high, mid };
    }
  }

  const font = optionalRecord(value, 'font', errors);
  if (font !== undefined) {
    const family = asString(font['family']);
    const size = font['size'];
    const patch: { family?: string; size?: number } = {};
    if (family !== undefined) patch.family = family;
    if (size !== undefined && size !== null) {
      if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
        errors.push(`theme.font.size must be a positive number, not ${typeName(size)}`);
      } else {
        patch.size = size;
      }
    }
    out.font = patch;
  }

  const metrics = optionalRecord(value, 'metrics', errors);
  if (metrics !== undefined) {
    const patch: Record<string, number> = {};
    for (const key of METRIC_KEYS) {
      const entry = metrics[key];
      if (entry === undefined || entry === null) continue;
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
        errors.push(`theme.metrics.${key} must be a non-negative number, not ${typeName(entry)}`);
        continue;
      }
      patch[key] = entry;
    }
    out.metrics = patch;
  }

  // A file that says nothing is not a theme; it is almost certainly the wrong
  // file, and resolving it to "the base, unchanged" would hide that.
  if (Object.keys(out).length === 0 && errors.length === 0) {
    errors.push(
      'A theme file must set at least one of extends, tokens, categorical, sequential, ' +
        'diverging, font or metrics',
    );
  }
  return errors.length === 0 ? out : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): string | undefined {
  const entry = value[key];
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry !== 'string') {
    errors.push(`theme.${key} must be a string, not ${typeName(entry)}`);
    return undefined;
  }
  return entry;
}

function optionalRecord(
  value: Record<string, unknown>,
  key: string,
  errors: string[],
): Record<string, unknown> | undefined {
  const entry = value[key];
  if (entry === undefined || entry === null) return undefined;
  if (!isRecord(entry)) {
    errors.push(`theme.${key} must be a mapping, not ${typeName(entry)}`);
    return undefined;
  }
  return entry;
}

/** A type name an author would recognise, for "expected X, got Y" messages. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  return `the ${typeof value} ${String(value)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
