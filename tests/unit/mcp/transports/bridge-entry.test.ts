import { describe, it, expect, vi } from 'vitest';
import {
  detectHealthyPrimary,
  reconnectWithBackoff,
  handleReconnectOutcome,
  spawnPrimary,
  DEFAULT_BRIDGE_CONFIG,
  type ConnectionState,
  type FetchLike,
  type ReconnectOutcome,
  type SpawnLike,
} from '../../../../src/mcp/transports/bridge-entry.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Unit tests for bridge-entry.ts.
 * All side effects (fetch, spawn) are injected — no real I/O, no vi.stubGlobal.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const fakeTransport = { send: async () => {}, close: async () => {} };

const workrailOk = (): Response =>
  ({ ok: true, json: async () => ({ service: 'workrail' }) } as unknown as Response);
const wrongService = (): Response =>
  ({ ok: true, json: async () => ({ service: 'nginx' }) } as unknown as Response);

// ---------------------------------------------------------------------------
// detectHealthyPrimary
// ---------------------------------------------------------------------------

describe('detectHealthyPrimary', () => {
  it('returns port when /workrail-health says {service:"workrail"}', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(workrailOk());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBe(3100);
  });

  it('returns null for a non-WorkRail server (false-positive guard)', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(wrongService());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBeNull();
  });

  it('returns null on connection refused', async () => {
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBeNull();
  });

  it('retries on transient failure', async () => {
    const fetch: FetchLike = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(workrailOk());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 2, baseDelayMs: 0 })).toBe(3100);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts all retries and returns null', async () => {
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await detectHealthyPrimary(3100, { fetch, retries: 3, baseDelayMs: 0 })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// reconnectWithBackoff
// ---------------------------------------------------------------------------

