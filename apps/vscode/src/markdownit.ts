/**
 * The `markdown.markdownItPlugins` contribution (SPEC 29.2).
 *
 * > The `markdown.markdownItPlugins` contribution makes MDV blocks render
 * > inside VS Code's **built-in** Markdown preview too, so `.md` files with
 * > charts work without opening the custom preview.
 *
 * VS Code calls the `extendMarkdownIt` function returned from `activate` with
 * its own markdown-it instance. We do not depend on `markdown-it` — neither as a
 * runtime import nor as a type — because the instance is supplied by the host
 * and pinning a version here could disagree with the host's. {@link MarkdownItLike}
 * is the structural subset we actually touch, and every access is guarded.
 *
 * ## How a fence becomes a chart
 *
 * markdown-it's `fence` renderer rule is synchronous and sees one token at a
 * time. Rendering the token's body on its own would lose the document's front
 * matter (`defaults:`, `datasets:`) and any `@dataset` a block references, so
 * instead a core rule stashes the whole source on `env`, and the fence rule runs
 * the *document* through {@link DocumentPipeline.runSync} and picks out the block
 * whose opening-fence line matches the token's `map`. A five-chart document
 * costs one parse and one data resolution, not five: the second through fifth
 * fences hit the pipeline's per-block memo.
 *
 * When the source is not available (a host that renders tokens without an `env`,
 * or a token with no source map) the fence falls back to a synthetic
 * single-block document, which still draws the chart and only loses the
 * document-level cascade. That degradation is silent by design — a Markdown
 * preview is not the place to report it — and the real diagnostics are on the
 * squiggles in the editor.
 *
 * ## Safety
 *
 * - **Never throws.** markdown-it has no error boundary; a throw from a renderer
 *   rule blanks the whole preview. Every path is wrapped, and the fallback is
 *   the host's own default fence rendering, i.e. the block as a code block —
 *   which is exactly SPEC 5.6's degradation.
 * - **Never fetches.** `runSync` is used, so a `src:` in a `.md` file resolves to
 *   an error card rather than a network request from the Markdown preview, where
 *   there is no consent banner to ask through.
 * - The SVG is produced by `@mdv/render-svg`, which escapes every text node and
 *   emits no `<script>` and no event attributes; VS Code's Markdown preview
 *   applies its own CSP on top.
 */

import { DocumentPipeline, themeNameFor, type BuiltinName } from './pipeline/index.js';
import type { RenderedBlock } from './pipeline/index.js';
import type { MdvSettings } from './settings.js';
import { warn } from './log.js';

/** Content width assumed for the built-in Markdown preview, in CSS pixels. */
const MARKDOWN_PREVIEW_WIDTH = 720;

/** The markdown-it surface this module uses. Everything else is ignored. */
export interface MarkdownItLike {
  readonly core: {
    readonly ruler: {
      push(name: string, rule: (state: MarkdownItCoreState) => void): void;
    };
  };
  readonly renderer: {
    rules: Record<string, MarkdownItRenderRule | undefined>;
  };
  readonly utils?: { escapeHtml?(text: string): string };
}

interface MarkdownItCoreState {
  readonly src: string;
  readonly env: unknown;
}

interface MarkdownItToken {
  readonly info: string;
  readonly content: string;
  /** `[startLine, endLine)`, 0-based. Absent for tokens markdown-it synthesised. */
  readonly map: readonly [number, number] | null;
}

type MarkdownItRenderRule = (
  tokens: readonly MarkdownItToken[],
  idx: number,
  options: unknown,
  env: unknown,
  self: { renderToken(tokens: readonly MarkdownItToken[], idx: number, options: unknown): string },
) => string;

/** Where the core rule parks the document source for the fence rule to find. */
const SOURCE_KEY = '__mdvSource';

/** `true` when this fence's info string makes it a visual block (SPEC 5.2). */
function isMdvFence(info: string): boolean {
  const trimmed = info.trim();
  return trimmed === 'mdv' || trimmed.startsWith('mdv ') || trimmed.startsWith('mdv\t');
}

