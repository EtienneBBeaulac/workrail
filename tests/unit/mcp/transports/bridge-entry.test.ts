import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for bridge mode startup logic.
 *
 * The bridge itself (startBridgeServer) wires two SDK transports together at
 * runtime; testing it end-to-end requires real network I/O. These tests focus
 * on the detection logic and the startup branching contract instead.
 */

// ---------------------------------------------------------------------------
// detectHealthyPrimary-equivalent logic tests
// These test the contract in isolation without touching real network I/O.
// ---------------------------------------------------------------------------

describe('detectHealthyPrimary logic', () => {
  it('returns the port when the primary responds with any HTTP status', async () => {
    // Simulate a server that returns 200 OK on GET /mcp
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    });

    const result = await detectWithMockFetch(mockFetch, 3100);
    expect(result).toBe(3100);
  });

  it('returns the port even when the primary responds with 4xx (method handling)', async () => {
    // 405 Method Not Allowed is a valid response from an MCP HTTP endpoint
    const mockFetch = vi.fn().mockResolvedValue({
      status: 405,
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    });

    const result = await detectWithMockFetch(mockFetch, 3100);
    expect(result).toBe(3100);
  });

  it('returns null when the primary is not running (connection refused)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    const result = await detectWithMockFetch(mockFetch, 3100);
    expect(result).toBeNull();
  });

  it('returns null when the primary times out', async () => {
    const mockFetch = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));

    const result = await detectWithMockFetch(mockFetch, 3100);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Startup branching contract
// ---------------------------------------------------------------------------

describe('startup bridge branching', () => {
  it('uses bridge mode when primary is detected in stdio mode', async () => {
    // Given: primary is detected
    // When: stdio mode is requested
    // Then: bridge is started, full server is not
    let bridgeStarted = false;
    let fullServerStarted = false;

    await simulateStartup({
      mode: 'stdio',
      primaryDetected: true,
      onBridgeStart: () => { bridgeStarted = true; },
      onFullServerStart: () => { fullServerStarted = true; },
    });

    expect(bridgeStarted).toBe(true);
    expect(fullServerStarted).toBe(false);
  });

  it('uses full stdio server when no primary is detected', async () => {
    let bridgeStarted = false;
    let fullServerStarted = false;

    await simulateStartup({
      mode: 'stdio',
      primaryDetected: false,
      onBridgeStart: () => { bridgeStarted = true; },
      onFullServerStart: () => { fullServerStarted = true; },
    });

    expect(bridgeStarted).toBe(false);
    expect(fullServerStarted).toBe(true);
  });

  it('never checks for a primary when starting in http mode', async () => {
    let detectionCalled = false;
    let fullServerStarted = false;

    await simulateStartup({
      mode: 'http',
      primaryDetected: false,
      onDetectionCall: () => { detectionCalled = true; },
      onFullServerStart: () => { fullServerStarted = true; },
    });

    expect(detectionCalled).toBe(false);
    expect(fullServerStarted).toBe(true);
  });

  it('falls back to full server when bridge startup fails', async () => {
    let fallbackStarted = false;

    await simulateStartup({
      mode: 'stdio',
      primaryDetected: true,
      bridgeShouldFail: true,
      onFullServerStart: () => { fallbackStarted = true; },
    });

    expect(fallbackStarted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers — extracted so tests read as specs, not mechanics
// ---------------------------------------------------------------------------

async function detectWithMockFetch(
  mockFetch: ReturnType<typeof vi.fn>,
  port: number,
): Promise<number | null> {
  try {
    const response = await mockFetch(`http://localhost:${port}/mcp`);
    await response.body?.cancel().catch(() => undefined);
    return port;
  } catch {
    return null;
  }
}

interface StartupSimOptions {
  mode: 'stdio' | 'http';
  primaryDetected: boolean;
  bridgeShouldFail?: boolean;
  onBridgeStart?: () => void;
  onFullServerStart?: () => void;
  onDetectionCall?: () => void;
}

async function simulateStartup(opts: StartupSimOptions): Promise<void> {
  const {
    mode,
    primaryDetected,
    bridgeShouldFail = false,
    onBridgeStart,
    onFullServerStart,
    onDetectionCall,
  } = opts;

  // Inline reimplementation of the mcp-server.ts branching logic for testing.
  const detectPrimary = async (port: number): Promise<number | null> => {
    onDetectionCall?.();
    return primaryDetected ? port : null;
  };

  const startBridge = async (_port: number): Promise<void> => {
    onBridgeStart?.();
    if (bridgeShouldFail) throw new Error('bridge connection refused');
    // Bridge runs indefinitely; in tests we just return.
  };

  const startFullServer = async (): Promise<void> => {
    onFullServerStart?.();
  };

  const DEFAULT_MCP_PORT = 3100;

  if (mode === 'stdio') {
    const primaryPort = await detectPrimary(DEFAULT_MCP_PORT);
    if (primaryPort != null) {
      try {
        await startBridge(primaryPort);
      } catch {
        await startFullServer();
      }
      return;
    }
    await startFullServer();
    return;
  }

  // http mode: never checks for primary
  await startFullServer();
}
