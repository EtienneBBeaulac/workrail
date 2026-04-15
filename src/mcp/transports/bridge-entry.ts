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
 * reconnect attempts are exhausted, it shuts down cleanly (exit 0). The IDE
 * client auto-restarts the MCP command; the restarted process either bridges
 * to a new primary or wins the lock election and starts the full server +
 * dashboard.
 *
 * TOOL CALLS DURING RECONNECT
 * Rather than silently dropping messages (causing agent hangs), the bridge
 * returns an immediate, human-readable JSON-RPC error while reconnecting.
 *
 * DESIGN NOTES
 * - ConnectionState is a sealed discriminated union — no boolean flags.
 * - Shutdown is an AbortSignal, not a mutable boolean.
 * - reconnectWithBackoff returns a ReconnectOutcome (errors are data, not
 *   callbacks). The caller switches exhaustively on the result.
 * - detectHealthyPrimary takes a fetch dependency for testability.
 * - All shutdown paths go through a single performShutdown() function.
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
// Domain types
// ---------------------------------------------------------------------------

type HttpBridgeTransport = {
  readonly send: (msg: JSONRPCMessage) => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * The connection state between this bridge and the primary WorkRail server.
 * Exported for use in tests and diagnostics.
 *
 * Invariant: `reconnecting.attempt < reconnecting.maxAttempts` always holds —
 * once `attempt` reaches `maxAttempts`, the state transitions to `closed`.
 */
export type ConnectionState =
  | { readonly kind: 'connected'; readonly transport: HttpBridgeTransport }
  | { readonly kind: 'reconnecting'; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: 'closed' };

/**
 * Outcome of a reconnect attempt sequence. Errors are data — the caller
 * switches exhaustively rather than receiving side-effectful callbacks.
 */
export type ReconnectOutcome =
  | { readonly kind: 'reconnected'; readonly transport: HttpBridgeTransport }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'aborted' };

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
        if (body?.service === 'workrail') return port;
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
// Reconnect loop
// ---------------------------------------------------------------------------

type ReconnectDeps = {
  readonly detect: (attempt: number) => Promise<HttpBridgeTransport | null>;
  readonly config: Pick<BridgeConfig, 'reconnectBaseDelayMs' | 'reconnectMaxAttempts'>;
  readonly signal: AbortSignal;
};

/**
 * Attempt to reconnect to the primary with exponential backoff.
 *
 * Tries immediately on the first attempt, then backs off between subsequent
 * attempts. Returns a ReconnectOutcome — the caller switches exhaustively.
 */
export async function reconnectWithBackoff(deps: ReconnectDeps): Promise<ReconnectOutcome> {
  const { detect, config, signal } = deps;
  const { reconnectBaseDelayMs, reconnectMaxAttempts } = config;

  for (let attempt = 0; attempt < reconnectMaxAttempts; attempt++) {
    if (signal.aborted) return { kind: 'aborted' };

    const transport = await detect(attempt);
    if (transport != null) return { kind: 'reconnected', transport };

    // Only sleep before the next attempt, not after the last.
    if (attempt < reconnectMaxAttempts - 1) {
      const delay = reconnectBaseDelayMs * Math.pow(2, attempt); // 250 500 1000...
      await sleep(delay);
      if (signal.aborted) return { kind: 'aborted' };
    }
  }

  return { kind: 'exhausted' };
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

  // AbortController for shutdown — platform-native, not a mutable boolean.
  const shutdownController = new AbortController();
  const { signal: shutdownSignal } = shutdownController;

  const stdioTransport = new StdioServerTransport();

  // Single explicitly managed mutable variable — all writes via setConnectionState.
  let connectionState: ConnectionState = {
    kind: 'reconnecting',
    attempt: 0,
    maxAttempts: config.reconnectMaxAttempts,
  };

  const setConnectionState = (next: ConnectionState): void => {
    connectionState = next;
  };

  // ---------------------------------------------------------------------------
  // Single shutdown path — all shutdown triggers funnel here.
  // ---------------------------------------------------------------------------

  const performShutdown = (reason: string): void => {
    if (shutdownSignal.aborted) return; // guard against double-invocation
    shutdownController.abort();
    console.error(`[Bridge] Shutting down: ${reason}`);
    const state = connectionState;
    void (state.kind === 'connected' ? state.transport.close() : Promise.resolve()).finally(
      () => process.exit(0),
    );
  };

  // ---------------------------------------------------------------------------
  // Transport factory + reconnect loop
  // ---------------------------------------------------------------------------

  const buildConnectedTransport = async (): Promise<HttpBridgeTransport | null> => {
    const t = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${primaryPort}/mcp`),
    );

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
      setConnectionState({ kind: 'reconnecting', attempt: 0, maxAttempts: config.reconnectMaxAttempts });
      startReconnectLoop();
    };

    try {
      await t.start();
      return { send: (msg) => t.send(msg), close: () => t.close() };
    } catch {
      return null;
    }
  };

  const startReconnectLoop = (): void => {
    void reconnectWithBackoff({
      signal: shutdownSignal,
      config,
      detect: async (attempt) => {
        console.error(`[Bridge] Reconnect attempt ${attempt + 1}/${config.reconnectMaxAttempts}`);
        const detected = await detectHealthyPrimary(primaryPort, { retries: 1 });
        if (detected == null) return null;
        return buildConnectedTransport();
      },
    }).then((outcome) => {
      switch (outcome.kind) {
        case 'reconnected':
          setConnectionState({ kind: 'connected', transport: outcome.transport });
          console.error('[Bridge] Reconnected to primary');
          return;
        case 'exhausted':
          setConnectionState({ kind: 'closed' });
          performShutdown('primary unresponsive after all retries — IDE will respawn');
          return;
        case 'aborted':
          // Shutdown already in progress via performShutdown — no action needed.
          return;
      }
    });
  };

  // ---------------------------------------------------------------------------
  // Message routing: IDE → primary
  // Control flow driven by ConnectionState — exhaustive switch, no flag checks.
  // ---------------------------------------------------------------------------

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    const state = connectionState; // snapshot to avoid TOCTOU on the mutable ref

    switch (state.kind) {
      case 'connected': {
        const timer = setTimeout(() => {
          console.error('[Bridge] Warning: no response from primary after', config.forwardTimeoutMs, 'ms');
        }, config.forwardTimeoutMs);
        void state.transport
          .send(msg)
          .catch((err) => console.error('[Bridge] Forward to primary failed:', err))
          .finally(() => clearTimeout(timer));
        return;
      }

      case 'reconnecting': {
        // Return an immediate error so the agent doesn't hang on MCP timeout.
        // Notifications have no id — only requests need a response.
        if ('id' in msg && msg.id != null) {
          void stdioTransport
            .send({
              jsonrpc: '2.0',
              id: msg.id,
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
        return; // Bridge is shutting down — no-op.
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
    const reason =
      code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED'
        ? 'stdout pipe broken (client disconnected)'
        : `stdout error: ${String(err)}`;
    performShutdown(reason);
  });

  await stdioTransport.start();
  console.error('[Bridge] WorkRail MCP bridge running on stdio');

  // ---------------------------------------------------------------------------
  // Shutdown hooks — all funnel to performShutdown
  // ---------------------------------------------------------------------------

  process.stdin.once('end', () => performShutdown('stdin closed'));
  process.once('SIGINT', () => performShutdown('SIGINT'));
  process.once('SIGTERM', () => performShutdown('SIGTERM'));
  process.once('SIGHUP', () => performShutdown('SIGHUP'));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
