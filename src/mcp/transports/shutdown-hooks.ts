/**
 * Shared shutdown wiring for transport entry points.
 *
 * Encapsulates the common pattern: register signal handlers, guard against
 * double-shutdown, run async teardown, then terminate the process.
 *
 * Transport-specific cleanup (e.g. stopping an HTTP listener, watching stdin)
 * is injected via `onBeforeTerminate`.
 *
 * Also handles stream I/O error recovery (stdout drain unblocking) as part of
 * clean shutdown prerequisites. wireShutdownHooks owns this because it is the
 * canonical point for "things that must happen before the process can exit
 * cleanly" -- both signal-based shutdown and stream-error recovery belong here.
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
  //
  // Known limitation: if SIGTERM fires while write() is under backpressure but
  // before any EPIPE error, this drain emission does not trigger. Those
  // send() Promises still hang until process.exit() is called at the end of
  // the shutdown sequence. Fixing this requires the SDK to add a rejection
  // path to send(), which is out of scope here.
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
        // WHY process.stderr.write: see wireStdoutShutdown for full explanation.
        // Shutdown handlers fire when the connection is closing -- stderr may be
        // a broken pipe at this point, so console.error would throw a second EPIPE.
        try { process.stderr.write(`[Shutdown] Requested by ${event.signal}. Stopping services...\n`); } catch { /* ignore */ }
        await opts.onBeforeTerminate();
        terminator.terminate({ kind: 'success' });
      } catch (err) {
        try { process.stderr.write(`[Shutdown] Error while stopping services: ${(err as Error)?.stack ?? String(err)}\n`); } catch { /* ignore */ }
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
    // WHY process.stderr.write with try/catch instead of console.error:
    // In an MCP stdio process, process.stderr is a Socket pipe to the host.
    // When the client closes the connection, both stdout AND stderr break.
    // console.error() calls console.value() internally which does a synchronous
    // socket write -- if stderr is also broken it throws a second EPIPE with no
    // handler, crashing the process. process.stderr.write() wrapped in try/catch
    // absorbs that failure safely. See fatal-exit.ts for the canonical explanation.
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      // Pipe broken: MCP client disconnected. Initiate clean shutdown rather
      // than crashing -- this ensures the HTTP server and lock files are
      // cleaned up gracefully.
      try { process.stderr.write('[MCP] stdout pipe broken (client disconnected), initiating shutdown\n'); } catch { /* ignore */ }
    } else {
      try { process.stderr.write(`[MCP] stdout error: ${(err as Error).message}\n`); } catch { /* ignore */ }
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
    // WHY process.stderr.write: see wireStdoutShutdown for full explanation.
    // stdin 'end' fires on client disconnect -- stderr may be broken at this point.
    try { process.stderr.write('[MCP] stdin closed, initiating shutdown\n'); } catch { /* ignore */ }
    shutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });
}
