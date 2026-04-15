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
 * When the reconnect loop exhausts, the bridge spawns a new primary as a
 * detached child process (same binary, HTTP transport) and restarts the
 * reconnect loop. The stdio connection stays alive — the IDE client never
 * disconnects. Respawning is bounded by `maxRespawnAttempts`; after the
 * budget is spent the bridge shuts down cleanly.
 *
 * TOOL CALLS DURING RECONNECT
 * Rather than silently dropping messages (agent hangs), the bridge returns
 * an immediate human-readable JSON-RPC error while reconnecting.
 *
 * DESIGN NOTES
 * - ConnectionState is a sealed discriminated union — no boolean flags.
 *   The reconnecting variant carries its own respawnBudget so state is
 *   self-contained and transitions are explicit.
 * - Shutdown uses AbortController, not a mutable boolean.
 * - t.onclose is idempotent: if a reconnect loop is already running,
 *   a second close event is a no-op. Prevents concurrent loops.
 * - handleReconnectOutcome is a named, testable function that drives all
 *   state transitions after reconnectWithBackoff returns.
 * - SpawnLike and FetchLike are injected for testability.
 * - All shutdown paths go through a single performShutdown() function.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BridgeConfig {
  /** Base delay (ms) for exponential backoff between reconnect attempts. */
  readonly reconnectBaseDelayMs: number;
  /** Maximum reconnect attempts per cycle before triggering a primary respawn. */
  readonly reconnectMaxAttempts: number;
  /** Timeout (ms) before logging a warning about a slow primary response. */
  readonly forwardTimeoutMs: number;
  /**
   * How many times the bridge may spawn a new primary per connection-failure
   * cycle before giving up and shutting down.
   *
   * This is a per-death-cycle budget, not a lifetime budget. Each time the
   * primary closes the connection, t.onclose reseeds the budget to this
   * value. So a bridge that survives multiple primary crashes over hours will
   * get `maxRespawnAttempts` spawn attempts for each crash, not total.
   *
   * Rationale: a long-running bridge should not permanently give up after
   * hitting a quota set at startup hours ago. The budget exists to prevent
   * rapid-crash loops, not to cap total lifetime spawn activity.
   */
  readonly maxRespawnAttempts: number;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  reconnectBaseDelayMs: 250,
  reconnectMaxAttempts: 8,
  forwardTimeoutMs: 30_000,
  maxRespawnAttempts: 3,
};

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

type HttpBridgeTransport = {
  readonly send: (msg: JSONRPCMessage) => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * Connection state between this bridge and the primary WorkRail server.
 *
 * The reconnecting variant carries its own respawnBudget so all relevant
 * state travels together — no separate mutable variable needed.
 *
 * Invariant: reconnecting.respawnBudget >= 0. When budget reaches 0 and
 * reconnects are exhausted, the state transitions to closed.
 */
export type ConnectionState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'connected'; readonly transport: HttpBridgeTransport }
  | {
      readonly kind: 'reconnecting';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly respawnBudget: number;
    }
  | { readonly kind: 'closed' };

/**
 * Outcome of a reconnect attempt sequence — errors are data, not callbacks.
 * The caller switches exhaustively on the result via handleReconnectOutcome.
 */
export type ReconnectOutcome =
  | { readonly kind: 'reconnected'; readonly transport: HttpBridgeTransport }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'aborted' };

// ---------------------------------------------------------------------------
// Injectable side-effect types
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  opts: {
    readonly env: NodeJS.ProcessEnv;
    readonly detached: boolean;
    readonly stdio: 'ignore';
  },
) => { unref: () => void };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check whether a healthy WorkRail MCP server is accepting connections on the
 * given port. Uses /workrail-health to distinguish WorkRail from any other
 * HTTP server on the same port.
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
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Primary respawn
// ---------------------------------------------------------------------------

/**
 * Spawn a new WorkRail primary process as a detached child.
 *
 * Uses the same binary (process.argv[1]) with WORKRAIL_TRANSPORT=http so it
 * starts as the HTTP primary. Jitter + pre-spawn detection check reduces
 * stampede when multiple bridges exhaust simultaneously.
 *
 * Spawn errors are caught and logged — the caller handles failure via the
 * reconnect loop's exhaustion path.
 */
