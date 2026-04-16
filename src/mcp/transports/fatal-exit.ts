/**
 * Last-resort fatal exit and observability for all MCP transport entry points.
 *
 * WHY process.stderr.write instead of console.error:
 * The V8 inspector hooks console.* calls. If the inspector itself has a
 * bug or triggers re-entrant JS (e.g. an uncaughtException thrown inside
 * a console.error call), the uncaughtException handler fires again, which
 * calls console.error again — infinite loop at 100% CPU. process.stderr.write
 * is a raw libuv syscall with no JS re-entrancy risk.
 *
 * WHY err.stack instead of String(err):
 * String(Error) gives only the message. err.stack includes the full call
 * chain, which is the only way to diagnose what actually went wrong.
 *
 * WHY a re-entrancy guard:
 * If process.stderr.write itself throws (e.g. EBADF), the uncaughtException
 * handler would fire again and loop. The guard ensures we exit on the first
 * invocation no matter what.
 *
 * CRASH LOG:
 * On fatal exit, a structured JSON entry is appended synchronously to
 * ~/.workrail/crash.log. Survives process death because the write is sync.
 * Useful for diagnosing why the primary or a bridge died.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportKind = 'stdio' | 'http' | 'bridge';

// ---------------------------------------------------------------------------
// Module-level state — intentionally mutable (last-resort handlers)
//
// These variables are module-scoped singletons. Mutability is acceptable here
// because last-resort exit handlers cannot use immutable patterns — they are
// the safety net that runs when all other invariants have already been violated.
//
// gracefulShutdownFn: optional async cleanup registered by transport entry
// points. Called with a hard timeout before process.exit(1) on fatal exit.
// Use registerGracefulShutdown(fn) to set, registerGracefulShutdown(null) to
// clear (useful for test isolation). Bridge processes do not register — they
// have their own performShutdown() path.
// ---------------------------------------------------------------------------

const fatalHandlerActive = { value: false };
let registeredTransport: TransportKind | null = null;
const startedAtMs = Date.now();

// Graceful shutdown — set by transport entry points after composing the server.
// null means no cleanup is registered (default).
let gracefulShutdownFn: (() => Promise<void>) | null = null;
let gracefulShutdownTimeoutMs = 3000;

// ---------------------------------------------------------------------------
// Crash log
// ---------------------------------------------------------------------------

const CRASH_LOG_PATH = join(homedir(), '.workrail', 'crash.log');
const CRASH_LOG_MAX_BYTES = 512 * 1024; // 512 KB — rotate at this size

/**
 * Synchronously append a crash entry to ~/.workrail/crash.log.
 * Uses sync I/O so it completes before process.exit(1) is called.
 * Silently no-ops if the write fails — we're already crashing.
 */
