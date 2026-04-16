/**
 * Last-resort fatal exit for all MCP transport entry points.
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
 */

const fatalHandlerActive = { value: false };

/**
 * Format an unknown thrown value into a human-readable string that includes
 * the stack trace when available.
 */
function formatFatal(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

/**
 * Write a fatal error message to stderr and exit with code 1.
 * Re-entrant calls (e.g. if stderr.write itself throws) are silently ignored.
 */
export function fatalExit(label: string, reason: unknown): void {
  if (fatalHandlerActive.value) return;
  fatalHandlerActive.value = true;
  try {
    process.stderr.write(`[MCP] ${label}: ${formatFatal(reason)}\n`);
  } catch {
    // stderr itself failed — nothing we can do, just exit
  }
  process.exit(1);
}

/**
 * Register uncaughtException and unhandledRejection handlers that call
 * fatalExit. Safe to call in any transport entry point.
 *
 * Must be called early — before any async work — so that exceptions thrown
 * during startup (e.g. in composeServer()) are caught and the process exits
 * cleanly rather than spinning in an infinite loop.
 */
export function registerFatalHandlers(): void {
  process.on('uncaughtException', (err) => fatalExit('Uncaught exception', err));
  process.on('unhandledRejection', (reason) => fatalExit('Unhandled promise rejection', reason));
}
