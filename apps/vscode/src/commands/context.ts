/**
 * What every command handler is given.
 *
 * Bundling the extension's long-lived objects into one record keeps each command
 * module a set of plain functions — easy to read, and nothing reaches for a
 * module-level singleton.
 */

import type * as vscode from 'vscode';
import type { SettingsStore } from '../settings.js';
import type { PipelineStore } from '../documents.js';
import type { PreviewManager } from '../preview/manager.js';
import type { DiagnosticService } from '../diagnostics/index.js';
import type { HostCapabilities } from '../host.js';

export interface CommandContext {
  readonly extension: vscode.ExtensionContext;
  readonly settings: SettingsStore;
  readonly pipelines: PipelineStore;
  readonly previews: PreviewManager;
  readonly diagnostics: DiagnosticService;
  readonly host: HostCapabilities;
}
