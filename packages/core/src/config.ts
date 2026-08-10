/**
 * `MdvConfig` → `ResolvedConfig` (SPEC 25).
 *
 * `ResolvedConfig` exists so that "nothing downstream re-derives a default and
 * gets a different answer" — its own doc comment. This module is the single
 * place those defaults are applied. Every one of them is quoted from the
 * `@defaultValue` tags on `types/config.ts`, which are in turn quoted from
 * SPEC 25; when the two disagree the tag is the bug.
 *
 * Front matter contributes `locale`, `timezone` and `date:` **only where the
 * embedder left them open**: configuration outranks the document, because a
 * document must not be able to change the environment it is rendered in. That
 * rule already exists once, in `dataOptionsFrom`, and this module calls it
 * rather than restating it.
 */

import type { MdvDocument } from '@mdv/parser';
import type { BlockAttrs } from './types/attrs.js';
import type { MdvConfig, ResolvedConfig } from './types/config.js';
import type { Theme, ThemeOverride } from './types/theme.js';
import type { ChartTypeRegistry } from './registry.js';
import type { DiagCollector } from './data/diag.js';
import { MdvConfigError } from './types/config.js';
import { createChartRegistry, isChartType } from './registry.js';
import { dataOptionsFrom } from './resolve.js';
import { resolveColorScheme, resolveThemeSetting } from './theme/index.js';

/** Every theme any configured plugin registered, in plugin order (SPEC 26.1). */
export function pluginThemes(config: MdvConfig | undefined): readonly Theme[] {
  const out: Theme[] = [];
  for (const plugin of config?.plugins ?? []) {
    for (const theme of plugin.themes ?? []) out.push(theme);
  }
  return out;
}

/**
 * Apply the SPEC 25 defaults.
 *
 * @param diag - receives `MDV1502` when a configured theme name matched nothing
 * registered. Absent means "do not report", which is what `Mdv#config` wants.
 */
export function resolveConfig(
  config: MdvConfig | undefined,
  doc?: MdvDocument,
  diag?: DiagCollector,
): ResolvedConfig {
  // `locale`, `timezone` and `buildTime` are derived by the data stage's own
  // options builder so the two cannot disagree about what `date:` means.
  const data = dataOptionsFrom(config, doc);
  const scheme = resolveColorScheme(config?.colorScheme);
  const theme = resolveThemeSetting(
    config?.theme ?? frontMatterTheme(doc),
    scheme,
    pluginThemes(config),
  );

  if (theme.unknownName !== undefined) {
    diag?.emit('MDV1502', {
      message: `Unknown theme \`${theme.unknownName}\` — the fallback theme was used`,
      detail:
        'Register the theme through a plugin, or pass a resolved `Theme` as `config.theme`. ' +
        'The built-in themes live in `@mdv/themes`.',
    });
  }
  if (theme.unapplied !== undefined) {
    diag?.emit('MDV1502', {
      message: `Theme override \`${theme.unapplied.join('`, `')}\` needs a colour engine \`@mdv/core\` does not have`,
      detail:
        'Generated ramps are built by `@mdv/themes`. Resolve the theme there and pass the ' +
        'result as `config.theme`.',
    });
  }

  return {
    // `dataOptionsFrom` always sets `level` (`config?.level ?? 2`), but declares
    // it optional because `PrepareOptions` does. The `?? 2` is unreachable and
    // restates SPEC 25's default rather than inventing a second one.
    level: data.level ?? 2,
    strict: config?.strict ?? false,
    theme: theme.theme,
    colorScheme: scheme,
    locale: data.format.locale,
    timezone: data.timezone,
    buildTime: data.buildTime,
    defaults: documentDefaults(config, doc),
    security: {
      allowExternal: config?.security?.allowExternal ?? false,
      allowedOrigins: config?.security?.allowedOrigins ?? [],
      allowHtml: config?.security?.allowHtml ?? false,
      allowFileUrls: config?.security?.allowFileUrls ?? false,
      maxDocumentBytes: data.limits.maxDocumentBytes,
      maxRowsPerBlock: data.limits.maxRowsPerBlock,
      fetchTimeoutMs: data.limits.fetchTimeoutMs,
    },
    render: {
      target: config?.render?.target ?? 'auto',
      canvasThreshold: config?.render?.canvasThreshold ?? 5000,
      downsampleThreshold: config?.render?.downsampleThreshold ?? 4000,
      animate: config?.render?.animate ?? true,
      renderPolicy: config?.render?.renderPolicy ?? 'lazy',
      worker: config?.render?.worker ?? false,
    },
    a11y: {
      texture: config?.a11y?.texture ?? false,
      tableView: config?.a11y?.tableView ?? 'details',
      generateDesc: config?.a11y?.generateDesc ?? true,
    },
    plugins: config?.plugins ?? [],
    capabilities: config?.capabilities ?? {},
  };
}

