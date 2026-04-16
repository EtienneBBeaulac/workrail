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
 * When the reconnect loop exhausts, the bridge attempts to spawn a new primary.
 * Spawn coordination uses an O_EXCL lock file (~/.workrail/spawn-coordinator-PORT.lock)
 * so exactly one bridge wins the right to spawn — others skip the spawn and continue
 * polling. After the spawn budget is spent, bridges enter `waiting_for_primary` mode
 * (slow-polling every 5s indefinitely) rather than shutting down. The stdio connection
 * stays alive — the IDE client never disconnects.
 *
 * TOMBSTONE OPTIMIZATION
 * When the primary dies cleanly (stdin closed / SIGHUP), it writes a tombstone file
 * (~/.workrail/primary.tombstone) with its PID. Bridges that see a matching tombstone
 * skip the rapid-reconnect phase and enter slow-poll immediately, reducing churn.
 *
 * TOOL CALLS DURING RECONNECT / WAITING
 * Rather than silently dropping messages (agent hangs), the bridge returns
 * an immediate human-readable JSON-RPC error while reconnecting or waiting.
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
 * - SpawnLike, FetchLike, and WriteFileLike are injected for testability.
 * - All shutdown paths go through a single performShutdown() function.
 * - waiting_for_primary bridges still respond to requests with a helpful
 *   error so agents know to retry rather than hanging indefinitely.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { registerFatalHandlers, logStartup } from './fatal-exit.js';
import { logBridgeEvent } from './bridge-events.js';
import { readTombstone } from './primary-tombstone.js';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
   * cycle before giving up and entering waiting_for_primary mode.
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
  /**
   * How long (ms) before a spawn coordinator lock is considered stale.
   * Stale locks are left by bridges that crashed after winning the lock
   * but before releasing it. Default: 30 seconds.
   */
  readonly spawnLockStaleMs: number;
  /**
   * Interval (ms) between polls in waiting_for_primary mode.
   * Default: 5000ms (5 seconds).
   */
  readonly waitForPrimaryPollMs: number;
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  reconnectBaseDelayMs: 250,
  reconnectMaxAttempts: 8,
  forwardTimeoutMs: 30_000,
  maxRespawnAttempts: 3,
  spawnLockStaleMs: 30_000,
  waitForPrimaryPollMs: 5_000,
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
 * reconnects are exhausted, the state transitions to waiting_for_primary
 * (indefinite slow-poll) rather than closed.
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
  | { readonly kind: 'waiting_for_primary' }
  | { readonly kind: 'closed' };

/**
 * Outcome of a reconnect attempt sequence — errors are data, not callbacks.
 * The caller switches exhaustively on the result via handleReconnectOutcome.
 *
 * Note: 'reconnected' carries no transport. buildConnectedTransport owns the
 * connected state transition; detect() is responsible for both connecting and
 * signalling success as a boolean. reconnectWithBackoff is transport-agnostic.
 */
export type ReconnectOutcome =
  | { readonly kind: 'reconnected' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'aborted' };

/**
 * Result of attempting to acquire the spawn coordinator lock.
 * Only the winner should call spawnPrimary.
 */
export type SpawnLockResult =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'skipped'; readonly reason: string };

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

/**
 * Injectable synchronous file write. Mirrors fs.writeFileSync signature
 * for the subset we need. Used for coordinator lock file operations.
 */
export type WriteFileSyncLike = (path: string, content: string, opts: { flag: 'wx' }) => void;

/**
 * Injectable synchronous stat to get file mtime for stale lock detection.
 * Returns { mtimeMs: number } or throws on missing file.
 */
export type StatSyncLike = (path: string) => { mtimeMs: number };

/**
 * Injectable synchronous file unlink for lock release.
 */
export type UnlinkSyncLike = (path: string) => void;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The response shape of the /workrail-health endpoint.
 *
 * `pid` was added to enable orphan bridge detection: a bridge that originally
 * connected to primary PID X can detect when a different primary (PID Y) is
 * now running and exit cleanly rather than hijacking the new session. Old
 * primaries that do not return `pid` are treated as "unknown session" and
 * orphan detection is skipped for them.
 */