function sourceFromEnv(env: unknown): string | undefined {
  if (typeof env !== 'object' || env === null) return undefined;
  const value = (env as Record<string, unknown>)[SOURCE_KEY];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reconstruct a one-block document from the token alone.
 *
 * The fence style is chosen the way SPEC 5.1 requires: a backtick fence cannot
 * carry backticks in its info string, and the body may itself contain a run of
 * backticks, so the longest run in either decides the delimiter.
 */
function syntheticDocument(token: MarkdownItToken): string {
  const info = token.info.trim();
  const body = token.content.replace(/\n$/, '');
  if (info.includes('`')) {
    const longest = longestRun(body, '~');
    const fence = '~'.repeat(Math.max(3, longest + 1));
    return `${fence}${info}\n${body}\n${fence}\n`;
  }
  const longest = Math.max(longestRun(body, '`'), longestRun(info, '`'));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${body}\n${fence}\n`;
}

function longestRun(text: string, character: string): number {
  let best = 0;
  let current = 0;
  for (const char of text) {
    if (char === character) {
      current += 1;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best;
}

function escapeHtml(md: MarkdownItLike, text: string): string {
  const escaper = md.utils?.escapeHtml;
  if (typeof escaper === 'function') return escaper(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape a value that is about to sit inside a double-quoted attribute.
 *
 * markdown-it's own `escapeHtml` does escape `"`, but the instance is the
 * host's, and a chart title is author-controlled text: a host whose escaper
 * handled only `&` and `<` would let `title: 'x" onload="…'` add an attribute.
 * Re-escaping a quote that is already `&quot;` is a no-op, so this costs
 * nothing and closes the hole whatever the host supplied.
 */
function escapeAttr(md: MarkdownItLike, text: string): string {
  return escapeHtml(md, text).replace(/"/g, '&quot;');
}

/**
 * Build the `extendMarkdownIt` function VS Code asks `activate` for.
 *
 * One {@link DocumentPipeline} is closed over. It memoises on the source text,
 * so rendering the same document repeatedly (the Markdown preview re-renders on
 * every keystroke) re-parses only when the text actually changed, and switching
 * between two `.md` files costs one re-parse per switch. Memory is bounded by
 * one document.
 *
 * @param readSettings - reads the live `mdv.*` snapshot. Taken as a function
 * rather than a value so a settings change is picked up without re-registering
 * the plugin, which VS Code gives no way to do.
 */
export function createMarkdownItExtension(
  readSettings: () => MdvSettings,
  editorKind: () => 'light' | 'dark' | 'high-contrast',
): (md: MarkdownItLike) => MarkdownItLike {
  const pipeline = new DocumentPipeline();

  return function extendMarkdownIt(md: MarkdownItLike): MarkdownItLike {
    try {
      md.core.ruler.push('mdv_capture_source', (state) => {
        if (typeof state.env === 'object' && state.env !== null) {
          (state.env as Record<string, unknown>)[SOURCE_KEY] = state.src;
        }
      });

      const fallback: MarkdownItRenderRule =
        md.renderer.rules['fence'] ??
        ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

      md.renderer.rules['fence'] = (tokens, idx, options, env, self): string => {
        const token = tokens[idx];
        if (token === undefined || !isMdvFence(token.info)) {
          return fallback(tokens, idx, options, env, self);
        }
        try {
          const settings = readSettings();
          const theme: BuiltinName = themeNameFor(settings.preview.theme, editorKind());
          const block = renderFence(pipeline, token, env, theme, settings);
          if (block === undefined) return fallback(tokens, idx, options, env, self);
          const label = block.title ?? `${block.blockType} chart`;
          return (
            `<div class="mdv-block" data-mdv-type="${escapeAttr(md, block.blockType)}"` +
            ` role="figure" aria-label="${escapeAttr(md, label)}">${block.svg}</div>\n`
          );
        } catch (error) {
          // SPEC 5.6: a visual block that cannot be drawn degrades to a legible
          // code block, which is precisely what the default renderer produces.
          warn(`markdown-it fence: ${error instanceof Error ? error.message : String(error)}`);
          return fallback(tokens, idx, options, env, self);
        }
      };
    } catch (error) {
      warn(`markdown-it extension: ${error instanceof Error ? error.message : String(error)}`);
    }
    return md;
  };
}

/** Render one fence, preferring the whole-document path. */
function renderFence(
  pipeline: DocumentPipeline,
  token: MarkdownItToken,
  env: unknown,
  theme: BuiltinName,
  settings: MdvSettings,
): RenderedBlock | undefined {
  const source = sourceFromEnv(env);
  const startLine = token.map?.[0];

  if (source !== undefined && startLine !== undefined) {
    const result = pipeline.runSync({
      source,
      uri: 'markdown-preview:document',
      width: MARKDOWN_PREVIEW_WIDTH,
      theme,
      level: settings.validate.level,
      strict: settings.validate.strict,
      // The built-in Markdown preview has no consent banner, so it never
      // fetches, whatever the workspace setting says (SPEC 29.3).
      allowExternal: false,
      allowedOrigins: [],
    });
    const match = result.blocks.find((block) => block.startLine === startLine);
    if (match !== undefined && match.svg.length > 0) return match;
    // A `dataset`/`config` fence produces no drawing; fall through to the
    // default renderer rather than emitting an empty figure.
    if (match !== undefined) return undefined;
  }

  // No source map, or the block was not found: render the token on its own.
  const standalone = new DocumentPipeline();
  const result = standalone.runSync({
    source: syntheticDocument(token),
    uri: 'markdown-preview:fence',
    width: MARKDOWN_PREVIEW_WIDTH,
    theme,
    level: settings.validate.level,
    strict: settings.validate.strict,
    allowExternal: false,
    allowedOrigins: [],
  });
  const first = result.blocks[0];
  return first !== undefined && first.svg.length > 0 ? first : undefined;
}
