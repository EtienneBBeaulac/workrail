/**
 * Bridge transport entry point for WorkRail MCP server.
 *
 * When a healthy primary WorkRail server is already running on the MCP HTTP
 * port, secondary instances (firebender worktrees, additional Claude Code
 * sessions) start in bridge mode rather than spinning up a full second server.
 *
 *   IDE/firebender (stdio) ←→ WorkRail bridge ←→ primary WorkRail (:3100)
 *
 * PRIMARY DEATH + AUTOMATIC RESPAWN
 * On primary close, the bridge reconnects with exponential backoff. When all
 * reconnect attempts are exhausted, it exits cleanly (exit 0). The IDE client
 * auto-restarts the MCP command; the restarted process either bridges to a new
 * primary or wins the lock election and starts the full server + dashboard.
 *
 * TOOL CALLS DURING RECONNECT
 * Rather than silently dropping messages (causing agent hangs), the bridge
 * returns an immediate, human-readable JSON-RPC error while reconnecting.
 *
 * DESIGN NOTES
 * - ConnectionState is a sealed discriminated union — no boolean flags.
 * - Shutdown is an AbortSignal, not a mutable boolean.
 * - detectHealthyPrimary takes a fetch dependency for testability.
 * - The reconnect loop is a named pure-ish function with explicit params.
 * - All state transitions are explicit; no shared mutable state between closures.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  /** Base delay (ms) for exponential backoff between reconnect attempts. */
  readonly reconnectBaseDelayMs: number;
  /** Maximum reconnect attempts before giving up and exiting. */
  readonly reconnectMaxAttempts: number;
  /** Timeout (ms) before logging a warning about a slow primary response. */
  readonly forwardTimeoutMs: number;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  reconnectBaseDelayMs: 250,
  reconnectMaxAttempts: 8,
  forwardTimeoutMs: 30_000,
};

// ---------------------------------------------------------------------------
// Connection state — sealed discriminated union, no boolean flags
// ---------------------------------------------------------------------------

