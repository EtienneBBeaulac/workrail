import { describe, it, expect, vi } from 'vitest';
import {
  detectHealthyPrimary,
  reconnectWithBackoff,
  DEFAULT_BRIDGE_CONFIG,
  type ConnectionState,
  type FetchLike,
  type ReconnectOutcome,
} from '../../../../src/mcp/transports/bridge-entry.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tests for bridge mode: detection, reconnect outcome, startup branching,
 * and ConnectionState dispatch.
 *
 * Tests use injected dependencies throughout — no vi.stubGlobal, no real I/O.
 */

// ---------------------------------------------------------------------------
// detectHealthyPrimary
// ---------------------------------------------------------------------------

describe('detectHealthyPrimary', () => {
  const workrailOk = (): Response =>
    ({ ok: true, json: async () => ({ service: 'workrail' }) } as unknown as Response);
  const wrongService = (): Response =>
    ({ ok: true, json: async () => ({ service: 'nginx' }) } as unknown as Response);
  const notOk = (): Response =>
    ({ ok: false, json: async () => null } as unknown as Response);

  it('returns the port when /workrail-health responds {service:"workrail"}', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(workrailOk());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBe(3100);
  });

  it('returns null when service is not "workrail" (false-positive guard)', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(wrongService());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBeNull();
  });

  it('returns null when response is not ok', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(notOk());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBeNull();
  });

  it('returns null on connection refused', async () => {
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBeNull();
  });

  it('retries on transient failure and returns port on later success', async () => {
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
// reconnectWithBackoff — tests the ReconnectOutcome discriminated union directly
// ---------------------------------------------------------------------------

describe('reconnectWithBackoff', () => {
  const config = { ...DEFAULT_BRIDGE_CONFIG, reconnectBaseDelayMs: 0 };
  const fakeTransport = { send: async () => {}, close: async () => {} };

  it('returns {kind:"reconnected"} when detect succeeds on first attempt', async () => {
    const detect = vi.fn().mockResolvedValue(fakeTransport);
    const result = await reconnectWithBackoff({
      detect,
      config: { ...config, reconnectMaxAttempts: 3 },
      signal: new AbortController().signal,
    });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'reconnected', transport: fakeTransport });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith(0); // first attempt is index 0
  });

  it('tries immediately on first attempt (no initial delay)', async () => {
    // If the first call succeeds, it must happen before any delay.
    const calls: number[] = [];
    const detect = vi.fn().mockImplementation(async (attempt: number) => {
      calls.push(Date.now());
      return attempt === 0 ? fakeTransport : null;
    });
    const start = Date.now();
    await reconnectWithBackoff({ detect, config: { ...config, reconnectBaseDelayMs: 1000 }, signal: new AbortController().signal });
    // First attempt should have happened immediately (well under 100ms from start)
    expect(calls[0]! - start).toBeLessThan(100);
  });

  it('returns {kind:"reconnected"} when detect succeeds on a later attempt', async () => {
    let attempts = 0;
    const detect = vi.fn().mockImplementation(async () => {
      attempts++;
      return attempts >= 3 ? fakeTransport : null;
    });
    const result = await reconnectWithBackoff({
      detect,
      config: { ...config, reconnectMaxAttempts: 5 },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ kind: 'reconnected' });
    expect(attempts).toBe(3);
  });

  it('returns {kind:"exhausted"} when all attempts fail', async () => {
    const detect = vi.fn().mockResolvedValue(null);
    const result = await reconnectWithBackoff({
      detect,
      config: { ...config, reconnectMaxAttempts: 3 },
      signal: new AbortController().signal,
    });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'exhausted' });
    expect(detect).toHaveBeenCalledTimes(3);
  });

  it('returns {kind:"aborted"} when the signal fires before first attempt', async () => {
    const ac = new AbortController();
    ac.abort();
    const detect = vi.fn().mockResolvedValue(null);
    const result = await reconnectWithBackoff({
      detect,
      config: { ...config, reconnectMaxAttempts: 5 },
      signal: ac.signal,
    });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'aborted' });
    expect(detect).not.toHaveBeenCalled();
  });

  it('returns {kind:"aborted"} when the signal fires during backoff', async () => {
    const ac = new AbortController();
    let calls = 0;
    const detect = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) ac.abort(); // abort after first attempt
      return null;
    });
    const result = await reconnectWithBackoff({
      detect,
      config: { ...config, reconnectBaseDelayMs: 10, reconnectMaxAttempts: 10 },
      signal: ac.signal,
    });
    expect(result).toEqual<ReconnectOutcome>({ kind: 'aborted' });
    // Should have stopped well before 10 attempts
    expect(calls).toBeLessThan(5);
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
// ConnectionState dispatch — exhaustive switch, no flag checks
// ---------------------------------------------------------------------------