export async function spawnPrimary(
  port: number,
  deps: { spawn: SpawnLike; fetch?: FetchLike },
): Promise<void> {
  // Jitter: reduces stampede when multiple bridges exhaust at the same time.
  await sleep(Math.random() * 300);

  // Post-jitter check: another bridge may have already spawned the primary.
  const alreadyUp = await detectHealthyPrimary(port, { retries: 1, fetch: deps.fetch });
  if (alreadyUp != null) {
    console.error('[Bridge] Primary already available after jitter — skipping spawn');
    return;
  }

  const scriptPath = process.argv[1];
  if (scriptPath == null) {
    console.error('[Bridge] Cannot spawn primary: process.argv[1] is undefined');
    return;
  }

  console.error('[Bridge] Spawning new WorkRail primary process');
  try {
    const child = deps.spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        WORKRAIL_TRANSPORT: 'http',
        WORKRAIL_HTTP_PORT: String(port),
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    console.error('[Bridge] Failed to spawn primary:', err);
    // Reconnect loop will continue polling; if spawn genuinely failed the
    // budget will eventually drain and the bridge will shut down.
  }
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
 * Returns a ReconnectOutcome — caller switches exhaustively.
 * First attempt is immediate; backoff applies between subsequent attempts.
 */
export async function reconnectWithBackoff(deps: ReconnectDeps): Promise<ReconnectOutcome> {
  const { detect, config, signal } = deps;
  const { reconnectBaseDelayMs, reconnectMaxAttempts } = config;

  for (let attempt = 0; attempt < reconnectMaxAttempts; attempt++) {
    if (signal.aborted) return { kind: 'aborted' };

    const transport = await detect(attempt);
    if (transport != null) return { kind: 'reconnected', transport };

    if (attempt < reconnectMaxAttempts - 1) {
      const delay = reconnectBaseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
      if (signal.aborted) return { kind: 'aborted' };
    }
  }

  return { kind: 'exhausted' };
}

// ---------------------------------------------------------------------------
// Reconnect outcome handler
// ---------------------------------------------------------------------------

type OutcomeHandlerDeps = {
  readonly setConnectionState: (state: ConnectionState) => void;
  readonly performShutdown: (reason: string) => void;
  readonly startReconnectLoop: () => void;
  /** Triggers a primary spawn. Async; errors are logged inside. */
  readonly triggerSpawn: () => Promise<void>;
  readonly config: Pick<BridgeConfig, 'reconnectMaxAttempts'>;
};

/**
 * Drive state transitions after reconnectWithBackoff resolves.
 *
 * Takes the reconnect outcome and the state that was active when the loop
 * started (carries the respawnBudget). All state transitions are explicit
 * and exhaustive. Extracted as a named function for independent testability.
 */
export async function handleReconnectOutcome(
  outcome: ReconnectOutcome,
  reconnectingState: Extract<ConnectionState, { kind: 'reconnecting' }>,
  deps: OutcomeHandlerDeps,
): Promise<void> {
  switch (outcome.kind) {
    case 'reconnected':
      // State was set to 'connected' atomically inside buildConnectedTransport
      // when t.start() resolved. Single owner; no duplicate set here.
      console.error('[Bridge] Reconnected to primary');
      return;

    case 'aborted':
      // Shutdown already in progress via performShutdown — no action needed.
      return;

    case 'exhausted':
      if (reconnectingState.respawnBudget > 0) {
        await deps.triggerSpawn();
        // Restart with decremented budget — carries the invariant forward.
        deps.setConnectionState({
          kind: 'reconnecting',
          attempt: 0,
          maxAttempts: deps.config.reconnectMaxAttempts,
          respawnBudget: reconnectingState.respawnBudget - 1,
        });
        deps.startReconnectLoop();
      } else {
        deps.setConnectionState({ kind: 'closed' });
        deps.performShutdown('respawn budget exhausted — primary repeatedly unavailable');
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Bridge server
// ---------------------------------------------------------------------------

export async function startBridgeServer(
  primaryPort: number,
  config: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
  // Injectable side effects for testability. Production callers use defaults.
  deps: { spawn?: SpawnLike; fetch?: FetchLike } = {},
): Promise<void> {
  console.error(`[Bridge] Forwarding stdio → http://localhost:${primaryPort}/mcp`);

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  // Dynamic import — must be async-compatible and works in both ESM and CJS.
  // Do NOT use require('child_process') here; this module compiles to ESM where
  // require is not defined. Dynamic import is the correct cross-format approach.
  const { spawn: nodeSpawn } = await import('child_process');
  const spawnFn: SpawnLike =
    deps.spawn ?? ((command, args, opts) => nodeSpawn(command, args as string[], opts));

  // AbortController for shutdown — platform-native, not a mutable boolean.
  const shutdownController = new AbortController();
  const { signal: shutdownSignal } = shutdownController;

  const stdioTransport = new StdioServerTransport();

  // Single explicitly managed mutable variable. All transitions go through
  // setConnectionState(). The 'connecting' state represents the period before
  // any successful connection has been established, distinguishing it from
  // 'reconnecting' (a prior connection existed and was lost).
  let connectionState: ConnectionState = { kind: 'connecting' };

  const setConnectionState = (next: ConnectionState): void => {
    connectionState = next;
  };

  // ---------------------------------------------------------------------------
  // Single shutdown path
  // ---------------------------------------------------------------------------

  const performShutdown = (reason: string): void => {
    if (shutdownSignal.aborted) return;
    shutdownController.abort();
    console.error(`[Bridge] Shutting down: ${reason}`);
    const state = connectionState;
    void (state.kind === 'connected' ? state.transport.close() : Promise.resolve()).finally(
      () => process.exit(0),
    );
  };

  // ---------------------------------------------------------------------------
  // Transport factory
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

    // Primary close triggers reconnect.
    // Idempotent: no-op if connecting/reconnecting (loop already in progress).
    t.onclose = () => {
      if (shutdownSignal.aborted) return;
      const current = connectionState;
      if (current.kind === 'connecting' || current.kind === 'reconnecting') return;
      console.error('[Bridge] Primary connection lost — reconnecting');
      setConnectionState({
        kind: 'reconnecting',
        attempt: 0,
        maxAttempts: config.reconnectMaxAttempts,
        respawnBudget: config.maxRespawnAttempts,
      });
      startReconnectLoop();
    };

    try {
      await t.start();
      // Transition to 'connected' atomically with the transport becoming live.
      // Single owner of this transition: buildConnectedTransport.
      // This closes the gap between t.start() resolving and the caller setting
      // state — any t.onclose firing after this point sees 'connected'.
      const transport: HttpBridgeTransport = { send: (msg) => t.send(msg), close: () => t.close() };
      setConnectionState({ kind: 'connected', transport });
      return transport;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Reconnect loop
  // ---------------------------------------------------------------------------

  const startReconnectLoop = (): void => {
    // Snapshot current state — must be reconnecting to proceed.
    const stateAtStart = connectionState;
    if (stateAtStart.kind !== 'reconnecting') return; // idempotent guard

    void reconnectWithBackoff({
      signal: shutdownSignal,
      config,
      detect: async (attempt) => {
        console.error(`[Bridge] Reconnect attempt ${attempt + 1}/${config.reconnectMaxAttempts}`);
        const detected = await detectHealthyPrimary(primaryPort, { retries: 1, fetch: deps.fetch });
        if (detected == null) return null;
        return buildConnectedTransport();
      },
    })
      .then((outcome) => {
        // Snapshot again at outcome time — state may have changed (e.g. shutdown).
        const stateAtOutcome = connectionState;
        if (stateAtOutcome.kind !== 'reconnecting') return; // race: already handled
        return handleReconnectOutcome(outcome, stateAtOutcome, {
          setConnectionState,
          performShutdown,
          startReconnectLoop,
          triggerSpawn: () => spawnPrimary(primaryPort, { spawn: spawnFn, fetch: deps.fetch }),
          config,
        });
      })
      .catch((err) => {
        // An unexpected error in the reconnect loop or outcome handler — log it
        // so it is visible (Observability as a constraint) rather than silently
        // swallowed by the void discard. The loop is dead at this point; if the
        // primary is still alive the bridge will continue forwarding; if not, the
        // next t.onclose will start a fresh loop.
        console.error('[Bridge] Unexpected error in reconnect loop:', err);
      });
  };

  // ---------------------------------------------------------------------------
  // Message routing: IDE → primary
  // Control flow driven by ConnectionState — exhaustive switch, no flag checks.
  // ---------------------------------------------------------------------------

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    const state = connectionState; // snapshot to avoid TOCTOU

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

      case 'connecting':
        // Same behavior as reconnecting: return an immediate error so the
        // agent doesn't hang. Reaching this state means the bridge is still
        // establishing its first connection — rare but possible if the IDE
        // sends a message before the initial handshake completes.
        // Falls through intentionally to the reconnecting case.
        // eslint-disable-next-line no-fallthrough
      case 'reconnecting': {
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
        return;
    }
  };

  stdioTransport.onerror = (err) => console.error('[Bridge] Stdio error:', err);

  // ---------------------------------------------------------------------------
  // Initial connection
  // ---------------------------------------------------------------------------

  // buildConnectedTransport sets state to 'connected' atomically on success.
  const initialTransport = await buildConnectedTransport();
  if (initialTransport == null) {
    throw new Error(`[Bridge] Failed to connect to primary on port ${primaryPort}`);
  }
  console.error('[Bridge] Connected to primary');

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