export type HealthResponse = {
  readonly port: number;
  readonly pid: number;
};

/**
 * Check whether a healthy WorkRail MCP server is accepting connections on the
 * given port. Uses /workrail-health to distinguish WorkRail from any other
 * HTTP server on the same port.
 *
 * Returns `{ port, pid }` when a healthy WorkRail primary is found, or `null`
 * if no healthy primary is available. The `pid` field enables orphan bridge
 * detection -- see startBridgeServer for usage.
 */
export async function detectHealthyPrimary(
  port: number,
  opts: { retries?: number; baseDelayMs?: number; fetch?: FetchLike } = {},
): Promise<HealthResponse | null> {
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
        const body = (await response.json().catch(() => null)) as { service?: string; pid?: number } | null;
        if (body?.service === 'workrail') {
          // pid is present on new primaries; absent on old ones. Both are valid.
          const pid = typeof body.pid === 'number' ? body.pid : 0;
          return { port, pid };
        }
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
// Spawn coordinator lock
// ---------------------------------------------------------------------------

/**
 * Returns the per-port spawn coordinator lock file path.
 *
 * Per-port (not global) so that multiple independent WorkRail setups on
 * different ports don't interfere with each other's spawn coordination.
 */
export function spawnLockPath(port: number): string {
  return join(homedir(), '.workrail', `spawn-coordinator-${port}.lock`);
}

/**
 * Try to acquire the spawn coordinator lock for the given port.
 *
 * Uses O_EXCL semantics (writeFileSync with flag:'wx') so at most one bridge
 * wins per death cycle. Losers get EEXIST and skip the spawn.
 *
 * Stale lock detection: if the lock's mtime is older than staleMs, the lock
 * was likely left by a bridge that crashed before releasing it. The stale lock
 * is deleted and a fresh attempt is made.
 *
 * The winner is responsible for releasing the lock via releaseSpawnLock()
 * after the spawn completes (success or failure).
 *
 * All errors except EEXIST/stale are treated as "skipped" to avoid blocking
 * spawn on unexpected FS conditions.
 */
export function acquireSpawnLock(
  port: number,
  staleMs: number,
  deps: {
    readonly writeFileSync?: WriteFileSyncLike;
    readonly statSync?: StatSyncLike;
    readonly unlinkSync?: UnlinkSyncLike;
  } = {},
): SpawnLockResult {
  const lockPath = spawnLockPath(port);
  const writeFn = deps.writeFileSync ?? writeFileSync;
  const statFn = deps.statSync ?? (require('fs') as typeof import('fs')).statSync;
  const unlinkFn = deps.unlinkSync ?? (require('fs') as typeof import('fs')).unlinkSync;

  // Ensure ~/.workrail exists before attempting to create the lock.
  // Mirrors the pattern in bridge-events.ts (mkdirSync before appendFileSync).
  try {
    mkdirSync(join(homedir(), '.workrail'), { recursive: true });
  } catch {
    // Directory creation failed — can't write lock, treat as skipped.
    return { kind: 'skipped', reason: 'mkdirSync failed' };
  }

  try {
    writeFn(lockPath, String(process.pid), { flag: 'wx' });
    logBridgeEvent({ kind: 'spawn_lock_acquired', port });
    return { kind: 'acquired' };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === 'EEXIST') {
      // Lock already exists. Check if it is stale.
      try {
        const stat = statFn(lockPath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > staleMs) {
          // Stale lock — the bridge that wrote it has likely crashed.
          // Unlink and try again.
          try {
            unlinkFn(lockPath);
          } catch {
            // Race: another bridge may have already removed it. That's fine.
          }
          // Retry once with the fresh state.
          try {
            writeFn(lockPath, String(process.pid), { flag: 'wx' });
            logBridgeEvent({ kind: 'spawn_lock_acquired', port });
            return { kind: 'acquired' };
          } catch {
            // Lost the race after reclaim — another bridge just won.
            logBridgeEvent({ kind: 'spawn_lock_skipped', reason: 'lost race after stale reclaim' });
            return { kind: 'skipped', reason: 'lost race after stale reclaim' };
          }
        }
        logBridgeEvent({ kind: 'spawn_lock_skipped', reason: 'lock held by another bridge' });
        return { kind: 'skipped', reason: 'lock held by another bridge' };
      } catch {
        // stat failed (file deleted between our write attempt and stat — another bridge just won).
        logBridgeEvent({ kind: 'spawn_lock_skipped', reason: 'lock contested' });
        return { kind: 'skipped', reason: 'lock contested' };
      }
    }

    // Unexpected error (EACCES, disk full, etc.) — treat as skipped.
    logBridgeEvent({ kind: 'spawn_lock_skipped', reason: `unexpected error: ${code ?? String(err)}` });
    return { kind: 'skipped', reason: `unexpected error: ${code ?? String(err)}` };
  }
}

