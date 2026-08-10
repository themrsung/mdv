/**
 * Constructing a {@link LayoutContext}.
 *
 * The context is the whole of layout's contact with the outside world (SPEC 21):
 * theme, metrics, locale, timezone, level, `buildTime`, ids, a11y options and a
 * diagnostic sink. If a layout algorithm needs something that is not on it, that
 * is a signal it is reaching for the host.
 *
 * Every default here is a *deterministic* default — `en-US`, `UTC`, the bundled
 * width table, and an epoch `buildTime` — so a caller that supplies nothing
 * still gets reproducible output rather than output that silently depends on
 * where it ran (SPEC 24.3 rules 2, 3 and 6).
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { Diagnostic } from '@mdv/parser';
import type { IdFactory, LayoutA11yOptions, LayoutContext, TextMetrics } from '../types/layout.js';
import type { ColorScheme, Theme } from '../types/theme.js';
import { defaultTableMetrics } from '../metrics/table-metrics.js';
import { createIdFactory } from './ids.js';

/**
 * The pinned default for `now()`.
 *
 * The Unix epoch, not the current time: SPEC 24.3 rule 2 forbids a wall-clock
 * read, and a default that changed every second would make every golden file
 * fail tomorrow. A real render passes `config.buildTime`.
 */
export const DEFAULT_BUILD_TIME = new Date(0);

/** Options for {@link makeLayoutContext}. */
export interface LayoutContextOptions {
  theme: Theme;
  /** Drives the id scheme `mdv-{blockIndex}-{counter}`. @defaultValue 0 */
  blockIndex?: number;
  /** @defaultValue the bundled `TableMetrics` */
  metrics?: TextMetrics;
  /** @defaultValue 'en-US' */
  locale?: string;
  /** @defaultValue 'UTC' */
  timezone?: string;
  /** @defaultValue 1 */
  level?: ConformanceLevel;
  /** @defaultValue {@link DEFAULT_BUILD_TIME} */
  buildTime?: Date;
  /** @defaultValue the theme's own scheme */
  colorScheme?: ColorScheme;
  a11y?: Partial<LayoutA11yOptions>;
  /** @defaultValue true */
  animate?: boolean;
  /** Supply one to share a counter across several blocks. */
  ids?: IdFactory;
  /** Where diagnostics go. Dropped when absent — layout still never throws. */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

/**
 * Build a layout context.
 *
 * Note: `@mdv/core`'s public `createLayoutContext(doc, block, onDiagnostic)`
 * (SPEC 21) is the document-level entry point and should delegate here once the
 * resolve stage exists — this function is the part that does not need a resolved
 * document, which is what makes a chart type unit-testable in isolation.
 */
export function makeLayoutContext(options: LayoutContextOptions): LayoutContext {
  const sink = options.onDiagnostic;
  return {
    theme: options.theme,
    colorScheme: options.colorScheme ?? options.theme.scheme,
    metrics: options.metrics ?? defaultTableMetrics,
    locale: options.locale ?? 'en-US',
    timezone: options.timezone ?? 'UTC',
    level: options.level ?? 1,
    buildTime: options.buildTime ?? DEFAULT_BUILD_TIME,
    ids: options.ids ?? createIdFactory(options.blockIndex ?? 0),
    a11y: {
      texture: options.a11y?.texture ?? false,
      tableView: options.a11y?.tableView ?? 'details',
      generateDesc: options.a11y?.generateDesc ?? true,
    },
    animate: options.animate ?? true,
    diagnostic(diagnostic: Diagnostic): void {
      sink?.(diagnostic);
    },
  };
}
