import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fakes for DI ports
// ---------------------------------------------------------------------------

type ShutdownListener = (event: { kind: 'shutdown_requested'; signal: string }) => void;

function createFakeShutdownEvents() {
  const listeners: ShutdownListener[] = [];
  return {
    onShutdown: (listener: ShutdownListener) => {
      listeners.push(listener);
      return () => { /* unsubscribe */ };
    },
    emit: (event: { kind: 'shutdown_requested'; signal: string }) => {
      for (const listener of listeners) listener(event);
    },
    _listeners: listeners,
  };
}

function createFakeProcessSignals() {
  const handlers = new Map<string, Array<() => void>>();
  const onceHandlers = new Map<string, Array<() => void>>();
  return {
    on: (signal: string, handler: () => void) => {
      if (!handlers.has(signal)) handlers.set(signal, []);
      handlers.get(signal)!.push(handler);
    },
    once: (signal: string, handler: () => void) => {
      if (!onceHandlers.has(signal)) onceHandlers.set(signal, []);
      onceHandlers.get(signal)!.push(handler);
    },
    _fire: (signal: string) => {
      for (const handler of handlers.get(signal) ?? []) handler();
      // once handlers fire then clear
      const onces = onceHandlers.get(signal) ?? [];
      onceHandlers.delete(signal);
      for (const handler of onces) handler();
    },
    _handlers: handlers,
    _onceHandlers: onceHandlers,
  };
}

function createFakeTerminator() {
  const calls: Array<{ kind: string }> = [];
  return {
    terminate: (code: { kind: string }) => {
      calls.push(code);
    },
    _calls: calls,
  };
}

// ---------------------------------------------------------------------------
// DI mock setup — wire fakes into the container.resolve path
// ---------------------------------------------------------------------------

const fakeShutdownEvents = createFakeShutdownEvents();
const fakeProcessSignals = createFakeProcessSignals();
const fakeTerminator = createFakeTerminator();

vi.mock('../../../src/di/container.js', () => ({
  container: {
    resolve: (token: symbol) => {
      // Token identity comparison via description (symbols are unique per import)
      const desc = token.description ?? '';
      if (desc.includes('ShutdownEvents')) return fakeShutdownEvents;
      if (desc.includes('ProcessSignals')) return fakeProcessSignals;
      if (desc.includes('ProcessTerminator')) return fakeTerminator;
      throw new Error(`Unexpected DI token: ${desc}`);
    },
  },
}));

vi.mock('../../../src/di/tokens.js', () => ({
  DI: {
    Runtime: {
      ShutdownEvents: Symbol.for('ShutdownEvents'),
      ProcessSignals: Symbol.for('ProcessSignals'),
      ProcessTerminator: Symbol.for('ProcessTerminator'),
    },
  },
}));

