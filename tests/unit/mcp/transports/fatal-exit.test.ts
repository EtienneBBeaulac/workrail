/**
 * Tests for fatal-exit.ts — last-resort error handler and startup observability.
 *
 * WHY os.homedir() is mocked:
 * `fatal-exit.ts` computes CRASH_LOG_PATH = join(homedir(), '.workrail', 'crash.log')
 * at module load time. Without this mock, every call to `fatalExit()` in tests would
 * write to the PRODUCTION crash log (~/.workrail/crash.log) — the same file the live
 * MCP server bridge reads to detect crashes. This would cause the bridge to lose
 * connection and die when tests run alongside a live WorkRail session.
 *
 * The mock redirects homedir() to a per-test temp directory so crash log writes are
 * isolated and automatically cleaned up. This follows the pattern established in
 * tests/unit/config/config-file.test.ts.
 *
 * WHY vi.resetModules() + dynamic import:
 * `fatal-exit.ts` has module-level state (fatalHandlerActive re-entrancy guard,
 * registeredTransport). vi.resetModules() forces a fresh module evaluation on each
 * dynamic import, resetting those guards between tests.
 *
 * WHY process listeners are cleaned up in afterEach:
 * registerFatalHandlers() attaches global process.on('uncaughtException') and
 * process.on('unhandledRejection') handlers. With vitest pool:threads, the global
 * process is shared across test files. Without cleanup, handlers from one test
 * accumulate and interfere with subsequent tests and other test files in the same
 * worker thread.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Redirect crash log writes to a per-test temp directory.
//
// fatal-exit.ts evaluates CRASH_LOG_PATH at module load time:
//   const CRASH_LOG_PATH = join(homedir(), '.workrail', 'crash.log')
//
// vi.mock is hoisted before any imports, so this mock is in place when the
// module is first evaluated. vi.resetModules() + dynamic await import() then
// forces re-evaluation on each test, picking up the current tmpHome value.
// ---------------------------------------------------------------------------

let tmpHome: string;

vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof os>();
  return {
    ...original,
    homedir: () => tmpHome ?? original.homedir(),
  };
});

describe('fatalExit', () => {
  beforeEach(() => {
    // Create a fresh temp dir for this test so crash log writes are isolated.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-fatal-test-'));
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Clean up the temp dir created for this test.
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes the error message and full stack trace to stderr then exits 1', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    const err = new Error('boom');
    expect(() => fatalExit('Uncaught exception', err)).toThrow('process.exit(1)');
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Uncaught exception'),
    );
    // Must include stack, not just message
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Error: boom'));
  });

  it('includes the full stack trace for Error instances', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    const err = new Error('stack test');
    try { fatalExit('label', err); } catch { /* exit mock */ }
    const written = vi.mocked(process.stderr.write).mock.calls[0]?.[0] as string;
    expect(written).toContain('at '); // stack frames start with "at "
  });

  it('handles non-Error thrown values (strings, objects)', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    expect(() => fatalExit('label', 'plain string error')).toThrow('process.exit(1)');
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('plain string error'),
    );
  });

  it('is re-entrant safe — second call is a no-op', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    try { fatalExit('first', new Error('first')); } catch { /* exit mock */ }
    expect(() => fatalExit('second', new Error('second'))).not.toThrow();
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
  });

  it('still exits even if stderr.write throws', async () => {
    vi.mocked(process.stderr.write).mockImplementation(() => { throw new Error('EBADF'); });
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    expect(() => fatalExit('label', new Error('test'))).toThrow('process.exit(1)');
  });
});