function writeCrashLog(label: string, reason: unknown): void {
  try {
    mkdirSync(join(homedir(), '.workrail'), { recursive: true });

    // Rotate if oversized — truncate to empty so the file doesn't grow forever
    try {
      const { statSync } = require('fs') as typeof import('fs');
      const stat = statSync(CRASH_LOG_PATH);
      if (stat.size > CRASH_LOG_MAX_BYTES) {
        writeFileSync(CRASH_LOG_PATH, '');
      }
    } catch {
      // File doesn't exist yet — that's fine
    }

    const entry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,       // which process spawned us — identifies orphans
      cwd: process.cwd(),       // which project/worktree this process belongs to
      transport: registeredTransport ?? 'unknown',
      uptimeMs: Date.now() - startedAtMs,
      label,
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? (reason.stack ?? null) : null,
    };

    writeFileSync(CRASH_LOG_PATH, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch {
    // Crash log write failed — silently ignore, we're exiting anyway
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format an unknown thrown value into a human-readable string that includes
 * the stack trace when available.
 */
export function formatFatal(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

// ---------------------------------------------------------------------------
// Fatal exit
// ---------------------------------------------------------------------------

/**
 * Register an async cleanup function to call before process.exit(1) on fatal
 * exit. The function is called with a hard timeout: if it does not complete
 * within `timeoutMs` milliseconds, process.exit(1) fires regardless.
 *
 * Call with `null` to clear the registered function (useful for test isolation).
 *
 * Intended for transport entry points (stdio, http) to register their HTTP
 * server teardown. Bridge processes should NOT call this — they have their own
 * performShutdown() path that closes the primary connection before exit.
 *
 * @param fn       Async cleanup function, or null to clear.
 * @param timeoutMs  Hard exit timeout in ms. Defaults to 3000ms.
 *                   Must be less than HttpServer's own 5s close timeout to be
 *                   meaningful; 3s gives the shutdown fn a real opportunity.
 */
export function registerGracefulShutdown(
  fn: (() => Promise<void>) | null,
  timeoutMs = 3000,
): void {
  gracefulShutdownFn = fn;
  gracefulShutdownTimeoutMs = timeoutMs;
}

/**
 * Write a fatal error message to stderr and crash.log, then exit with code 1.
 * Re-entrant calls (e.g. if stderr.write itself throws) are silently ignored.
 *
 * If a graceful shutdown function has been registered via registerGracefulShutdown(),
 * it is called before exit with a hard timeout. The sync crash log write and
 * stderr write always happen first — they survive even if the async path hangs.
 */
export function fatalExit(label: string, reason: unknown): void {
  if (fatalHandlerActive.value) return;
  fatalHandlerActive.value = true;

  // Sync writes first — these must complete before any async work begins.
  // They survive process death even if the graceful shutdown path hangs.
  writeCrashLog(label, reason);

  try {
    process.stderr.write(`[MCP] ${label}: ${formatFatal(reason)}\n`);
  } catch {
    // stderr itself failed — nothing we can do, just exit
  }

  if (gracefulShutdownFn !== null) {
    // Attempt graceful shutdown with a hard exit timeout.
    //
    // WHY dual-path (setTimeout + Promise.then) instead of Promise.race():
    // The dual-path is easier to reason about and makes the clearTimeout +
    // process.exit(1) sequencing explicit. Whichever path completes first
    // (graceful fn or timeout), the other is cancelled.
    //
    // WHY Promise.resolve().then(() => fn()):
    // A bare fn() call that throws synchronously would escape the .catch()
    // handler. Wrapping in .then() converts sync throws to rejected promises
    // so .catch() handles them correctly.
    const fn = gracefulShutdownFn;
    const timeout = gracefulShutdownTimeoutMs;
    try {
      process.stderr.write(`[FatalExit] Attempting graceful shutdown (${timeout}ms timeout)\n`);
    } catch {
      // ignore
    }
    const hardExit = setTimeout(() => process.exit(1), timeout);
    void Promise.resolve()
      .then(() => fn())
      .catch(() => { /* shutdown errors must not block exit — we're already crashing */ })
      .finally(() => {
        clearTimeout(hardExit);
        process.exit(1);
      });
  } else {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register uncaughtException and unhandledRejection handlers that call
 * fatalExit. Safe to call in any transport entry point.
 *
 * Must be called early — before any async work — so that exceptions thrown
 * during startup (e.g. in composeServer()) are caught and the process exits
 * cleanly rather than spinning in an infinite loop.
 *
 * @param transport  Which transport this process is running as. Used in
 *                   crash log entries and startup observability output.
 */
export function registerFatalHandlers(transport: TransportKind): void {
  registeredTransport = transport;
  process.on('uncaughtException', (err) => fatalExit('Uncaught exception', err));
  process.on('unhandledRejection', (reason) => fatalExit('Unhandled promise rejection', reason));
}

// ---------------------------------------------------------------------------
// Startup observability
// ---------------------------------------------------------------------------

/**
 * Emit a structured startup line to stderr so every process start is
 * visible in logs. Format is parseable but also human-readable.
 *
 * Example:
 *   [Startup] transport=stdio pid=12345 version=3.24.4
 */
export function logStartup(transport: TransportKind, extra?: Record<string, string | number>): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const version = (() => {
    try {
      return (require('../../package.json') as { version: string }).version;
    } catch {
      return 'unknown';
    }
  })();

  const parts = [
    `[Startup] transport=${transport}`,
    `pid=${process.pid}`,
    `version=${version}`,
    ...(extra ? Object.entries(extra).map(([k, v]) => `${k}=${v}`) : []),
  ];
  process.stderr.write(parts.join(' ') + '\n');
}
