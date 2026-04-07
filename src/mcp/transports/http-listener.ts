/**
 * Minimal HTTP listener for MCP transport.
 * 
 * Deliberately minimal — no port negotiation, no lock files, no heartbeats.
 * Those belong in dashboard infrastructure, not MCP foundation.
 * 
 * Philosophy:
 * - Keep interfaces small and focused
 * - Fail fast on port conflict (no graceful fallback)
 * - Interface segregation: HttpListener is separate from dashboard HttpServer
 * - Make illegal states unrepresentable (explicit ServerState)
 * - Control flow from data state (decisions driven by state, not error messages)
 */

import express, { type Application } from 'express';
import { createServer, type Server as HttpServerType } from 'http';

/**
 * Server lifecycle state.
 * 
 * Discriminated union ensures:
 * - Can't call server.close() when no server exists
 * - Can't call server.listen() twice
 * - stop() is naturally idempotent (not_started and stopped both do nothing)
 */
type ServerState =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'running'; readonly server: HttpServerType; readonly boundPort: number }
  | { readonly kind: 'stopped' };

export interface HttpListener {
  readonly app: Application;
  readonly requestedPort: number;
  getBoundPort(): number | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create a minimal HTTP listener for MCP transport.
 *
 * No middleware by default -- caller mounts MCP handlers.
 * No CORS -- bot service is expected to be same-origin or handle CORS externally.
 *
 * Fail-fast on port conflict: throws immediately, no fallback.
 * Supports ephemeral ports: requestedPort=0 lets OS assign a port;
 * getBoundPort() returns the actual bound port after start().
 */
export function createHttpListener(requestedPort: number): HttpListener {
  const app = express();
  let state: ServerState = { kind: 'not_started' };

  return {
    app,
    requestedPort,

    getBoundPort(): number | null {
      return state.kind === 'running' ? state.boundPort : null;
    },

    async start(): Promise<void> {
      if (state.kind === 'running') {
        throw new Error('[HttpListener] Already started');
      }

      if (state.kind === 'stopped') {
        throw new Error('[HttpListener] Cannot restart a stopped listener');
      }

      return new Promise<void>((resolve, reject) => {
        const server = createServer(app);

        server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(
              `[HttpListener] Port ${requestedPort} is already in use. ` +
              `Set WORKRAIL_HTTP_PORT to a different port or stop the conflicting process.`
            ));
          } else {
            reject(err);
          }
        });

        server.listen(requestedPort, () => {
          const addr = server.address();
          const boundPort = addr && typeof addr === 'object' ? addr.port : requestedPort;

          state = { kind: 'running', server, boundPort };
          console.error(`[HttpListener] MCP HTTP transport listening on port ${boundPort}`);
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      // Idempotent: stopping a non-running server is a no-op
      if (state.kind !== 'running') {
        return;
      }

      const serverToClose = state.server;
      return new Promise<void>((resolve, reject) => {
        serverToClose.close((err) => {
          if (err) {
            reject(err);
          } else {
            state = { kind: 'stopped' };
            console.error(`[HttpListener] MCP HTTP transport stopped`);
            resolve();
          }
        });
      });
    },
  };
}

/**
 * Scan ports [startPort, endPort] and return the first HttpListener that binds
 * successfully.
 *
 * WHY this lives here (not in http-entry.ts): the function only depends on
 * `createHttpListener`, so it belongs in this module. Keeping it here lets
 * tests import it without pulling in the full `composeServer` / DI stack.
 *
 * The returned listener is already started. Callers must call stop() on it
 * when they are done, as usual.
 *
 * Throws if no port in the range is available.
 */
export async function bindWithPortFallback(
  startPort: number,
  endPort: number
): Promise<HttpListener> {
  let lastError: Error | undefined;

  for (let port = startPort; port <= endPort; port++) {
    const listener = createHttpListener(port);
    try {
      await listener.start();
      if (port !== startPort) {
        console.error(
          `[HttpListener] Port ${startPort} unavailable; bound to fallback port ${port}`
        );
      }
      return listener;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (
        nodeErr.code === 'EADDRINUSE' ||
        (err instanceof Error && err.message.includes('already in use'))
      ) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      // Non-EADDRINUSE error: propagate immediately (unexpected failure)
      throw err;
    }
  }

  throw new Error(
    `[HttpListener] No available port in range ${startPort}-${endPort}. ` +
    `Last error: ${lastError?.message}`
  );
}