describe('registerGracefulShutdown', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-fatal-test-'));
    vi.resetModules();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
    // process.exit mock: record calls without actually exiting
    vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null | undefined) => {
      // intentional no-op in test
      return undefined as never;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('calls the registered shutdown fn before exiting', async () => {
    const { fatalExit, registerGracefulShutdown } = await import('../../../../src/mcp/transports/fatal-exit.js');
    let shutdownCalled = false;
    registerGracefulShutdown(async () => { shutdownCalled = true; });

    fatalExit('test', new Error('test'));

    // Advance fake timers to allow the Promise chain to resolve
    await vi.runAllTimersAsync();

    expect(shutdownCalled).toBe(true);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits after timeout if shutdown fn hangs', async () => {
    const { fatalExit, registerGracefulShutdown } = await import('../../../../src/mcp/transports/fatal-exit.js');
    // Register a fn that never resolves
    registerGracefulShutdown(async () => { await new Promise(() => { /* never */ }); }, 3000);

    fatalExit('test', new Error('test'));

    // Hard exit timer fires after 3000ms
    await vi.advanceTimersByTimeAsync(3000);

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits normally if no shutdown fn is registered', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    // No registerGracefulShutdown call — default behavior
    fatalExit('test', new Error('test'));

    // Synchronous exit path — no timers needed
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('registerGracefulShutdown(null) clears the registered fn', async () => {
    const { fatalExit, registerGracefulShutdown } = await import('../../../../src/mcp/transports/fatal-exit.js');
    let shutdownCalled = false;
    registerGracefulShutdown(async () => { shutdownCalled = true; });
    registerGracefulShutdown(null); // clear it

    fatalExit('test', new Error('test'));

    // Synchronous exit path used (no fn registered)
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(shutdownCalled).toBe(false);
  });

  it('handles a shutdown fn that throws synchronously', async () => {
    const { fatalExit, registerGracefulShutdown } = await import('../../../../src/mcp/transports/fatal-exit.js');
    registerGracefulShutdown(async () => { throw new Error('sync-ish throw'); });

    fatalExit('test', new Error('test'));

    await vi.runAllTimersAsync();

    // Must still exit despite the fn throwing
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('registerFatalHandlers', () => {
  beforeEach(() => {
    // Create a fresh temp dir for this test so crash log writes are isolated.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-fatal-test-'));
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Remove any handlers added by previous test runs before this test starts.
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  afterEach(() => {
    // Remove handlers added by this test so they don't leak into other tests
    // or other test files running in the same vitest worker thread (pool:threads).
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    // Clean up the temp dir created for this test.
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('registers handlers that exit on uncaughtException', async () => {
    const { registerFatalHandlers } = await import('../../../../src/mcp/transports/fatal-exit.js');
    registerFatalHandlers('stdio');
    expect(() =>
      process.emit('uncaughtException', new Error('test'), 'uncaughtException'),
    ).toThrow('exit');
  });

  it('registers handlers that exit on unhandledRejection', async () => {
    const { registerFatalHandlers } = await import('../../../../src/mcp/transports/fatal-exit.js');
    registerFatalHandlers('http');
    // Use a pre-rejected-and-caught promise to avoid a real unhandled rejection
    // in the Node.js event loop -- we only want to test that the registered handler
    // fires when process.emit('unhandledRejection') is called.
    const handledRejection = Promise.reject(new Error('test rejection'));
    handledRejection.catch(() => { /* suppress real unhandled rejection */ });
    expect(() =>
      process.emit('unhandledRejection', new Error('test'), handledRejection),
    ).toThrow('exit');
  });
});

describe('logStartup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('emits transport, pid, and version', async () => {
    const { logStartup } = await import('../../../../src/mcp/transports/fatal-exit.js');
    logStartup('stdio');
    const written = vi.mocked(process.stderr.write).mock.calls[0]?.[0] as string;
    expect(written).toContain('transport=stdio');
    expect(written).toContain(`pid=${process.pid}`);
    expect(written).toContain('version=');
    expect(written).toContain('[Startup]');
  });

  it('includes extra fields when provided', async () => {
    const { logStartup } = await import('../../../../src/mcp/transports/fatal-exit.js');
    logStartup('bridge', { primaryPort: 3100 });
    const written = vi.mocked(process.stderr.write).mock.calls[0]?.[0] as string;
    expect(written).toContain('primaryPort=3100');
  });

  it('emits http transport with port', async () => {
    const { logStartup } = await import('../../../../src/mcp/transports/fatal-exit.js');
    logStartup('http', { port: 3100 });
    const written = vi.mocked(process.stderr.write).mock.calls[0]?.[0] as string;
    expect(written).toContain('transport=http');
    expect(written).toContain('port=3100');
  });
});
