import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { waitForStdinReadable } from '../../../src/mcp-server.js';

/**
 * Tests for waitForStdinReadable — the zombie-bridge guard.
 *
 * Uses a fake readable stream so tests are deterministic and zero-delay.
 * No real process.stdin touched; no timing dependencies.
 */

function makeFakeStdin(): NodeJS.ReadableStream & { triggerReadable: () => void } {
  const emitter = new EventEmitter() as NodeJS.ReadableStream & { triggerReadable: () => void };
  // NodeJS.ReadableStream needs pause() — implement as no-op (stream is already "paused")
  (emitter as unknown as { pause: () => void }).pause = () => {};
  emitter.triggerReadable = () => emitter.emit('readable');
  return emitter;
}

describe('waitForStdinReadable', () => {
  it('returns true when stdin becomes readable before the timeout', async () => {
    const stdin = makeFakeStdin();
    const probePromise = waitForStdinReadable(1000, stdin);
    stdin.triggerReadable();
    expect(await probePromise).toBe(true);
  });

  it('returns false when stdin produces no data within the timeout', async () => {
    const stdin = makeFakeStdin();
    expect(await waitForStdinReadable(0, stdin)).toBe(false);
  });

  it('resolves with true if readable fires before timeout expires', async () => {
    const stdin = makeFakeStdin();
    // Schedule readable to fire after a short delay, before a long timeout
    setTimeout(() => stdin.triggerReadable(), 5);
    expect(await waitForStdinReadable(500, stdin)).toBe(true);
  });

  it('does not leave a dangling readable listener after resolving true', async () => {
    const stdin = makeFakeStdin();
    const probePromise = waitForStdinReadable(1000, stdin);
    stdin.triggerReadable();
    await probePromise;
    expect((stdin as EventEmitter).listenerCount('readable')).toBe(0);
  });

  it('does not leave a dangling readable listener after timing out', async () => {
    const stdin = makeFakeStdin();
    await waitForStdinReadable(0, stdin);
    expect((stdin as EventEmitter).listenerCount('readable')).toBe(0);
  });
});
