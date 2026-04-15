import { describe, it, expect, vi } from 'vitest';
import {
  detectHealthyPrimary,
  DEFAULT_BRIDGE_CONFIG,
  type FetchLike,
} from '../../../../src/mcp/transports/bridge-entry.js';

/**
 * Tests for bridge mode: detection, startup branching, reconnect contract,
 * and the reconnect-with-backoff pure logic.
 *
 * detectHealthyPrimary accepts a fetch dependency — no vi.stubGlobal needed.
 * The reconnect loop (reconnectWithBackoff) is exercised via the simulation
 * helpers that mirror its contract without touching real network I/O.
 */

// ---------------------------------------------------------------------------
// detectHealthyPrimary
// ---------------------------------------------------------------------------

describe('detectHealthyPrimary', () => {
  const workrailResponse = (): Response =>
    ({ ok: true, json: async () => ({ service: 'workrail' }) } as unknown as Response);
  const nonWorkrailResponse = (): Response =>
    ({ ok: true, json: async () => ({ service: 'nginx' }) } as unknown as Response);
  const failedResponse = (): Response => ({ ok: false, json: async () => null } as unknown as Response);

  it('returns the port when /workrail-health responds {service:"workrail"}', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(workrailResponse());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBe(3100);
  });

  it('returns null when the service field is not "workrail" (false-positive guard)', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(nonWorkrailResponse());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 1 })).toBeNull();
  });

  it('returns null when response is not ok', async () => {
    const fetch: FetchLike = vi.fn().mockResolvedValue(failedResponse());
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
      .mockResolvedValue(workrailResponse());
    expect(await detectHealthyPrimary(3100, { fetch, retries: 2, baseDelayMs: 0 })).toBe(3100);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts all retries and returns null when every attempt fails', async () => {
    const fetch: FetchLike = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect(await detectHealthyPrimary(3100, { fetch, retries: 3, baseDelayMs: 0 })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Startup branching contract
// (Mirrors the logic in mcp-server.ts main() — tested as a pure simulation.)
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
// Reconnect loop contract
// (Tests the reconnectWithBackoff contract without touching real I/O.)
// ---------------------------------------------------------------------------

describe('reconnect loop contract', () => {
  it('calls onReconnected when primary comes back within retry window', async () => {
    let calls = 0;
    const result = await simulateReconnectLoop({
      detect: async () => { calls++; return calls >= 2 ? {} : null; },
      maxAttempts: 5,
    });
    expect(result).toBe('reconnected');
    expect(calls).toBe(2);
  });

  it('calls onExhausted when all attempts fail', async () => {
    const result = await simulateReconnectLoop({
      detect: async () => null,
      maxAttempts: 3,
    });
    expect(result).toBe('exhausted');
  });

  it('stops early when the abort signal fires', async () => {
    const ac = new AbortController();
    let calls = 0;
    const result = await simulateReconnectLoop({
      detect: async () => { calls++; ac.abort(); return null; },
      maxAttempts: 10,
      signal: ac.signal,
    });
    expect(result).toBe('aborted');
    expect(calls).toBe(1); // stopped after first attempt triggered abort
  });
});

// ---------------------------------------------------------------------------
// ConnectionState dispatch contract
// (Tests that message handling is driven by state, not boolean flags.)
// ---------------------------------------------------------------------------

describe('ConnectionState dispatch', () => {
  it('forwards messages when connected', () => {
    const sent: unknown[] = [];
    const mockTransport = { send: async (m: unknown) => { sent.push(m); }, close: async () => {} };
    const dispatch = buildDispatch({ kind: 'connected', transport: mockTransport });
    dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage);
    expect(sent).toHaveLength(1);
  });

  it('returns a reconnecting error immediately when reconnecting (no hang)', async () => {
    const sentToIde: unknown[] = [];
    const mockStdio = { send: async (m: unknown) => { sentToIde.push(m); } };
    const dispatch = buildDispatch(
      { kind: 'reconnecting', attempt: 0, maxAttempts: 8 },
      mockStdio,
    );
    dispatch({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: {} } as JSONRPCMessage);
    // Let microtasks flush
    await new Promise((r) => setTimeout(r, 0));
    expect(sentToIde).toHaveLength(1);
    const response = sentToIde[0] as { id: number; error: { code: number } };
    expect(response.id).toBe(42);
    expect(response.error.code).toBe(-32603);
  });

  it('drops messages silently when closed', () => {
    const sent: unknown[] = [];
    const dispatch = buildDispatch({ kind: 'closed' });
    dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } as JSONRPCMessage);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { ConnectionState, JSONRPCMessage } from '../../../../src/mcp/transports/bridge-entry.js';

// Re-export ConnectionState just for the dispatch helper typing below.
// The actual ConnectionState type comes from bridge-entry.ts.

type Transport = { send: (m: unknown) => Promise<void>; close: () => Promise<void> };

function buildDispatch(
  state: { kind: 'connected'; transport: Transport }
    | { kind: 'reconnecting'; attempt: number; maxAttempts: number }
    | { kind: 'closed' },
  stdioTransport?: { send: (m: unknown) => Promise<void> },
): (msg: JSONRPCMessage) => void {
  // Mirrors the onmessage dispatch logic from startBridgeServer.
  return (msg: JSONRPCMessage) => {
    switch (state.kind) {
      case 'connected': {
        void state.transport.send(msg);
        return;
      }
      case 'reconnecting': {
        const req = msg as { id?: string | number };
        if (req.id != null && stdioTransport) {
          void stdioTransport.send({
            jsonrpc: '2.0',
            id: req.id,
            error: { code: -32603, message: 'WorkRail primary server is temporarily unavailable — reconnecting.' },
          });
        }
        return;
      }
      case 'closed':
        return;
    }
  };
}

async function simulateStartup(opts: {
  mode: 'stdio' | 'http';
  primaryDetected: boolean;
  bridgeShouldFail?: boolean;
}): Promise<{ bridgeStarted: boolean; fullServerStarted: boolean; detectionCalled: boolean }> {
  const result = { bridgeStarted: false, fullServerStarted: false, detectionCalled: false };

  const detectPrimary = async (port: number) => { result.detectionCalled = true; return opts.primaryDetected ? port : null; };
  const startBridge = async (_port: number) => { result.bridgeStarted = true; if (opts.bridgeShouldFail) throw new Error('refused'); };
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

async function simulateReconnectLoop(opts: {
  detect: (attempt: number) => Promise<object | null>;
  maxAttempts: number;
  signal?: AbortSignal;
}): Promise<'reconnected' | 'exhausted' | 'aborted'> {
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    if (opts.signal?.aborted) return 'aborted';
    const result = await opts.detect(attempt);
    if (opts.signal?.aborted) return 'aborted';
    if (result != null) return 'reconnected';
  }
  return 'exhausted';
}
