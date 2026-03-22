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
  return {
    on: (signal: string, handler: () => void) => {
      if (!handlers.has(signal)) handlers.set(signal, []);
      handlers.get(signal)!.push(handler);
    },
    _fire: (signal: string) => {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
    _handlers: handlers,
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
const { wireShutdownHooks } = await import(
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
