/**
 * Per-session tool dependency injection types for the WorkTrain daemon.
 *
 * WHY this module exists: `constructTools()` in workflow-runner.ts previously
 * took a raw `Map<string, ReadFileState>` (plus several individual callback params)
 * as positional arguments. This module introduces:
 *
 *   1. `FileStateTracker` -- a named interface that encapsulates the Map, making
 *      read-before-write state access explicit and documentable.
 *
 *   2. `DefaultFileStateTracker` -- the standard implementation backed by a plain Map.
 *
 *   3. `SessionScope` -- a typed bundle of all per-session dependencies that
 *      `constructTools()` needs. Follows the same pattern as `TurnEndSubscriberContext`
 *      and `FinalizationContext` elsewhere in this file.
 *
 * CIRCULAR IMPORT NOTE: This module uses `import type` from workflow-runner.ts
 * to avoid runtime circular dependencies. Type-only imports are erased at compile
 * time and do not create module-level cycles.
 */

import type { ReadFileState } from './workflow-runner.js';
import type { ActiveSessionSet } from './active-sessions.js';
import type { DaemonEventEmitter } from './daemon-events.js';

// ---------------------------------------------------------------------------
// FileStateTracker
// ---------------------------------------------------------------------------

/**
 * Tracks per-session file read state to enforce read-before-write invariants.
 *
 * WHY an interface (not a raw Map): makes the dependency on file-state explicit,
 * gives each operation a name that documents its intent, and allows future
 * implementations (e.g. a test double or a tracker that also emits telemetry)
 * without changing tool factory signatures.
 */
export interface FileStateTracker {
  /**
   * Record that a file was read in this session.
   * Must be called by the Read tool after every successful file read.
   */
  recordRead(filePath: string, content: string, timestamp: number, isPartialView: boolean): void;

  /**
   * Retrieve the last-recorded read state for a file, or undefined if the file
   * has not been read in this session.
   */
  getReadState(filePath: string): ReadFileState | undefined;

  /**
   * Returns true if the file has been read at least once in this session.
   */
  hasBeenRead(filePath: string): boolean;

  /**
   * Returns the underlying Map for backward compatibility with tool factories
   * that accept `Map<string, ReadFileState>` directly.
   *
   * WHY on the interface: `constructTools()` calls this to pass the Map to
   * tool factories whose signatures cannot change (tests call them directly
   * with Maps). Having it on the interface avoids an `instanceof` check
   * and allows test doubles to implement it cleanly.
   *
   * Contract: the returned Map must be the same instance used internally by
   * the tracker. Reads and writes by tool factories must be visible through
   * the tracker's other methods (recordRead, getReadState, hasBeenRead).
   */
  toMap(): Map<string, ReadFileState>;
}

// ---------------------------------------------------------------------------
// DefaultFileStateTracker
// ---------------------------------------------------------------------------

/**
 * Standard `FileStateTracker` implementation backed by a plain Map.
 *
 * Constructed once per `runWorkflow()` call (one per session).
 */
export class DefaultFileStateTracker implements FileStateTracker {
  // WHY readonly: the Map reference is fixed; only its contents change.
  private readonly _map: Map<string, ReadFileState>;

  /**
   * Create a new tracker.
   *
   * @param existingMap Optional existing Map to wrap. When provided, the tracker
   *   shares the same Map instance rather than creating a new one. This allows
   *   `constructTools()` to wrap `session.readFileState` (which was initialized
   *   in `buildPreAgentSession()`) without copying it, preserving the exact same
   *   Map instance that tool factories mutate via `.get()` and `.set()`.
   */
  constructor(existingMap?: Map<string, ReadFileState>) {
    this._map = existingMap ?? new Map<string, ReadFileState>();
  }

  recordRead(filePath: string, content: string, timestamp: number, isPartialView: boolean): void {
    this._map.set(filePath, { content, timestamp, isPartialView });
  }

  getReadState(filePath: string): ReadFileState | undefined {
    return this._map.get(filePath);
  }

  hasBeenRead(filePath: string): boolean {
    return this._map.has(filePath);
  }

  /**
   * Returns the underlying Map for backward compatibility with tool factories
   * that accept `Map<string, ReadFileState>` directly.
   *
   * WHY this method exists: `makeReadTool`, `makeWriteTool`, and `makeEditTool`
   * are exported and tested directly with raw Maps. Changing their signatures
   * would break tests. `constructTools()` calls this method to obtain the Map
   * and passes it to those factories. Do not use this method in new code --
   * prefer the tracker interface methods instead.
   *
   * WHY the same Map instance is returned: the tool factories call `.get()` and
   * `.set()` on this Map to enforce read-before-write invariants. If a copy were
   * returned, those mutations would not be visible to the tracker, breaking staleness
   * detection.
   */
  toMap(): Map<string, ReadFileState> {
    return this._map;
  }
}

