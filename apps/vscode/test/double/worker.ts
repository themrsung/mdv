/**
 * The web host's `Worker`, doubled (SPEC 29.4).
 *
 * `workerClientFactory` builds the language server's script URL and hands it to
 * the platform's `Worker` constructor. Node has no such global, and spinning a
 * real worker up is not what the web activation test is about — the URL is.
 * A worker has no argv, so the settings payload rides in that URL's query
 * string; if it ever stopped doing so the server would silently start with
 * defaults, which is exactly the failure this double is here to catch.
 *
 * Installed per test rather than at module load. A global that outlives the
 * test that needed it is how a desktop test starts passing for the wrong
 * reason.
 */

/** One `new Worker(...)`, as the web adapter made it. */
export interface WorkerRecord {
  /** The script URL, query string and all. */
  readonly url: string;
  /** Set by `terminate()`; the client wrapper calls it when a stop fails. */
  terminated: boolean;
}

const created: WorkerRecord[] = [];

/** Every worker the web adapter has constructed, oldest first. */
export const workers: readonly WorkerRecord[] = created;

class FakeWorker {
  readonly record: WorkerRecord;

  constructor(url: string | URL) {
    this.record = { url: String(url), terminated: false };
    created.push(this.record);
  }

  postMessage(): void {}

  addEventListener(): void {}

  removeEventListener(): void {}

  terminate(): void {
    this.record.terminated = true;
  }
}

/**
 * The record behind a worker the code under test is holding.
 *
 * The adapter passes the `Worker` itself to the client, so this is how a test
 * checks that the client was handed *that* worker rather than merely that some
 * worker was made.
 */
export function recordOf(worker: unknown): WorkerRecord | undefined {
  return worker instanceof FakeWorker ? worker.record : undefined;
}

type WorkerGlobal = { Worker?: unknown };

let saved: unknown;
let installed = false;

/** Put the double on `globalThis`, the way a browser host already has. */
export function installWorker(): void {
  if (installed) return;
  saved = (globalThis as WorkerGlobal).Worker;
  (globalThis as WorkerGlobal).Worker = FakeWorker;
  installed = true;
  created.length = 0;
}

/** Take it off again, and forget what it recorded. */
export function uninstallWorker(): void {
  if (!installed) return;
  if (saved === undefined) delete (globalThis as WorkerGlobal).Worker;
  else (globalThis as WorkerGlobal).Worker = saved;
  saved = undefined;
  installed = false;
  created.length = 0;
}
