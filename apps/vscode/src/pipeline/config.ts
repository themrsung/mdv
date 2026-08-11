/**
 * The `MdvConfig` every consumer in this extension resolves under.
 *
 * Three of them exist now — the preview's pipeline, the PDF exporter, and the
 * language server of SPEC 29.4 — and the only way a document can be *valid on
 * screen and invalid in the problem list* is for two of them to have been
 * handed different configurations. So there is one builder, and its inputs are
 * exactly the four settings that change an answer:
 *
 * | Input | Setting | What it decides |
 * |---|---|---|
 * | `level` | `mdv.validate.level` | the SPEC 16.1 conformance level |
 * | `strict` | `mdv.validate.strict` | whether warnings are errors (SPEC 14.3) |
 * | `allowExternal` | `mdv.security.allowExternal` | whether a remote `src:` can load at all |
 * | `allowedOrigins` | `mdv.security.allowedOrigins` | which ones, when it can |
 *
 * The plugin is here for the same reason: `plugins` is what decides which chart
 * types exist, and a server that resolved a document without the built-ins
 * would report `MDV3001` for every block in it.
 */

import type { MdvConfig, MdvPlugin } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';
import { listBuiltinThemes } from '@mdv/themes';

import { capabilitiesFor } from './capabilities.js';

/** Reported as the plugin that carried the built-ins into core. */
const EXTENSION_VERSION = '0.0.0';

/**
 * The plugin that carries the built-in chart types and themes into core.
 *
 * The same set `registry.ts` seeds its frozen registry with, which is what
 * makes a chart type that renders in the preview also *exist* for a feature
 * that reaches core through a config instead.
 */
export function builtinsPlugin(): MdvPlugin {
  return {
    name: 'mdv-vscode builtins',
    version: EXTENSION_VERSION,
    chartTypes: builtinChartTypes,
    themes: listBuiltinThemes(),
  };
}

/** The settings a configuration is built from; {@link PipelineInputs} has them all. */
export interface ConfigInputs {
  /** SPEC 16.1 conformance level; `mdv.validate.level`. */
  readonly level: 1 | 2 | 3;
  /** SPEC 14.3: promotes warnings to errors. `mdv.validate.strict`. */
  readonly strict: boolean;
  /** `mdv.security.allowExternal`. */
  readonly allowExternal: boolean;
  /** `mdv.security.allowedOrigins`. */
  readonly allowedOrigins: readonly string[];
}

/**
 * The configuration for a run.
 *
 * With `mdv.security.allowExternal` off there is no `fetch` capability in the
 * config at all, and `@mdv/core` refuses every remote `src:` with `MDV4002`
 * (SPEC 25.2) rather than reaching the network because this particular caller
 * happened to be an export or a language server.
 */
export function mdvConfig(inputs: ConfigInputs): MdvConfig {
  return {
    plugins: [builtinsPlugin()],
    capabilities: capabilitiesFor(inputs.allowExternal),
    level: inputs.level,
    security: {
      allowExternal: inputs.allowExternal,
      allowedOrigins: [...inputs.allowedOrigins],
    },
    // Absent rather than `false`: `exactOptionalPropertyTypes` makes the two
    // different values, and the default is what SPEC 14.3 is written against.
    ...(inputs.strict ? { strict: true } : {}),
  };
}
