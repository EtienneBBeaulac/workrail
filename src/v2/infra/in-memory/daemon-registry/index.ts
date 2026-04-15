/**
 * DaemonRegistry -- ephemeral in-process liveness tracking for autonomous sessions.
 *
 * Stores the set of sessions currently being driven by the WorkRail daemon.
 * Cleared on process restart -- this is intentional. The durable record of
 * whether a session was autonomous lives in the event log (context_set with
 * is_autonomous: 'true'). This registry is only for the transient liveness signal
 * (i.e. the daemon is actively running and heartbeating).
 *
 * Invariants:
 * - DaemonEntry is fully readonly -- updates create new entries (object spread)
 * - snapshot() returns ReadonlyMap -- callers cannot modify registry state
 * - heartbeat() on an unknown sessionId is a no-op (safe for race conditions during shutdown)
 * - unregister() removes the entry entirely (registry tracks only active sessions in MVP)
 *
 * Liveness interpretation:
 * - A session is "live" when it appears in snapshot() AND its lastHeartbeatMs is within
 *   AUTONOMOUS_HEARTBEAT_THRESHOLD_MS of the caller's nowMs.
 * - The threshold check is the caller's responsibility (ConsoleService), not this class.
 *   This keeps the registry a pure state store with no time dependency.
 */

export interface DaemonEntry {
  /** Session ID this entry tracks. */
  readonly sessionId: string;
  /** Workflow ID that was started for this session. */
  readonly workflowId: string;
  /** Unix epoch ms when the daemon registered this session. */
  readonly startedAtMs: number;
  /** Unix epoch ms of the most recent heartbeat (updated on each context_set event). */
  readonly lastHeartbeatMs: number;
  /** Execution status of the daemon session. */
  readonly status: 'running' | 'completed' | 'failed';
}

export class DaemonRegistry {
  private readonly entries = new Map<string, DaemonEntry>();

  /**
   * Register a new autonomous session. Called by the daemon when a session starts.
   * If the session is already registered (e.g. after a crash recovery), the entry is replaced.
   */
  register(sessionId: string, workflowId: string): void {
    const nowMs = Date.now();
    const entry: DaemonEntry = {
      sessionId,
      workflowId,
      startedAtMs: nowMs,
      lastHeartbeatMs: nowMs,
      status: 'running',
    };
    this.entries.set(sessionId, entry);
  }

  /**
   * Update the lastHeartbeatMs for a session. Called on each context_set event
   * (i.e. each continue_workflow advance). No-op if the session is not registered.
   */
  heartbeat(sessionId: string): void {
    const existing = this.entries.get(sessionId);
    if (!existing) return;
    // Create a new entry -- never mutate in place.
    this.entries.set(sessionId, { ...existing, lastHeartbeatMs: Date.now() });
  }

  /**
   * Remove a session from the registry. Called when the daemon session completes or fails.
   * The `status` parameter is recorded but the entry is removed -- registry tracks only
   * sessions that are still running (MVP model).
   *
   * @param _status - Ignored in MVP (entry is removed regardless). Reserved for future
   *                  "recently completed" display in the console.
   */
  unregister(sessionId: string, _status: 'completed' | 'failed' = 'completed'): void {
    this.entries.delete(sessionId);
  }

  /**
   * Returns a snapshot of all currently registered sessions.
   * The returned map is a new ReadonlyMap -- mutations to the registry after this call
   * do not affect the returned value.
   *
   * Callers are responsible for checking entry.lastHeartbeatMs against their own nowMs
   * to determine liveness (see AUTONOMOUS_HEARTBEAT_THRESHOLD_MS in console-service.ts).
   */
  snapshot(): ReadonlyMap<string, DaemonEntry> {
    return new Map(this.entries);
  }
}
