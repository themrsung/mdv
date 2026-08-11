/**
 * The desktop language server (SPEC 29.4), as a process.
 *
 * Bundled to `dist/server.cjs` and spawned by the extension host with the
 * settings payload `lsp/settings.ts` writes. Nothing in this file is imported
 * by the extension: it is an entry point, and the only thing it does is wire
 * this host's three streams to `@mdv/lsp` and start listening.
 *
 * `stdout` is the protocol and `stderr` is the log — the split `serveStdio`
 * exists to keep, and the reason no `console.log` may ever appear in this tree.
 *
 * The `.cjs` extension is load-bearing. This bundle is CommonJS, but the
 * package is `"type": "module"`, and unlike `dist/extension.js` — which the
 * extension host loads through its own CommonJS loader — the server is a real
 * node process, so node's own resolution applies and a `.js` name would be
 * read as ESM and die on the first `require`.
 */

import { serveStdio } from '@mdv/lsp';
import { featureSettings, settingsFromArgv } from './settings.js';

serveStdio(
  {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
  },
  { settings: featureSettings(settingsFromArgv(process.argv.slice(2))) },
).listen();
