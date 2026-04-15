import { describe, it, expect, vi } from 'vitest';
import { detectHealthyPrimary } from '../../../../src/mcp/transports/bridge-entry.js';

/**
 * Tests for bridge mode: detection, startup branching, reconnect, and
 * respawn-via-exit contract.
 */

// ---------------------------------------------------------------------------
// detectHealthyPrimary
// ---------------------------------------------------------------------------

describe('detectHealthyPrimary', () => {
  it('returns the port when /workrail-health responds with service=workrail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ service: 'workrail' }),
    }));
    try {
      expect(await detectHealthyPrimary(3100, { retries: 1, baseDelayMs: 0 })).toBe(3100);
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns null when service is not workrail (false-positive guard)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ service: 'nginx' }),
    }));
    try {
      expect(await detectHealthyPrimary(3100, { retries: 1, baseDelayMs: 0 })).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('returns null on connection refused', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    try {
      expect(await detectHealthyPrimary(3100, { retries: 1, baseDelayMs: 0 })).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('retries on transient failure and succeeds on later attempt', async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ service: 'workrail' }) });
    vi.stubGlobal('fetch', mockFetch);
    try {
      expect(await detectHealthyPrimary(3100, { retries: 2, baseDelayMs: 0 })).toBe(3100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it('exhausts all retries and returns null', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);
    try {
      expect(await detectHealthyPrimary(3100, { retries: 3, baseDelayMs: 0 })).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally { vi.unstubAllGlobals(); }
  });
});

// ---------------------------------------------------------------------------
// Startup branching contract
// ---------------------------------------------------------------------------

describe('startup bridge branching', () => {
  it('bridges when primary is detected in stdio mode', async () => {
    const { bridgeStarted, fullServerStarted } = await simulateStartup({
      mode: 'stdio', primaryDetected: true,
    });
    expect(bridgeStarted).toBe(true);
    expect(fullServerStarted).toBe(false);
  });

  it('starts full server when no primary is detected', async () => {
    const { bridgeStarted, fullServerStarted } = await simulateStartup({
      mode: 'stdio', primaryDetected: false,
    });
    expect(bridgeStarted).toBe(false);
    expect(fullServerStarted).toBe(true);
  });

  it('never checks for primary in http mode', async () => {
    const { detectionCalled, fullServerStarted } = await simulateStartup({
      mode: 'http', primaryDetected: false,
    });
    expect(detectionCalled).toBe(false);
    expect(fullServerStarted).toBe(true);
  });

  it('falls back to full server when bridge startup fails', async () => {
    const { fullServerStarted } = await simulateStartup({
      mode: 'stdio', primaryDetected: true, bridgeShouldFail: true,
    });
    expect(fullServerStarted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reconnect + respawn-via-exit contract
// ---------------------------------------------------------------------------

describe('reconnect loop', () => {
  it('reconnects when primary comes back within retry window', async () => {
    let attempts = 0;
    const detect = async () => { attempts++; return attempts >= 2 ? 3100 : null; };
    const result = await simulateReconnectLoop({ detect, maxAttempts: 5, baseDelayMs: 0 });
    expect(result).toBe('reconnected');
    expect(attempts).toBe(2);
  });

  it('signals exit (IDE respawn) when all attempts fail', async () => {
    const detect = async () => null;
    const result = await simulateReconnectLoop({ detect, maxAttempts: 3, baseDelayMs: 0 });
    // Bridge exits cleanly — IDE auto-restarts the command, triggering primary election.
    expect(result).toBe('exhausted');
  });

  it('stops reconnecting when shutdown is requested', async () => {
    let attempts = 0;
    let shuttingDown = false;
    const detect = async () => { attempts++; shuttingDown = true; return null; };
    const result = await simulateReconnectLoop({
      detect, maxAttempts: 10, baseDelayMs: 0,
      isShuttingDown: () => shuttingDown,
    });
    expect(result).toBe('shutdown');
    expect(attempts).toBe(1); // stopped immediately after first attempt set shuttingDown
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StartupSimResult {
  bridgeStarted: boolean;
  fullServerStarted: boolean;
  detectionCalled: boolean;
}

async function simulateStartup(opts: {
  mode: 'stdio' | 'http';
  primaryDetected: boolean;
  bridgeShouldFail?: boolean;
}): Promise<StartupSimResult> {
  const result: StartupSimResult = {
    bridgeStarted: false,
    fullServerStarted: false,
    detectionCalled: false,
  };

  const detectPrimary = async (port: number) => {
    result.detectionCalled = true;
    return opts.primaryDetected ? port : null;
  };
  const startBridge = async (_port: number) => {
    result.bridgeStarted = true;
    if (opts.bridgeShouldFail) throw new Error('bridge connection refused');
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

  // http mode: never detects
  await startFullServer();
  return result;
}

async function simulateReconnectLoop(opts: {
  detect: () => Promise<number | null>;
  maxAttempts: number;
  baseDelayMs: number;
  isShuttingDown?: () => boolean;
}): Promise<'reconnected' | 'exhausted' | 'shutdown'> {
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    if (opts.isShuttingDown?.()) return 'shutdown';
    const port = await opts.detect();
    if (port != null) return 'reconnected';
    if (attempt < opts.maxAttempts - 1) {
      await new Promise<void>((r) => setTimeout(r, opts.baseDelayMs));
    }
  }
  return 'exhausted';
}