/**
 * Release the spawn coordinator lock.
 *
 * Called by the lock winner after spawning (whether spawn succeeded or failed).
 * Silently ignores ENOENT (lock already released or stolen by stale reclaim).
 */
export function releaseSpawnLock(
  port: number,
  deps: { readonly unlinkSync?: UnlinkSyncLike } = {},
): void {
  const unlinkFn = deps.unlinkSync ?? (require('fs') as typeof import('fs')).unlinkSync;
  try {
    unlinkFn(spawnLockPath(port));
  } catch {
    // ENOENT or unexpected error — silently ignore.
  }
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
 * The coordinator lock in acquireSpawnLock provides the primary guarantee
 * against spawn storms. The jitter here is a secondary defense.
 *
 * Spawn errors are caught and logged — the caller handles failure via the
 * reconnect loop's exhaustion path.
 */
export async function spawnPrimary(
  port: number,
  deps: { spawn: SpawnLike; fetch?: FetchLike },
): Promise<void> {
  // Jitter: secondary defense against stampede. The primary defense is the
  // coordinator lock acquired before calling this function.
  //
  // WHY 2000ms (not 300ms): primary startup typically takes 500-1000ms.
  // With 300ms jitter, multiple bridges clear the window before the primary is up,
  // all check health (retries: 1), all see "not up yet", and all spawn — spawn storm.
  // With 2000ms jitter, bridges stagger across a window wider than startup time,
  // so the first to clear will find the primary already up via the post-jitter check.
  await sleep(Math.random() * 2000);

  // Post-jitter check: another bridge may have already spawned the primary.
  // 3 retries with 500ms base delay gives up to 3.5s of polling (0 + 500 + 1000ms),
  // which covers primaries that started late in the jitter window.
  const primaryDetected = await detectHealthyPrimary(port, { retries: 3, baseDelayMs: 500, fetch: deps.fetch });
  if (primaryDetected != null) {
    logBridgeEvent({ kind: 'spawn_skipped', reason: 'primary already up after jitter' });
    console.error('[Bridge] Primary already available after jitter — skipping spawn');
    return;
  }

  const scriptPath = process.argv[1];
  if (scriptPath == null) {
    console.error('[Bridge] Cannot spawn primary: process.argv[1] is undefined');
    return;
  }

  logBridgeEvent({ kind: 'spawn_primary', port });
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
    // budget will eventually drain and the bridge will enter waiting_for_primary.
  }
}

// ---------------------------------------------------------------------------
// Reconnect loop
// ---------------------------------------------------------------------------