// ---------------------------------------------------------------------------
// SessionScope
// ---------------------------------------------------------------------------

/**
 * Per-session typed contract for what the tool construction layer is allowed to touch.
 *
 * Constructed once per `runWorkflow()` call and passed to `constructTools()`.
 * All fields are readonly -- `constructTools()` reads but does not replace them.
 *
 * WHY a named interface (not positional params): matches the pattern of
 * `TurnEndSubscriberContext` and `FinalizationContext` in workflow-runner.ts.
 * Named fields document intent and prevent accidental param ordering errors.
 */
export interface SessionScope {
  /** Tracks which files have been read in this session (read-before-write enforcement). */
  readonly fileTracker: FileStateTracker;

  /**
   * Called by `complete_step` / `continue_workflow` tools when the agent advances
   * to the next step. Updates mutable session state in runWorkflow().
   */
  readonly onAdvance: (stepText: string, continueToken: string) => void;

  /**
   * Called by `complete_step` tool when the workflow completes.
   * Updates mutable session state in runWorkflow().
   */
  readonly onComplete: (notes: string | undefined, artifacts?: readonly unknown[]) => void;

  /**
   * Called by `complete_step` / `continue_workflow` when the engine returns a
   * retryContinueToken on a blocked node response. Updates the current token so
   * the next tool call injects the correct retry token.
   *
   * WHY in scope (not inline lambda in constructTools): moves the direct
   * `state.currentContinueToken = t` write out of an anonymous inline closure
   * and into the typed SessionScope boundary. The write surface is now explicit
   * and named rather than hidden inside constructTools.
   */
  readonly onTokenUpdate: (continueToken: string) => void;

  /**
   * Called by `report_issue` tool to record a structured issue summary in the
   * session's ring buffer. Capped at maxIssueSummaries entries.
   *
   * WHY in scope (not inline lambda in constructTools): same rationale as
   * onTokenUpdate -- moves a direct `state.issueSummaries.push()` write out of
   * an anonymous inline closure and into the typed SessionScope boundary.
   */
  readonly onIssueReported: (summary: string) => void;

  /**
   * Called by the steer endpoint (ActiveSessionSet) when the coordinator injects
   * text into the running session. Appends to the pending steer parts queue.
   *
   * WHY in scope (not inline lambda in buildPreAgentSession): moves the direct
   * `state.pendingSteerParts.push()` write from an anonymous closure registered
   * with ActiveSessionSet into the typed SessionScope boundary. The steer
   * registration in buildPreAgentSession calls scope.onSteer(text).
   */
  readonly onSteer: (text: string) => void;

  /**
   * Read the current session token. Called by `complete_step` at execute time
   * to inject the correct token without needing a direct reference to SessionState.
   *
   * WHY a getter function (not a plain string): the token is updated after each
   * step advance (onTokenUpdate) and blocked-node retry. A getter ensures the
   * tool always reads the latest value rather than a snapshot captured at
   * construction time.
   *
   * WHY in scope: eliminates the last direct reference to `session.state` inside
   * constructTools. With this field, constructTools only needs scope + ctx + apiKey
   * + schemas -- it no longer depends on PreAgentSession at all.
   */
  readonly getCurrentToken: () => string;

  /**
   * Absolute path to the workspace directory the agent must work in.
   * For worktree sessions this is the isolated worktree path; for non-worktree
   * sessions it equals trigger.workspacePath.
   */
  readonly sessionWorkspacePath: string;

  /**
   * Current spawn depth of this session in the spawn_agent tree.
   * Root sessions have depth 0. Each spawn_agent call increments by 1.
   */
  readonly spawnCurrentDepth: number;

  /**
   * Maximum allowed spawn depth. spawn_agent returns a typed error when
   * currentDepth >= maxDepth without spawning.
   */
  readonly spawnMaxDepth: number;

  /**
   * The WorkRail session ID (decoded from the continue token), or null if the
   * session has not yet been started.
   */
  readonly workrailSessionId: string | null;

  /**
   * Event emitter for daemon observability events. May be undefined in
   * test contexts or when the daemon is started without observability.
   */
  readonly emitter: DaemonEventEmitter | undefined;

  /** The daemon-local session identifier (a UUID). */
  readonly sessionId: string;

  /**
   * The workflow ID being executed (e.g. "wr.coding-task").
   * Not destructured inside constructTools() in this PR -- will be consumed by
   * individual tool factories in A4 when they move to their own files.
   */
  readonly workflowId: string;

  /**
   * Registry mapping workrailSessionId -> abort callback.
   * Used by `spawn_agent` to register/deregister child sessions.
   * May be undefined if graceful shutdown is not enabled.
   */
  readonly activeSessionSet: ActiveSessionSet | undefined;

}
