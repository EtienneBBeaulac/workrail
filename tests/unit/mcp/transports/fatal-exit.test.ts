import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for fatal-exit.ts — last-resort error handler and startup observability.
 *
 * We test fatalExit and logStartup in isolation by importing after module reset.
 * process.exit is replaced with a throw so tests can assert without actually exiting.
 */

describe('fatalExit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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

describe('registerFatalHandlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Remove any handlers added by previous test runs
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
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
    expect(() =>
      process.emit('unhandledRejection', new Error('test'), Promise.reject()),
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
