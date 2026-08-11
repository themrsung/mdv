/**
 * Starting the server, for the two hosts SPEC 29.4 names: stdio in a desktop
 * editor, a port in a browser worker.
 *
 * `createServer` takes a transport and a list of features, `mdvFeatures` is the
 * list, and the transports are one call each — so what is left for a host to
 * write is short, and every line of it is a place to be subtly wrong. Where a
 * log line goes when stdout is the protocol. What an `exit` notification is
 * supposed to do to the process it arrived in. Whether the worker keeps running
 * after the client has gone. Those answers are the same for every host that
 * speaks each transport, so they are written once, here.
 *
 * Nothing in this file reads a global: the desktop entry hands over its
 * `process` and the browser entry hands over its `self`, which is what keeps
 * this package free of `node:*` and of the DOM, and what makes both paths
 * testable with a fake in a plain Node test.
 */

import { mdvFeatures, type MdvFeatureSettings } from './preset.js';
import { MessageType } from './protocol/types.js';
import { SERVER_NAME, createServer, logToClient } from './server.js';
import type { Logger, MdvServer, ServerOptions } from './server.js';
import type { MessageConnection } from './protocol/connection.js';
import type { MessageTransport } from './protocol/jsonrpc.js';
import { portTransport, type MessagePortLike } from './transport/port.js';
import { streamTransport, type ByteSink, type ByteSource } from './transport/stream.js';

/**
 * {@link ServerOptions} with the feature list replaced by what configures it.
 *
 * A host that reaches for `features` wants {@link createServer} instead: the
 * point of this module is that the set is not a host's decision, only its
 * settings are.
 */
export interface ServeOptions extends Omit<ServerOptions, 'features'> {
  readonly settings?: MdvFeatureSettings;
}

/** The whole feature set over a transport the caller already has. */
export function serve(transport: MessageTransport, options: ServeOptions = {}): MdvServer {
  const { settings, ...server } = options;
  return createServer(transport, { ...server, features: mdvFeatures(settings) });
}

/**
 * The shape of `process` this server uses, and nothing else of it.
 *
 * `exit` is optional because a host that embeds the server in a process it did
 * not start — a test, a supervisor running several — must be able to hear the
 * client leave without the whole process going down with it.
 */
export interface StdioHost {
  readonly stdin: ByteSource;
  readonly stdout: ByteSink;
  readonly stderr?: { write(chunk: string): unknown };
  exit?(code: number): void;
}

/**
 * Serve one client over stdio.
 *
 * Two things a desktop host would otherwise have to know: **stdout is the
 * protocol**, so the default logger writes to stderr and a missing stderr makes
 * logging silent rather than corrupting a frame; and `exit` means exit, with
 * LSP's own convention that a shutdown asked for is 0 and a client that
 * vanished is 1 — a supervisor reads the difference.
 */
export function serveStdio(host: StdioHost, options: ServeOptions = {}): MdvServer {
  const stderr = host.stderr;
  const logger: Logger = options.logger ?? {
    info: (message) => void stderr?.write(`[${SERVER_NAME}] ${message}\n`),
    error: (message) => void stderr?.write(`[${SERVER_NAME}] error: ${message}\n`),
  };
  return serve(streamTransport(host.stdin, host.stdout), {
    ...options,
    logger,
    onExit: (code) => {
      // The host's own hook first: `exit` does not return, so anything after it
      // would never run.
      options.onExit?.(code);
      host.exit?.(code);
    },
  });
}

/**
 * The worker global as this server uses it: a port to talk over, and a way to
 * stop. `DedicatedWorkerGlobalScope` satisfies it, as does a `MessagePort` for
 * a host that runs the server somewhere other than a worker's top level.
 */
export interface WorkerScopeLike extends MessagePortLike {
  close?(): void;
}

/**
 * Serve one client over a worker port.
 *
 * There is no stderr here and `console` output lands in a devtools panel the
 * user will never open, so the default logger sends `window/logMessage` — the
 * client's own output channel, which is where a browser host's log belongs and
 * the only channel that survives the page being somebody else's.
 */
export function serveWorker(scope: WorkerScopeLike, options: ServeOptions = {}): MdvServer {
  // The logger is needed to build the server and can only speak through the
  // connection the server owns, so one of the two has to learn about the other
  // late. It is held in a box rather than a variable so that the closures below
  // read whatever is there when they run, which is after this function returns.
  const channel: { connection?: MessageConnection } = {};
  const logger: Logger = options.logger ?? {
    info: (message) => {
      if (channel.connection) logToClient(channel.connection, MessageType.log, message);
    },
    error: (message) => {
      if (channel.connection) logToClient(channel.connection, MessageType.error, message);
    },
  };
  const server = serve(portTransport(scope), {
    ...options,
    logger,
    onExit: (code) => {
      options.onExit?.(code);
      // A worker whose client has gone is a live thread holding a document
      // store nobody can reach.
      scope.close?.();
    },
  });
  channel.connection = server.connection;
  return server;
}