describe('reconnectWithBackoff', () => {
  const cfg = { ...DEFAULT_BRIDGE_CONFIG, reconnectBaseDelayMs: 0 };

  it('returns reconnected on first immediate attempt', async () => {
    const detect = vi.fn().mockResolvedValue(fakeTransport);
    const result = await reconnectWithBackoff({ detect, config: cfg, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: 'reconnected', transport: fakeTransport });
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('first attempt is immediate (no initial delay)', async () => {
    const callTimes: number[] = [];
    const detect = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return fakeTransport;
    });
    const start = Date.now();
    await reconnectWithBackoff({ detect, config: { ...cfg, reconnectBaseDelayMs: 5000 }, signal: new AbortController().signal });
    expect(callTimes[0]! - start).toBeLessThan(100);
  });

  it('returns reconnected on a later attempt', async () => {
    let calls = 0;
    const detect = vi.fn().mockImplementation(async () => (++calls >= 3 ? fakeTransport : null));
    const result = await reconnectWithBackoff({ detect, config: { ...cfg, reconnectMaxAttempts: 5 }, signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: 'reconnected' });
    expect(calls).toBe(3);
  });

  it('returns exhausted when all attempts fail', async () => {
    const detect = vi.fn().mockResolvedValue(null);
    const result = await reconnectWithBackoff({ detect, config: { ...cfg, reconnectMaxAttempts: 3 }, signal: new AbortController().signal });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'exhausted' });
    expect(detect).toHaveBeenCalledTimes(3);
  });

  it('returns aborted when signal is already fired', async () => {
    const ac = new AbortController();
    ac.abort();
    const detect = vi.fn().mockResolvedValue(null);
    const result = await reconnectWithBackoff({ detect, config: cfg, signal: ac.signal });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'aborted' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('returns aborted when signal fires during backoff', async () => {
    const ac = new AbortController();
    let calls = 0;
    const detect = vi.fn().mockImplementation(async () => { calls++; ac.abort(); return null; });
    const result = await reconnectWithBackoff({ detect, config: { ...cfg, reconnectBaseDelayMs: 10, reconnectMaxAttempts: 10 }, signal: ac.signal });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'aborted' });
    expect(calls).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// handleReconnectOutcome — state transitions are data
// ---------------------------------------------------------------------------

describe('handleReconnectOutcome', () => {
  const cfg = { reconnectMaxAttempts: 8 };
  const reconnecting = (respawnBudget: number): Extract<ConnectionState, { kind: 'reconnecting' }> => ({
    kind: 'reconnecting', attempt: 0, maxAttempts: 8, respawnBudget,
  });

  // Note: handleReconnectOutcome no longer sets state for the 'reconnected' case —
  // that transition is owned by buildConnectedTransport for atomicity.

  it('does not set state on reconnected — buildConnectedTransport owns that transition', async () => {
    const setConnectionState = vi.fn();
    await handleReconnectOutcome(
      { kind: 'reconnected', transport: fakeTransport },
      reconnecting(3),
      { setConnectionState, performShutdown: vi.fn(), startReconnectLoop: vi.fn(), triggerSpawn: vi.fn().mockResolvedValue(undefined), config: cfg },
    );
    // State was already set atomically inside buildConnectedTransport.
    // handleReconnectOutcome must not duplicate the transition.
    expect(setConnectionState).not.toHaveBeenCalled();
  });

  it('is a no-op on aborted', async () => {
    const setConnectionState = vi.fn();
    const performShutdown = vi.fn();
    await handleReconnectOutcome(
      { kind: 'aborted' },
      reconnecting(3),
      { setConnectionState, performShutdown, startReconnectLoop: vi.fn(), triggerSpawn: vi.fn().mockResolvedValue(undefined), config: cfg },
    );
    expect(setConnectionState).not.toHaveBeenCalled();
    expect(performShutdown).not.toHaveBeenCalled();
  });

  it('spawns and restarts loop on exhausted when budget > 0', async () => {
    const triggerSpawn = vi.fn().mockResolvedValue(undefined);
    const setConnectionState = vi.fn();
    const startReconnectLoop = vi.fn();
    await handleReconnectOutcome(
      { kind: 'exhausted' },
      reconnecting(2),
      { setConnectionState, performShutdown: vi.fn(), startReconnectLoop, triggerSpawn, config: cfg },
    );
    expect(triggerSpawn).toHaveBeenCalledTimes(1);
    expect(setConnectionState).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reconnecting', respawnBudget: 1 }),
    );
    expect(startReconnectLoop).toHaveBeenCalledTimes(1);
  });

  it('decrements respawnBudget correctly across multiple cycles', async () => {
    const states: ConnectionState[] = [];
    const setConnectionState = vi.fn().mockImplementation((s: ConnectionState) => states.push(s));
    const startReconnectLoop = vi.fn();

    await handleReconnectOutcome(
      { kind: 'exhausted' },
      reconnecting(3),
      { setConnectionState, performShutdown: vi.fn(), startReconnectLoop, triggerSpawn: vi.fn().mockResolvedValue(undefined), config: cfg },
    );
    expect(states[0]).toMatchObject({ kind: 'reconnecting', respawnBudget: 2 });

    await handleReconnectOutcome(
      { kind: 'exhausted' },
      reconnecting(2),
      { setConnectionState, performShutdown: vi.fn(), startReconnectLoop, triggerSpawn: vi.fn().mockResolvedValue(undefined), config: cfg },
    );
    expect(states[1]).toMatchObject({ kind: 'reconnecting', respawnBudget: 1 });
  });

  it('shuts down on exhausted when budget is 0', async () => {
    const performShutdown = vi.fn();
    const triggerSpawn = vi.fn();
    await handleReconnectOutcome(
      { kind: 'exhausted' },
      reconnecting(0),
      { setConnectionState: vi.fn(), performShutdown, startReconnectLoop: vi.fn(), triggerSpawn, config: cfg },
    );
    expect(triggerSpawn).not.toHaveBeenCalled();
    expect(performShutdown).toHaveBeenCalledWith(expect.stringContaining('budget exhausted'));
  });
});

// ---------------------------------------------------------------------------
// spawnPrimary — injectable spawn
// ---------------------------------------------------------------------------

describe('spawnPrimary', () => {
  const noopSpawn: SpawnLike = vi.fn().mockReturnValue({ unref: vi.fn() });

  it('spawns with WORKRAIL_TRANSPORT=http and the same script path', async () => {
    const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('refused')); // nothing running
    await spawnPrimary(3100, { spawn: mockSpawn, fetch });
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1]],
      expect.objectContaining({ env: expect.objectContaining({ WORKRAIL_TRANSPORT: 'http' }) }),
    );
  });

  it('skips spawn when primary is already up after jitter (another bridge beat us)', async () => {
    const mockSpawn = vi.fn().mockReturnValue({ unref: vi.fn() });
    const fetch: FetchLike = vi.fn().mockResolvedValue(workrailOk()); // already up
    await spawnPrimary(3100, { spawn: mockSpawn, fetch });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('logs and does not throw when spawn itself fails', async () => {
    const mockSpawn: SpawnLike = vi.fn().mockImplementation(() => { throw new Error('ENOENT'); });
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('refused'));
    await expect(spawnPrimary(3100, { spawn: mockSpawn, fetch })).resolves.toBeUndefined();
  });

  it('calls unref() so the child is detached from the bridge process', async () => {
    const unref = vi.fn();
    const mockSpawn: SpawnLike = vi.fn().mockReturnValue({ unref });
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('refused'));
    await spawnPrimary(3100, { spawn: mockSpawn, fetch });
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Startup branching contract
// ---------------------------------------------------------------------------

describe('startup bridge branching', () => {
  it('bridges when primary is detected in stdio mode', async () => {
    const r = await simulateStartup({ mode: 'stdio', primaryDetected: true });
    expect(r.bridgeStarted).toBe(true);
    expect(r.fullServerStarted).toBe(false);
  });

  it('starts full server when no primary is detected', async () => {
    const r = await simulateStartup({ mode: 'stdio', primaryDetected: false });
    expect(r.bridgeStarted).toBe(false);
    expect(r.fullServerStarted).toBe(true);
  });

  it('never checks for primary in http mode', async () => {
    const r = await simulateStartup({ mode: 'http', primaryDetected: false });
    expect(r.detectionCalled).toBe(false);
    expect(r.fullServerStarted).toBe(true);
  });

  it('falls back to full server when bridge startup throws', async () => {
    const r = await simulateStartup({ mode: 'stdio', primaryDetected: true, bridgeShouldFail: true });
    expect(r.fullServerStarted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ConnectionState dispatch — exhaustive switch
// ---------------------------------------------------------------------------

describe('ConnectionState dispatch', () => {
  const req = { jsonrpc: '2.0', id: 42, method: 'tools/call', params: {} } as JSONRPCMessage;
  const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: {} } as JSONRPCMessage;

  it('forwards to transport when connected', () => {
    const sent: JSONRPCMessage[] = [];
    const state: ConnectionState = {
      kind: 'connected',
      transport: { send: async (m) => { sent.push(m); }, close: async () => {} },
    };
    dispatch(state, req);
    expect(sent).toHaveLength(1);
  });

  it('returns JSON-RPC error immediately when reconnecting', async () => {
    const sentToIde: JSONRPCMessage[] = [];
    const state: ConnectionState = { kind: 'reconnecting', attempt: 0, maxAttempts: 8, respawnBudget: 3 };
    dispatch(state, req, async (m) => { sentToIde.push(m); });
    await new Promise((r) => setTimeout(r, 0));
    const resp = sentToIde[0] as { id: number; error: { code: number } };
    expect(resp.id).toBe(42);
    expect(resp.error.code).toBe(-32603);
  });

  it('returns JSON-RPC error immediately when connecting (initial handshake)', async () => {
    // 'connecting' and 'reconnecting' both mean "no primary available right now"
    // and should both return an error so agents don't hang.
    const sentToIde: JSONRPCMessage[] = [];
    dispatch({ kind: 'connecting' }, req, async (m) => { sentToIde.push(m); });
    await new Promise((r) => setTimeout(r, 0));
    const resp = sentToIde[0] as { id: number; error: { code: number } };
    expect(resp.id).toBe(42);
    expect(resp.error.code).toBe(-32603);
  });

  it('does not respond to notifications when unavailable', async () => {
    const sentToIde: JSONRPCMessage[] = [];
    const state: ConnectionState = { kind: 'reconnecting', attempt: 0, maxAttempts: 8, respawnBudget: 3 };
    dispatch(state, notification, async (m) => { sentToIde.push(m); });
    await new Promise((r) => setTimeout(r, 0));
    expect(sentToIde).toHaveLength(0);
  });

  it('no-ops when closed', () => {
    const sent: JSONRPCMessage[] = [];
    dispatch({ kind: 'closed' }, req);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// t.onclose idempotency
// ---------------------------------------------------------------------------

describe('t.onclose idempotency', () => {
  it('does not start a loop when already reconnecting', () => {
    let loopStartCount = 0;
    const onclose = simulateOnClose(
      { kind: 'reconnecting', attempt: 0, maxAttempts: 8, respawnBudget: 3 },
      () => { loopStartCount++; },
    );
    onclose();
    onclose();
    expect(loopStartCount).toBe(0);
  });

  it('does not start a loop when still in connecting state (initial handshake)', () => {
    // 'connecting' means no prior connection — t.onclose during init should not
    // start the reconnect loop; the caller will see buildConnectedTransport return null.
    let loopStartCount = 0;
    const onclose = simulateOnClose({ kind: 'connecting' }, () => { loopStartCount++; });
    onclose();
    expect(loopStartCount).toBe(0);
  });

  it('starts the loop when state is connected (primary died)', () => {
    let loopStartCount = 0;
    const onclose = simulateOnClose(
      { kind: 'connected', transport: fakeTransport },
      () => { loopStartCount++; },
    );
    onclose();
    expect(loopStartCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatch(
  state: ConnectionState,
  msg: JSONRPCMessage,
  sendToIde?: (m: JSONRPCMessage) => Promise<void>,
): void {
  switch (state.kind) {
    case 'connected':
      void state.transport.send(msg);
      return;
    case 'connecting':
    // falls through — same behavior as reconnecting
    // eslint-disable-next-line no-fallthrough
    case 'reconnecting':
      if ('id' in msg && msg.id != null && sendToIde) {
        void sendToIde({
          jsonrpc: '2.0',
          id: (msg as { id: string | number }).id,
          error: { code: -32603, message: 'temporarily unavailable' },
        } as JSONRPCMessage).catch(() => undefined);
      }
      return;
    case 'closed':
      return;
  }
}

function simulateOnClose(
  currentState: ConnectionState,
  startReconnectLoop: () => void,
): () => void {
  // Mirrors the t.onclose logic in startBridgeServer.
  return () => {
    if (currentState.kind === 'connecting' || currentState.kind === 'reconnecting') return;
    startReconnectLoop();
  };
}

async function simulateStartup(opts: {
  mode: 'stdio' | 'http';
  primaryDetected: boolean;
  bridgeShouldFail?: boolean;
}): Promise<{ bridgeStarted: boolean; fullServerStarted: boolean; detectionCalled: boolean }> {
  const r = { bridgeStarted: false, fullServerStarted: false, detectionCalled: false };

  const detectPrimary = async (port: number) => { r.detectionCalled = true; return opts.primaryDetected ? port : null; };
  const startBridge = async (_port: number) => { r.bridgeStarted = true; if (opts.bridgeShouldFail) throw new Error('refused'); };
  const startFullServer = async () => { r.fullServerStarted = true; };

  if (opts.mode === 'stdio') {
    const port = await detectPrimary(3100);
    if (port != null) {
      try { await startBridge(port); } catch { await startFullServer(); }
      return r;
    }
    await startFullServer();
    return r;
  }
  await startFullServer();
  return r;
}
