/**
 * One {@link DocumentPipeline} per open MDV document, shared by every consumer.
 *
 * The preview and the diagnostics engine both want "the current state of this
 * document". If each kept its own pipeline, a keystroke would parse the document
 * twice and resolve its datasets twice — and, worse, the squiggles and the
 * picture could come from two different parses. One store, keyed by URI, keeps
 * them in step and halves the work.
 *
 * Entries are dropped when the document closes, so the store cannot grow without
 * bound over a long session.
 */

import * as vscode from 'vscode';
import { DocumentPipeline } from './pipeline/index.js';

/** The language ids this extension handles (SPEC 29.1). */
export const MDV_LANGUAGE = 'mdv';
export const MARKDOWN_LANGUAGE = 'markdown';

/** `true` for a document the extension should process. */
export function isMdvDocument(document: vscode.TextDocument): boolean {
  if (document.languageId === MDV_LANGUAGE) return true;
  // SPEC 29.1: `.md` files containing `mdv` fences activate the extension too.
  return document.languageId === MARKDOWN_LANGUAGE && document.uri.path.endsWith('.mdv');
}

/** `true` for a Markdown document that actually contains an MDV block. */
export function markdownHasMdvBlock(document: vscode.TextDocument): boolean {
  if (document.languageId !== MARKDOWN_LANGUAGE) return false;
  // A cheap pre-filter, not a parse: the real answer comes from the pipeline.
  return /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mdv\b/m.test(document.getText());
}

/** `true` when a preview or diagnostics make sense for this document. */
export function isPreviewable(document: vscode.TextDocument): boolean {
  return isMdvDocument(document) || markdownHasMdvBlock(document);
}

/** The per-URI pipeline store. */
export class PipelineStore implements vscode.Disposable {
  readonly #pipelines = new Map<string, DocumentPipeline>();
  readonly #subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.#subscriptions.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.#pipelines.delete(document.uri.toString());
      }),
    );
  }

  /** The pipeline for `uri`, created on first use. */
  get(uri: vscode.Uri): DocumentPipeline {
    const key = uri.toString();
    let pipeline = this.#pipelines.get(key);
    if (pipeline === undefined) {
      pipeline = new DocumentPipeline();
      this.#pipelines.set(key, pipeline);
    }
    return pipeline;
  }

  /**
   * Drop every memo in every pipeline.
   *
   * Needed when something *outside* the document changes the output: the editor
   * colour theme, or a settings value the per-block cache key does not carry.
   */
  invalidateAll(): void {
    for (const pipeline of this.#pipelines.values()) pipeline.invalidate();
  }

  dispose(): void {
    for (const item of this.#subscriptions) item.dispose();
    this.#subscriptions.length = 0;
    this.#pipelines.clear();
  }
}
