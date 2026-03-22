/**
 * Shared shutdown wiring for transport entry points.
 *
 * Encapsulates the common pattern: register signal handlers, guard against
 * double-shutdown, run async teardown, then terminate the process.
 *
 * Transport-specific cleanup (e.g. stopping an HTTP listener, watching stdin)
 * is injected via `onBeforeTerminate`.
 */

import { container } from '../../di/container.js';
import { DI } from '../../di/tokens.js';
import type { ShutdownEvents } from '../../runtime/ports/shutdown-events.js';
import type { ProcessSignals } from '../../runtime/ports/process-signals.js';
import type { ProcessTerminator } from '../../runtime/ports/process-terminator.js';

export interface ShutdownHookOptions {
  /** Transport-specific teardown (stop listeners, close connections, etc.). */
  readonly onBeforeTerminate: () => Promise<void>;
}

/**
 * Wire standard shutdown hooks for a long-running transport process.
 *
 * Registers SIGINT / SIGTERM / SIGHUP handlers, guards against
 * double-invocation, and calls the transport-specific `onBeforeTerminate`
 * before terminating the process.
 */
export function wireShutdownHooks(opts: ShutdownHookOptions): void {
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const processSignals = container.resolve<ProcessSignals>(DI.Runtime.ProcessSignals);
  const terminator = container.resolve<ProcessTerminator>(DI.Runtime.ProcessTerminator);

  // Signal handlers: standard for long-running processes
  processSignals.on('SIGINT', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' }));
  processSignals.on('SIGTERM', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' }));
  processSignals.on('SIGHUP', () => shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' }));

  // Shutdown handler — guarded against double-invocation
  let shutdownStarted = false;
  shutdownEvents.onShutdown((event) => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    void (async () => {
      try {
        console.error(`[Shutdown] Requested by ${event.signal}. Stopping services...`);
        await opts.onBeforeTerminate();
        terminator.terminate({ kind: 'success' });
      } catch (err) {
        console.error('[Shutdown] Error while stopping services:', err);
        terminator.terminate({ kind: 'failure' });
      }
    })();
  });
}

/**
 * Wire stdin-EOF shutdown for stdio transport.
 *
 * The MCP SDK's StdioServerTransport does not listen for stdin 'end',
 * so server.onclose never fires on disconnect. Without this, the session
 * HTTP server keeps the process alive after stdin EOF, blocking client restart.
 */
export function wireStdinShutdown(): void {
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);

  process.stdin.on('end', () => {
    console.error('[MCP] stdin closed, initiating shutdown');
    shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });
}