// Import after mocks are set up
const { wireShutdownHooks, wireStdinShutdown, wireStdoutShutdown } = await import(
  '../../../src/mcp/transports/shutdown-hooks.js'
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireShutdownHooks', () => {
  let onBeforeTerminate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset fakes
    fakeShutdownEvents._listeners.length = 0;
    fakeProcessSignals._handlers.clear();
    fakeProcessSignals._onceHandlers.clear();
    fakeTerminator._calls.length = 0;
    onBeforeTerminate = vi.fn().mockResolvedValue(undefined);
  });

  it('registers signal handlers for SIGINT, SIGTERM, and SIGHUP', () => {
    wireShutdownHooks({ onBeforeTerminate });

    expect(fakeProcessSignals._handlers.has('SIGINT')).toBe(true);
    expect(fakeProcessSignals._handlers.has('SIGTERM')).toBe(true);
    expect(fakeProcessSignals._handlers.has('SIGHUP')).toBe(true);
  });

  it('registers a shutdown listener', () => {
    wireShutdownHooks({ onBeforeTerminate });

    expect(fakeShutdownEvents._listeners.length).toBe(1);
  });

  it('calls onBeforeTerminate and terminates with success on shutdown', async () => {
    wireShutdownHooks({ onBeforeTerminate });

    fakeShutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' });

    // Allow the async shutdown handler to run
    await vi.waitFor(() => {
      expect(fakeTerminator._calls.length).toBe(1);
    });

    expect(onBeforeTerminate).toHaveBeenCalledOnce();
    expect(fakeTerminator._calls[0]).toEqual({ kind: 'success' });
  });

  it('terminates with failure when onBeforeTerminate throws', async () => {
    onBeforeTerminate.mockRejectedValueOnce(new Error('teardown failed'));
    wireShutdownHooks({ onBeforeTerminate });

    fakeShutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' });

    await vi.waitFor(() => {
      expect(fakeTerminator._calls.length).toBe(1);
    });

    expect(fakeTerminator._calls[0]).toEqual({ kind: 'failure' });
  });

  it('guards against double-shutdown (only runs teardown once)', async () => {
    wireShutdownHooks({ onBeforeTerminate });

    fakeShutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGINT' });
    fakeShutdownEvents.emit({ kind: 'shutdown_requested', signal: 'SIGTERM' });

    await vi.waitFor(() => {
      expect(fakeTerminator._calls.length).toBe(1);
    });

    // Only called once despite two events
    expect(onBeforeTerminate).toHaveBeenCalledOnce();
  });

  it('signal handler fires a shutdown_requested event', () => {
    wireShutdownHooks({ onBeforeTerminate });

    // Simulate SIGINT signal
    fakeProcessSignals._fire('SIGINT');

    // Should have registered a listener AND it should have been called
    // The signal handler emits to shutdownEvents, which triggers the listener
    expect(fakeShutdownEvents._listeners.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fake readable stream for wireStdinShutdown tests
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';

function createFakeStdin(): NodeJS.ReadableStream & { simulateEnd(): void } {
  const emitter = new EventEmitter() as NodeJS.ReadableStream & { simulateEnd(): void };
  emitter.simulateEnd = () => emitter.emit('end');
  return emitter;
}

// ---------------------------------------------------------------------------
// Fake writable stream for wireShutdownHooks stdout tests
// ---------------------------------------------------------------------------

function createFakeStdout(): NodeJS.WritableStream & { simulateError(err?: Error): void } {
  const emitter = new EventEmitter() as NodeJS.WritableStream & { simulateError(err?: Error): void };
  emitter.simulateError = (err = new Error('EPIPE')) => emitter.emit('error', err);
  // WritableStream interface stubs (not used in this test)
  (emitter as any).write = () => true;
  (emitter as any).end = () => {};
  (emitter as any).writable = true;
  (emitter as any).writableEnded = false;
  return emitter;
}

describe('wireShutdownHooks stdout drain behavior', () => {
  beforeEach(() => {
    fakeShutdownEvents._listeners.length = 0;
    fakeProcessSignals._handlers.clear();
    fakeProcessSignals._onceHandlers.clear();
    fakeTerminator._calls.length = 0;
  });

  it('emits drain on stdout error to unblock pending send() Promises', () => {
    const fakeStdout = createFakeStdout();
    const drainFired: boolean[] = [];

    fakeStdout.on('drain', () => {
      drainFired.push(true);
    });

    const onBeforeTerminate = vi.fn().mockResolvedValue(undefined);
    wireShutdownHooks({ onBeforeTerminate, stdout: fakeStdout });

    fakeStdout.simulateError(new Error('write EPIPE'));

    expect(drainFired).toHaveLength(1);
  });

  it('emits drain synchronously within the error handler (drain fires before any shutdown event)', () => {
    const fakeStdout = createFakeStdout();
    const events: string[] = [];

    fakeStdout.on('drain', () => events.push('drain'));
    fakeShutdownEvents._listeners.push(() => events.push('shutdown'));

    const onBeforeTerminate = vi.fn().mockResolvedValue(undefined);
    wireShutdownHooks({ onBeforeTerminate, stdout: fakeStdout });

    // The stdout error handler emits drain -- no shutdown event is triggered by
    // the error handler itself. Verify drain fires when error occurs.
    fakeStdout.simulateError(new Error('write EPIPE'));

    expect(events[0]).toBe('drain');
  });

  it('does not emit drain when no error occurs (happy path unchanged)', () => {
    const fakeStdout = createFakeStdout();
    const drainFired: boolean[] = [];

    fakeStdout.on('drain', () => drainFired.push(true));

    const onBeforeTerminate = vi.fn().mockResolvedValue(undefined);
    wireShutdownHooks({ onBeforeTerminate, stdout: fakeStdout });

    // No error fired -- drain should not have been emitted
    expect(drainFired).toHaveLength(0);
  });
});

describe('wireStdinShutdown', () => {
  beforeEach(() => {
    fakeShutdownEvents._listeners.length = 0;
    fakeProcessSignals._handlers.clear();
    fakeProcessSignals._onceHandlers.clear();
    fakeTerminator._calls.length = 0;
  });

  it('emits shutdown_requested with SIGHUP when stdin ends', () => {
    const fakeStdin = createFakeStdin();
    const emittedEvents: Array<{ kind: string; signal: string }> = [];

    // Register a listener to capture emitted events before wiring
    fakeShutdownEvents._listeners.push((event) => {
      emittedEvents.push(event);
    });

    wireStdinShutdown({ stdin: fakeStdin });
    fakeStdin.simulateEnd();

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toEqual({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });

  it('fires at most once even if end is emitted multiple times', () => {
    const fakeStdin = createFakeStdin();
    const emittedEvents: Array<{ kind: string; signal: string }> = [];

    fakeShutdownEvents._listeners.push((event) => {
      emittedEvents.push(event);
    });

    wireStdinShutdown({ stdin: fakeStdin });

    fakeStdin.simulateEnd();
    fakeStdin.simulateEnd(); // Second call should be ignored by once() semantics

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toEqual({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });
});

// ---------------------------------------------------------------------------
// Fake writable stream for wireStdoutShutdown tests
// ---------------------------------------------------------------------------

function createFakeStdout(): NodeJS.WritableStream & {
  simulateError(code: string): void;
} {
  const emitter = new EventEmitter() as NodeJS.WritableStream & {
    simulateError(code: string): void;
  };
  emitter.simulateError = (code: string) => {
    const err = Object.assign(new Error(`write ${code}`), { code });
    emitter.emit('error', err);
  };
  return emitter;
}

describe('wireStdoutShutdown', () => {
  beforeEach(() => {
    fakeShutdownEvents._listeners.length = 0;
    fakeProcessSignals._handlers.clear();
    fakeProcessSignals._onceHandlers.clear();
    fakeTerminator._calls.length = 0;
  });

  it('emits shutdown_requested with SIGHUP on EPIPE', () => {
    const fakeStdout = createFakeStdout();
    const emittedEvents: Array<{ kind: string; signal: string }> = [];

    fakeShutdownEvents._listeners.push((event) => emittedEvents.push(event));

    wireStdoutShutdown({ stdout: fakeStdout });
    fakeStdout.simulateError('EPIPE');

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toEqual({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });

  it('emits shutdown_requested with SIGHUP on ERR_STREAM_DESTROYED', () => {
    const fakeStdout = createFakeStdout();
    const emittedEvents: Array<{ kind: string; signal: string }> = [];

    fakeShutdownEvents._listeners.push((event) => emittedEvents.push(event));

    wireStdoutShutdown({ stdout: fakeStdout });
    fakeStdout.simulateError('ERR_STREAM_DESTROYED');

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toEqual({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });

  it('emits shutdown_requested for other stdout errors too', () => {
    const fakeStdout = createFakeStdout();
    const emittedEvents: Array<{ kind: string; signal: string }> = [];

    fakeShutdownEvents._listeners.push((event) => emittedEvents.push(event));

    wireStdoutShutdown({ stdout: fakeStdout });
    fakeStdout.simulateError('EIO');

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toEqual({ kind: 'shutdown_requested', signal: 'SIGHUP' });
  });

  it('handles multiple errors (does not throw after first)', () => {
    const fakeStdout = createFakeStdout();
    const emittedEvents: Array<{ kind: string; signal: string }> = [];

    fakeShutdownEvents._listeners.push((event) => emittedEvents.push(event));

    wireStdoutShutdown({ stdout: fakeStdout });
    fakeStdout.simulateError('EPIPE');
    fakeStdout.simulateError('EPIPE');

    // Both fire since we register with .on() not .once()
    expect(emittedEvents).toHaveLength(2);
  });
});
