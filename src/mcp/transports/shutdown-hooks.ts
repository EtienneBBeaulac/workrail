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

  /**
   * The writable stream to watch for I/O errors.
   *
   * When stdout encounters an error (e.g. EPIPE from a disconnected client),
   * any pending StdioServerTransport.send() Promises will hang forever:
   * the SDK registers once('drain', resolve) but has no rejection path.
   * Emitting 'drain' on error unblocks those Promises so shutdown is clean.
   *
   * Defaults to process.stdout. Inject a fake stream in tests to avoid
   * touching the real stdout descriptor.
   */
  readonly stdout?: NodeJS.WritableStream;
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

  // Unblock pending StdioServerTransport.send() Promises on stdout error.
  //
  // The MCP SDK's send() registers once('drain', resolve) when write() returns
  // false (backpressure). If EPIPE fires before drain, those Promises hang
  // forever -- there is no rejection path. Emitting 'drain' synchronously
  // BEFORE the shutdown event ensures all pending send() callers resolve before
  // the shutdown sequence begins. EventEmitter.emit() is synchronous, so the
  // ordering is deterministic.
  const stdout = opts.stdout ?? process.stdout;
  stdout.on('error', () => {
    stdout.emit('drain');
  });

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

export interface StdoutShutdownOptions {
  /**
   * Writable stream to watch for errors.
   *
   * Defaults to `process.stdout`. Inject a fake stream in tests to avoid
   * touching the real stdout descriptor.
   */
  readonly stdout?: NodeJS.WritableStream;
}

/**
 * Wire stdout-error shutdown for stdio transport.
 *
 * The MCP SDK's StdioServerTransport registers error listeners on stdin but
 * NOT on stdout. When the MCP client (Claude Code) closes the connection
 * mid-write, Node.js emits an 'error' event with code EPIPE on stdout. With
 * no listener, Node.js converts this to an uncaught exception and the process
 * crashes silently with exit code 1.
 *
 * This function registers an error listener that routes the failure through
 * the same clean shutdown path as SIGINT/SIGTERM instead of crashing.
 *
 * Must be called BEFORE server.connect(transport) so the handler is in place
 * before any writes can occur.
 */
export function wireStdoutShutdown(opts?: StdoutShutdownOptions): void {
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const stdout = opts?.stdout ?? process.stdout;

  stdout.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      // Pipe broken: MCP client disconnected. Initiate clean shutdown rather
      // than crashing -- this ensures the HTTP server and lock files are
      // cleaned up gracefully.
      console.error('[MCP] stdout pipe broken (client disconnected), initiating shutdown');
    } else {
      console.error('[MCP] stdout error:', err);
    }
    shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });
}

export interface StdinShutdownOptions {
  /**
   * Readable stream to watch for EOF.
   *
   * Defaults to `process.stdin`. Inject a fake stream in tests to avoid
   * touching the real stdin descriptor.
   */
  readonly stdin?: NodeJS.ReadableStream;
}

/**
 * Wire stdin-EOF shutdown for stdio transport.
 *
 * The MCP SDK's StdioServerTransport does not listen for stdin 'end',
 * so server.onclose never fires on disconnect. Without this, the session
 * HTTP server keeps the process alive after stdin EOF, blocking client restart.
 *
 * Accepts an optional `stdin` stream via `opts` so the dependency is
 * injectable in tests. Production callers pass nothing and get `process.stdin`.
 */
export function wireStdinShutdown(opts?: StdinShutdownOptions): void {
  const shutdownEvents = container.resolve<ShutdownEvents>(DI.Runtime.ShutdownEvents);
  const stdin = opts?.stdin ?? process.stdin;

  // stdin.once: the 'end' event fires at most once per stream lifetime.
  // Using once prevents listener accumulation if wireStdinShutdown() is ever
  // called more than once in the same process.
  stdin.once('end', () => {
    console.error('[MCP] stdin closed, initiating shutdown');
    shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });
}
