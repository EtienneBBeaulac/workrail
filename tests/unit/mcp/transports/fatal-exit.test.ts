import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for fatal-exit.ts — last-resort error handler for all transport entry points.
 *
 * We test fatalExit in isolation by importing it after resetting module state.
 * process.exit is replaced with a throw so tests can assert on it without
 * actually exiting the test process.
 */

describe('fatalExit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('writes the error message and stack trace to stderr then exits 1', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    const err = new Error('boom');
    expect(() => fatalExit('Uncaught exception', err)).toThrow('process.exit(1)');
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Uncaught exception'),
    );
    // Should include the stack, not just the message
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Error: boom'),
    );
  });

  it('includes the full stack trace for Error instances', async () => {
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    const err = new Error('stack test');
    try { fatalExit('label', err); } catch { /* exit mock */ }
    const written = vi.mocked(process.stderr.write).mock.calls[0]?.[0] as string;
    expect(written).toContain('at '); // stack trace lines start with "at "
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
    // Second call must not throw again (process.exit already fired)
    expect(() => fatalExit('second', new Error('second'))).not.toThrow();
    // stderr should only have been written once
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
  });

  it('still exits even if stderr.write throws', async () => {
    vi.mocked(process.stderr.write).mockImplementation(() => { throw new Error('EBADF'); });
    const { fatalExit } = await import('../../../../src/mcp/transports/fatal-exit.js');
    expect(() => fatalExit('label', new Error('test'))).toThrow('process.exit(1)');
  });
});