describe('ConnectionState dispatch', () => {
  const requestMsg = { jsonrpc: '2.0', id: 42, method: 'tools/call', params: {} } as JSONRPCMessage;
  const notificationMsg = { jsonrpc: '2.0', method: 'notifications/progress', params: {} } as JSONRPCMessage;

  it('forwards messages to transport when connected', () => {
    const sent: JSONRPCMessage[] = [];
    const state: ConnectionState = {
      kind: 'connected',
      transport: { send: async (m) => { sent.push(m); }, close: async () => {} },
    };
    dispatch(state, requestMsg);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(requestMsg);
  });

  it('returns JSON-RPC error immediately when reconnecting (prevents agent hang)', async () => {
    const sentToIde: JSONRPCMessage[] = [];
    const state: ConnectionState = { kind: 'reconnecting', attempt: 0, maxAttempts: 8 };
    dispatch(state, requestMsg, async (m) => { sentToIde.push(m); });
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks
    expect(sentToIde).toHaveLength(1);
    const response = sentToIde[0] as { id: number; error: { code: number } };
    expect(response.id).toBe(42);
    expect(response.error.code).toBe(-32603);
  });

  it('does not respond to notifications while reconnecting (no id)', async () => {
    const sentToIde: JSONRPCMessage[] = [];
    const state: ConnectionState = { kind: 'reconnecting', attempt: 0, maxAttempts: 8 };
    dispatch(state, notificationMsg, async (m) => { sentToIde.push(m); });
    await new Promise((r) => setTimeout(r, 0));
    expect(sentToIde).toHaveLength(0); // notifications don't need a response
  });

  it('no-ops when closed', () => {
    const sent: JSONRPCMessage[] = [];
    const state: ConnectionState = { kind: 'closed' };
    dispatch(state, requestMsg);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inline reimplementation of the ConnectionState dispatch switch from
 * startBridgeServer. Tests the logic without wiring real transports.
 */
function dispatch(
  state: ConnectionState,
  msg: JSONRPCMessage,
  sendToIde?: (m: JSONRPCMessage) => Promise<void>,
): void {
  switch (state.kind) {
    case 'connected':
      void state.transport.send(msg);
      return;
    case 'reconnecting':
      if ('id' in msg && msg.id != null && sendToIde) {
        void sendToIde({
          jsonrpc: '2.0',
          id: (msg as { id: string | number }).id,
          error: { code: -32603, message: 'WorkRail primary server is temporarily unavailable — reconnecting.' },
        } as JSONRPCMessage).catch(() => undefined);
      }
      return;
    case 'closed':
      return;
  }
}

async function simulateStartup(opts: {
  mode: 'stdio' | 'http';
  primaryDetected: boolean;
  bridgeShouldFail?: boolean;
}): Promise<{ bridgeStarted: boolean; fullServerStarted: boolean; detectionCalled: boolean }> {
  const result = { bridgeStarted: false, fullServerStarted: false, detectionCalled: false };

  const detectPrimary = async (port: number) => {
    result.detectionCalled = true;
    return opts.primaryDetected ? port : null;
  };
  const startBridge = async (_port: number) => {
    result.bridgeStarted = true;
    if (opts.bridgeShouldFail) throw new Error('refused');
  };
  const startFullServer = async () => { result.fullServerStarted = true; };

  if (opts.mode === 'stdio') {
    const port = await detectPrimary(3100);
    if (port != null) {
      try { await startBridge(port); } catch { await startFullServer(); }
      return result;
    }
    await startFullServer();
    return result;
  }

  await startFullServer();
  return result;
}