type ReconnectDeps = {
  /**
   * Returns true when the primary is reachable and a transport has been
   * connected (with state set atomically inside the callback). Returns false
   * if not yet available. Transport ownership and state transitions are
   * entirely the responsibility of the detect implementation.
   */
  readonly detect: (attempt: number) => Promise<boolean>;
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

    const succeeded = await detect(attempt);
    if (succeeded) return { kind: 'reconnected' };

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
  readonly startWaitLoop: () => void;
  /** Triggers a primary spawn attempt (coordination lock included). Async; errors are logged inside. */
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
      logBridgeEvent({ kind: 'reconnected', attempt: reconnectingState.attempt });
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
        // Budget spent. Instead of shutting down (which permanently destroys
        // the IDE's WorkRail connection), enter waiting_for_primary mode:
        // slow-poll every 5s indefinitely until the primary returns.
        // The bridge stays alive as long as stdin is open.
        logBridgeEvent({
          kind: 'budget_exhausted',
          budgetUsed: reconnectingState.maxAttempts,
          respawnBudget: reconnectingState.respawnBudget,
        });
        console.error('[Bridge] Spawn budget exhausted — entering slow-poll mode (5s interval)');
        deps.setConnectionState({ kind: 'waiting_for_primary' });
        deps.startWaitLoop();
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
  deps: { spawn?: SpawnLike; fetch?: FetchLike; originalPrimaryPid?: number } = {},
): Promise<void> {
  // Register early — before any async work — so that exceptions thrown
  // during bridge startup exit cleanly rather than spinning. See fatal-exit.ts.
  registerFatalHandlers('bridge');
  logStartup('bridge', { primaryPort });
  logBridgeEvent({ kind: 'started', primaryPort, ppid: process.ppid });

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
    logBridgeEvent({ kind: 'shutdown', reason });
    process.stderr.write(
      `[Bridge] Shutdown pid=${process.pid} reason="${reason}" ts=${new Date().toISOString()}\n`,
    );
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
    // Idempotent: no-op if connecting/reconnecting/waiting (loop already in progress).
    t.onclose = () => {
      if (shutdownSignal.aborted) return;
      const current = connectionState;
      if (
        current.kind === 'connecting' ||
        current.kind === 'reconnecting' ||
        current.kind === 'waiting_for_primary'
      ) return;
      logBridgeEvent({ kind: 'disconnected' });
      console.error('[Bridge] Primary connection lost — reconnecting');

      // Tombstone check: if the primary wrote a tombstone matching our primary PID,
      // skip rapid reconnects and go directly to slow-poll mode.
      // This eliminates the ~10s of failing reconnect attempts when the primary
      // died cleanly (stdin EOF, SIGHUP).
      const connectedPrimaryPid = deps.originalPrimaryPid ?? 0;
      if (connectedPrimaryPid > 0) {
        const tombstone = readTombstone();
        if (tombstone?.pid === connectedPrimaryPid) {
          console.error('[Bridge] Tombstone detected — primary died cleanly, entering slow-poll mode');
          logBridgeEvent({ kind: 'waiting_for_primary', port: primaryPort });
          setConnectionState({ kind: 'waiting_for_primary' });
          startWaitLoop();
          return;
        }
      }

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
        // Check tombstone on every attempt: the primary may have written it
        // after our first attempt failed. If it matches, short-circuit to slow-poll.
        const connectedPrimaryPid = deps.originalPrimaryPid ?? 0;
        if (connectedPrimaryPid > 0) {
          const tombstone = readTombstone();
          if (tombstone?.pid === connectedPrimaryPid) {
            console.error('[Bridge] Tombstone detected during reconnect — entering slow-poll mode');
            logBridgeEvent({ kind: 'waiting_for_primary', port: primaryPort });
            setConnectionState({ kind: 'waiting_for_primary' });
            startWaitLoop();
            // Return true to stop reconnectWithBackoff -- state transition already done.
            // The outcome will be 'reconnected' but state is actually waiting_for_primary;
            // handleReconnectOutcome's 'reconnected' branch is a no-op (state already set).
            return true;
          }
        }

        logBridgeEvent({ kind: 'reconnect_attempt', attempt: attempt + 1, maxAttempts: config.reconnectMaxAttempts });
        console.error(`[Bridge] Reconnect attempt ${attempt + 1}/${config.reconnectMaxAttempts}`);
        const detected = await detectHealthyPrimary(primaryPort, { retries: 1, fetch: deps.fetch });
        if (detected == null) return false;
        // buildConnectedTransport sets connectionState to 'connected' atomically
        // on success. Discard the return value — the side effect is what matters.
        const transport = await buildConnectedTransport();
        return transport != null;
      },
    })
      .then((outcome) => {
        // Snapshot again at outcome time — state may have changed (e.g. shutdown or tombstone).
        const stateAtOutcome = connectionState;
        if (stateAtOutcome.kind !== 'reconnecting') return; // race: already handled
        return handleReconnectOutcome(outcome, stateAtOutcome, {
          setConnectionState,
          performShutdown,
          startReconnectLoop,
          startWaitLoop,
          triggerSpawn: async () => {
            // Coordinator lock: only one bridge spawns per death cycle.
            const lockResult = acquireSpawnLock(primaryPort, config.spawnLockStaleMs);
            if (lockResult.kind === 'skipped') {
              console.error(`[Bridge] Spawn skipped (coordinator lock): ${lockResult.reason}`);
              return;
            }
            try {
              await spawnPrimary(primaryPort, { spawn: spawnFn, fetch: deps.fetch });
            } finally {
              releaseSpawnLock(primaryPort);
            }
          },
          config,
        });
      })
      .catch((err) => {
        // An unexpected error in the reconnect loop or outcome handler — log it
        // so it is visible (Observability as a constraint) rather than silently
        // swallowed by the void discard. The loop is dead at this point; if the
        // primary is still alive the bridge will continue forwarding; if not, the
        // next t.onclose will start a fresh loop.
        const errObj = err instanceof Error ? err : new Error(String(err));
        logBridgeEvent({
          kind: 'reconnect_loop_error',
          message: errObj.message,
          stack: errObj.stack ?? null,
        });
        console.error('[Bridge] Unexpected error in reconnect loop:', err);
      });
  };

  // ---------------------------------------------------------------------------
  // Wait loop: slow-poll every waitForPrimaryPollMs until primary returns.
  //
  // This runs when the spawn budget is exhausted or the tombstone signals a
  // clean primary death. It keeps the bridge alive indefinitely so the IDE
  // session is never permanently severed by a primary crash.
  // ---------------------------------------------------------------------------

  const startWaitLoop = (): void => {
    // Idempotent guard: only one wait loop at a time.
    const stateAtStart = connectionState;
    if (stateAtStart.kind !== 'waiting_for_primary') return;

    void (async () => {
      logBridgeEvent({ kind: 'waiting_for_primary', port: primaryPort });
      while (!shutdownSignal.aborted) {
        await sleep(config.waitForPrimaryPollMs);
        if (shutdownSignal.aborted) return;

        const detected = await detectHealthyPrimary(primaryPort, { retries: 1, fetch: deps.fetch });
        if (detected != null) {
          console.error('[Bridge] Primary found after waiting — resuming normal operation');
          logBridgeEvent({ kind: 'primary_found_after_wait', port: primaryPort });
          // Re-enter reconnecting with a fresh budget so the new primary session
          // gets its full spawn budget, not a depleted one from before.
          setConnectionState({
            kind: 'reconnecting',
            attempt: 0,
            maxAttempts: config.reconnectMaxAttempts,
            respawnBudget: config.maxRespawnAttempts,
          });
          startReconnectLoop();
          return;
        }
      }
    })().catch((err) => {
      const errObj = err instanceof Error ? err : new Error(String(err));
      logBridgeEvent({
        kind: 'reconnect_loop_error',
        message: `wait loop error: ${errObj.message}`,
        stack: errObj.stack ?? null,
      });
      console.error('[Bridge] Unexpected error in wait loop:', err);
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
      case 'reconnecting':
      case 'waiting_for_primary':
        // All three states mean "no primary available right now."
        // 'connecting' = initial handshake in progress.
        // 'reconnecting' = prior connection lost, rapid retry loop running.
        // 'waiting_for_primary' = spawn budget spent, slow-polling.
        sendUnavailableError(msg, (m) => stdioTransport.send(m));
        return;

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
  logBridgeEvent({ kind: 'connected', primaryPort });
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

/**
 * Send a JSON-RPC error response to the IDE for requests that arrive while
 * no primary is available (connecting, reconnecting, or waiting_for_primary).
 *
 * Notifications have no id — they never get a response. Only requests do.
 */
function sendUnavailableError(
  msg: JSONRPCMessage,
  send: (m: JSONRPCMessage) => Promise<void>,
): void {
  if (!('id' in msg) || msg.id == null) return; // notifications need no response
  void send({
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
  } as JSONRPCMessage).catch(() => undefined);
}