/**
 * Front matter's `theme:` — a name, or an inline override map.
 *
 * Configuration outranks it, for the same reason it outranks `locale:`: a
 * document must not be able to restyle the page that embeds it. Front matter is
 * consulted only where the embedder left the setting open, which is the ordering
 * `dataOptionsFrom` already uses for locale and timezone.
 */
function frontMatterTheme(doc: MdvDocument | undefined): string | ThemeOverride | undefined {
  const value = doc?.frontmatter?.theme;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  // An `AttrMap` from front matter has no spelling for the required members of a
  // resolved `Theme`, so it can only ever be an override; `resolveThemeSetting`
  // re-checks that with `isResolvedTheme` rather than trusting this comment.
  return value as ThemeOverride;
}

/**
 * The chart types in force, from the configured plugins in plugin order.
 *
 * Core registers no chart types of its own — `@mdv/charts` depends on core, not
 * the other way round — so a core-only registry is empty and every block renders
 * as a table with `MDV1500`. That is the correct behaviour for a host that
 * installed no chart types, and it is why `@mdv/charts` is delivered through
 * `plugins[].chartTypes` rather than imported.
 *
 * @throws MdvConfigError when an entry is not a chart type. SPEC 21 makes host
 * programmer error an exception and document problems diagnostics, and a plugin
 * handing core an object with no `encode` is the former.
 */
export function registryFromPlugins(
  config: MdvConfig | undefined,
  diag?: DiagCollector,
): ChartTypeRegistry {
  const registry = createChartRegistry();
  const plugins = config?.plugins ?? [];
  for (let p = 0; p < plugins.length; ++p) {
    const plugin = plugins[p];
    const types = plugin?.chartTypes ?? [];
    for (let t = 0; t < types.length; ++t) {
      const candidate = types[t];
      if (!isChartType(candidate)) {
        throw new MdvConfigError(
          `plugins[${p}].chartTypes[${t}] is not a chart type: it must have \`name\`, \`level\`, ` +
            '`family`, `channels`, `defaultEncoding`, `validate`, `encode` and `layout`',
          `plugins[${p}].chartTypes[${t}]`,
        );
      }
      // SPEC 26.2: later plugins win, and displacing an existing registration is
      // worth an info — a name collision between two plugins is nearly always
      // accidental, and silently keeping the last one is how it stays hidden.
      if (registry.has(candidate.name)) {
        diag?.emit('MDV1520', {
          message: `Plugin \`${plugin?.name ?? p}\` overrides the already-registered chart type \`${candidate.name}\``,
          detail: 'Plugins are applied in order and the last registration wins (SPEC 26.2).',
        });
      }
      registry.register(candidate);
    }
  }
  registry.freeze();
  return registry;
}

/**
 * Cascade levels 3 and 4 collapsed into one map (SPEC 5.5).
 *
 * `ResolvedConfig.defaults` is a single `Partial<BlockAttrs>`, but the cascade
 * has *two* sources below the block: the document's `defaults:` front matter
 * (level 3) and the embedder's configuration (level 4), with configuration
 * winning. Merging them here — shallowly, config over document — is what lets
 * `resolve()` pass one map to `cascadeAttrs` and still get the SPEC order.
 *
 * Shallow is correct at this level and only this level: both sides are
 * *defaults*, so a key present in configuration is a deliberate house-style
 * override of the whole attribute, not a patch to part of it.
 */
function documentDefaults(
  config: MdvConfig | undefined,
  doc: MdvDocument | undefined,
): Partial<BlockAttrs> {
  const front = doc?.frontmatter?.defaults;
  const fromDocument: Partial<BlockAttrs> =
    front !== undefined && typeof front === 'object' && !Array.isArray(front)
      ? (front as Partial<BlockAttrs>)
      : {};
  const fromConfig = config?.defaults ?? {};
  return { ...fromDocument, ...fromConfig };
}
