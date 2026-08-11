/**
 * Every feature SPEC 29.4 lists, in the order it lists them.
 *
 * ```ts
 * createServer(streamTransport(process.stdin, process.stdout), {
 *   features: mdvFeatures({ config }),
 * }).listen();
 * ```
 *
 * `createServer` takes features as an argument and installs whatever it is
 * given, which is right for a test that wants one of them and wrong for a host
 * that wants all of them: a desktop editor and a browser worker copying the
 * same list would drift, and the day one of them is a feature short the symptom
 * is a capability quietly missing from a handshake. The list belongs somewhere
 * both of them can point at, and it is not `server.ts` — that file knows what a
 * feature is and nothing about which ones exist, which is why installing a
 * thirteenth does not touch it.
 *
 * Settings are flat rather than a slot per feature, because the four keys below
 * do not collide and a host's own configuration is flat too. Each is the field
 * from the feature that owns it, picked from that feature's own type so the two
 * cannot drift apart.
 */

import { codeActions } from './features/code-actions.js';
import { codeLens } from './features/code-lens.js';
import type { CodeLensSettings } from './features/code-lens.js';
import { completion } from './features/completion.js';
import { definition } from './features/definition.js';
import { diagnostics } from './features/diagnostics.js';
import type { DiagnosticsOptions } from './features/diagnostics.js';
import { formatting } from './features/formatting.js';
import type { FormatterOptions } from './features/formatting.js';
import { hover } from './features/hover.js';
import { inlay } from './features/inlay.js';
import { rename } from './features/rename.js';
import { semanticTokens } from './features/semantic-tokens.js';
import { signature } from './features/signature.js';
import type { BlockSettings } from './features/site.js';
import { symbols } from './features/symbols.js';
import type { Feature } from './server.js';

/**
 * What a host configures across the whole feature set.
 *
 * {@link BlockSettings.config} is the one every feature that runs the pipeline
 * wants, which is why it is shared here rather than repeated twelve times at
 * the call site. The rest belong to a single feature each: `commands` to the
 * lenses (SPEC 29.5), `format` to formatting, `debounceMs` and `schedule` to
 * diagnostics.
 */
export interface MdvFeatureSettings
  extends
    BlockSettings,
    Pick<CodeLensSettings, 'commands'>,
    Pick<FormatterOptions, 'format'>,
    Pick<DiagnosticsOptions, 'debounceMs' | 'schedule'> {}

/**
 * The feature set, ready for a server's `features` option.
 *
 * The order is SPEC 29.4's table, top to bottom, so the two can be read side by
 * side. Nothing depends on it: features share a document store and a
 * connection, and no two of them answer the same request or claim the same
 * capability.
 */
export function mdvFeatures(settings: MdvFeatureSettings = {}): readonly Feature[] {
  // Rebuilt rather than spread wholesale, because `exactOptionalPropertyTypes`
  // makes `{ config: undefined }` a different thing from an absent `config`,
  // and the second is what a feature's defaults are written against.
  const block: BlockSettings = settings.config === undefined ? {} : { config: settings.config };
  return [
    diagnostics({
      ...block,
      ...(settings.debounceMs === undefined ? {} : { debounceMs: settings.debounceMs }),
      ...(settings.schedule === undefined ? {} : { schedule: settings.schedule }),
    }),
    completion(block),
    hover(block),
    signature(block),
    codeActions(block),
    formatting(settings.format === undefined ? {} : { format: settings.format }),
    symbols(),
    definition(block),
    rename(block),
    inlay(block),
    codeLens(settings.commands === undefined ? {} : { commands: settings.commands }),
    semanticTokens(),
  ];
}