type HttpBridgeTransport = {
  readonly send: (msg: JSONRPCMessage) => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * The connection state between this bridge and the primary WorkRail server.
 * All state is immutable; transitions produce a new ConnectionState value.
 *
 * Invariant: `reconnecting.attempt < reconnecting.maxAttempts` is always true
 * — once attempt reaches maxAttempts, the state transitions to `closed`.
 */
type ConnectionState =
  | { readonly kind: 'connected'; readonly transport: HttpBridgeTransport }
  | { readonly kind: 'reconnecting'; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: 'closed' };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Check whether a healthy WorkRail MCP server is accepting connections on the
 * given port. Uses /workrail-health to distinguish WorkRail from any other
 * HTTP server on the same port.
 *
 * Returns the port number if healthy, null otherwise.
 */
export async function detectHealthyPrimary(
  port: number,
  opts: { retries?: number; baseDelayMs?: number; fetch?: FetchLike } = {},
): Promise<number | null> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchFn(`http://localhost:${port}/workrail-health`, {
        method: 'GET',
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { service?: string } | null;
        if (body?.service === 'workrail') {
          return port;
        }
      }
    } catch {
      // Connection refused or timeout — not available yet.
    }
    if (attempt < retries - 1) {
      await sleep(baseDelayMs * (attempt + 1)); // linear: 200ms, 400ms, 600ms
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reconnect loop — named pure-ish function with explicit dependencies
// ---------------------------------------------------------------------------

type ReconnectDeps = {
  readonly detect: (attempt: number) => Promise<HttpBridgeTransport | null>;
  readonly onReconnected: (transport: HttpBridgeTransport) => void;
  readonly onExhausted: () => void;
  readonly config: Pick<BridgeConfig, 'reconnectBaseDelayMs' | 'reconnectMaxAttempts'>;
  readonly signal: AbortSignal;
};

/**
 * Reconnect to the primary with exponential backoff.
 *
 * Drives state transitions: reconnecting(n) → connected | reconnecting(n+1) | closed.
 * Calls onReconnected or onExhausted exactly once. Stops early on abort.
 */
async function reconnectWithBackoff(deps: ReconnectDeps): Promise<void> {
  const { detect, onReconnected, onExhausted, config, signal } = deps;
  const { reconnectBaseDelayMs, reconnectMaxAttempts } = config;

  for (let attempt = 0; attempt < reconnectMaxAttempts; attempt++) {
    const delay = reconnectBaseDelayMs * Math.pow(2, attempt);
    await sleep(delay);

    if (signal.aborted) return;

    const transport = await detect(attempt);
    if (transport != null) {
      onReconnected(transport);
      return;
    }
  }

  onExhausted();
}

// ---------------------------------------------------------------------------
// Bridge server
// ---------------------------------------------------------------------------

export async function startBridgeServer(
  primaryPort: number,
  config: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
): Promise<void> {
  console.error(`[Bridge] Forwarding stdio → http://localhost:${primaryPort}/mcp`);

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  // AbortController for shutdown — platform-native, not a mutable boolean flag.
  const shutdownController = new AbortController();
  const { signal: shutdownSignal } = shutdownController;

  const stdioTransport = new StdioServerTransport();

  // Mutable connection state — the single explicitly managed mutable variable.
  // All writes go through setConnectionState() to keep transitions traceable.
  let connectionState: ConnectionState = {
    kind: 'reconnecting',
    attempt: 0,
    maxAttempts: config.reconnectMaxAttempts,
  };

  const setConnectionState = (next: ConnectionState): void => {
    connectionState = next;
  };

  // Build a connected HttpBridgeTransport. Returns null on failure.
  const buildConnectedTransport = async (): Promise<HttpBridgeTransport | null> => {
    const url = new URL(`http://localhost:${primaryPort}/mcp`);
    const t = new StreamableHTTPClientTransport(url);

    t.onerror = (err) => console.error('[Bridge] HTTP transport error:', err);

    // Primary → IDE
    t.onmessage = (msg: JSONRPCMessage) => {
      void stdioTransport.send(msg).catch((err) => {
        console.error('[Bridge] Forward to IDE failed:', err);
      });
    };

    // Primary close triggers reconnect loop.
    t.onclose = () => {
      if (shutdownSignal.aborted) return;
      console.error('[Bridge] Primary connection lost — reconnecting');
      setConnectionState({
        kind: 'reconnecting',
        attempt: 0,
        maxAttempts: config.reconnectMaxAttempts,
      });
      startReconnectLoop();
    };

    try {
      await t.start();
      return { send: (msg) => t.send(msg), close: () => t.close() };
    } catch {
      return null;
    }
  };

  // Reconnect loop — called whenever primary connection drops.
  const startReconnectLoop = (): void => {
    void reconnectWithBackoff({
      signal: shutdownSignal,
      config,
      detect: async (attempt) => {
        if (shutdownSignal.aborted) return null;
        console.error(`[Bridge] Reconnect attempt ${attempt + 1}/${config.reconnectMaxAttempts}`);
        const detected = await detectHealthyPrimary(primaryPort, { retries: 1 });
        if (detected == null) return null;
        return buildConnectedTransport();
      },
      onReconnected: (transport) => {
        setConnectionState({ kind: 'connected', transport });
        console.error('[Bridge] Reconnected to primary');
      },
      onExhausted: () => {
        setConnectionState({ kind: 'closed' });
        console.error(
          '[Bridge] Primary unresponsive after all retries — exiting for IDE respawn',
        );
        process.exit(0);
      },
    });
  };

  // ---------------------------------------------------------------------------
  // Message routing: IDE → primary
  // Control flow is driven by the connection state discriminated union.
  // ---------------------------------------------------------------------------

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    const state = connectionState; // snapshot — avoid TOCTOU on mutable ref

    switch (state.kind) {
      case 'connected': {
        const timer = setTimeout(() => {
          console.error(
            '[Bridge] Warning: no response from primary after',
            config.forwardTimeoutMs,
            'ms',
          );
        }, config.forwardTimeoutMs);
        void state.transport
          .send(msg)
          .catch((err) => console.error('[Bridge] Forward to primary failed:', err))
          .finally(() => clearTimeout(timer));
        return;
      }

      case 'reconnecting': {
        // Return an immediate error so the agent doesn't hang on MCP timeout.
        const req = msg as { id?: string | number };
        if (req.id != null) {
          void stdioTransport
            .send({
              jsonrpc: '2.0',
              id: req.id,
              error: {
                code: -32603,
                message:
                  'WorkRail primary server is temporarily unavailable — reconnecting. ' +
                  'Wait a few seconds and retry your tool call. ' +
                  'If this persists, tell the user: ' +
                  '"WorkRail disconnected. Check the terminal running workrail for the ' +
                  'error message, then run /mcp in Claude to reconnect."',
              },
            } as JSONRPCMessage)
            .catch(() => undefined);
        }
        return;
      }

      case 'closed':
        // Bridge is shutting down — no-op.
        return;
    }
  };

  stdioTransport.onerror = (err) => console.error('[Bridge] Stdio error:', err);

  // ---------------------------------------------------------------------------
  // Initial connection
  // ---------------------------------------------------------------------------

  const initialTransport = await buildConnectedTransport();
  if (initialTransport == null) {
    throw new Error(`[Bridge] Failed to connect to primary on port ${primaryPort}`);
  }
  setConnectionState({ kind: 'connected', transport: initialTransport });
  console.error('[Bridge] Connected to primary');

  // Guard stdout before wiring stdio (same rationale as stdio-entry.ts).
  process.stdout.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
        ? '[Bridge] stdout pipe broken, shutting down'
        : `[Bridge] stdout error: ${String(err)}`,
    );
    shutdownController.abort();
    const state = connectionState;
    void (state.kind === 'connected' ? state.transport.close() : Promise.resolve()).finally(
      () => process.exit(0),
    );
  });

  await stdioTransport.start();
  console.error('[Bridge] WorkRail MCP bridge running on stdio');

  // ---------------------------------------------------------------------------
  // Shutdown hooks — AbortController, not mutable flags
  // ---------------------------------------------------------------------------

  process.stdin.once('end', () => {
    console.error('[Bridge] stdin closed, shutting down');
    shutdownController.abort();
    const state = connectionState;
    void (state.kind === 'connected' ? state.transport.close() : Promise.resolve()).finally(
      () => process.exit(0),
    );
  });

  const shutdown = (signal: string) => {
    if (shutdownSignal.aborted) return;
    shutdownController.abort();
    console.error(`[Bridge] Received ${signal}, shutting down`);
    const state = connectionState;
    void (state.kind === 'connected' ? state.transport.close() : Promise.resolve()).finally(
      () => process.exit(0),
    );
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
