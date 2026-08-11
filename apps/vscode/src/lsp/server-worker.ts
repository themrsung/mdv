/**
 * The browser language server (SPEC 29.4), as a web worker.
 *
 * Bundled to `dist/web/server.js` and started by the extension host with the
 * settings payload in its script URL, because a worker has no argv. There is no
 * stderr here: `serveWorker`'s default logger sends `window/logMessage`, which
 * lands in the client's own output channel where a user can actually find it.
 */

import { serveWorker } from '@mdv/lsp';
import type { WorkerScopeLike } from '@mdv/lsp';
import { featureSettings, settingsFromQuery } from './settings.js';

/**
 * The worker global, narrowed to the parts that are used.
 *
 * `DedicatedWorkerGlobalScope` is not in this project's `lib` — the extension
 * is typed against the DOM, where `self` is a `Window` whose `postMessage` has
 * a different signature — so the shape is asserted here rather than pretended
 * to be inferred.
 */
const scope = globalThis as unknown as WorkerScopeLike & {
  readonly location: { readonly search: string };
};

serveWorker(scope, {
  settings: featureSettings(settingsFromQuery(scope.location.search)),
}).listen();
