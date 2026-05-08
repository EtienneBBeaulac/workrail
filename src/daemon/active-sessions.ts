/**
 * WorkTrain Daemon: ActiveSessionSet and SessionHandle
 *
 * Unified registry for daemon session lifecycle operations.
 * Replaces SteerRegistry + AbortRegistry (both were Map<string, fn> passed
 * through 4 layers of calls, mutated from 3+ sites).
 *
 * TDZ fix: register() is called BEFORE AgentLoop exists; setAgent() is called
 * after `const agent = new AgentLoop(...)` to wire in abort capability.
 * abort() before setAgent() is a safe no-op.
 */

import type { AgentLoop } from './agent-loop.js';
import type { RunId } from './daemon-events.js';

// ---------------------------------------------------------------------------
// SessionHandle interface
// ---------------------------------------------------------------------------

export interface SessionHandle {
  readonly sessionId: RunId;
  /**
   * The WorkRail session ID (sess_* ID) for this session.
   * Set via setWorkrailSessionId() after the continueToken is decoded.
   * Null until decoding completes (~50ms after session start).
   */
  readonly workrailSessionId: string | null;
  /** Inject text into the session's next agent turn. */
  steer(text: string): void;
  /**
   * Wire in the WorkRail session ID once the continueToken is decoded.
   * Called from buildPreAgentSession() after parseContinueTokenOrFail() succeeds.
   * Idempotent: second call is a no-op (first writer wins).
   */
  setWorkrailSessionId(workrailSessionId: string): void;
  /**
   * Wire in the AgentLoop reference for abort capability.
   * Must be called after `const agent = new AgentLoop(...)`.
   * Idempotent: second call is a no-op (first writer wins).
   */
  setAgent(agent: AgentLoop): void;
  /**
   * Abort the session's AgentLoop.
   * Safe no-op if setAgent() has not yet been called (closes TDZ hazard).
   */
  abort(): void;
  /**
   * Deregister this handle from its parent ActiveSessionSet.
   * Must be called in the session's finally block so size decrements correctly.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// SessionHandleImpl (private)
// ---------------------------------------------------------------------------

class SessionHandleImpl implements SessionHandle {
  readonly sessionId: RunId;
  private _workrailSessionId: string | null = null;
  private readonly _onSteer: (text: string) => void;
  private _agent: AgentLoop | null = null;
  private readonly _set: ActiveSessionSet;

  constructor(sessionId: RunId, onSteer: (text: string) => void, set: ActiveSessionSet) {
    this.sessionId = sessionId;
    this._onSteer = onSteer;
    this._set = set;
  }

  get workrailSessionId(): string | null {
    return this._workrailSessionId;
  }

  steer(text: string): void {
    this._onSteer(text);
  }

  setWorkrailSessionId(workrailSessionId: string): void {
    if (this._workrailSessionId === null) {
      this._workrailSessionId = workrailSessionId;
    }
  }

  setAgent(agent: AgentLoop): void {
    // First writer wins -- idempotent, no race (AgentLoop construction is synchronous).
    if (this._agent === null) {
      this._agent = agent;
    }
  }

  abort(): void {
    // WHY null check: if SIGTERM fires in the 200-500ms window between register()
    // and setAgent(), _agent is null. The check makes abort() a safe no-op.
    if (this._agent !== null) {
      this._agent.abort();
    }
  }

  dispose(): void {
    this._set._remove(this.sessionId);
  }
}

// ---------------------------------------------------------------------------
// ActiveSessionSet
// ---------------------------------------------------------------------------

/**
 * Registry of all active daemon sessions.
 * Created once at the composition root (trigger-listener.ts).
 */
export class ActiveSessionSet {
  private readonly _handles = new Map<RunId, SessionHandleImpl>();

  /**
   * Register a new session handle before AgentLoop construction.
   * Keyed by the daemon-local RunId (always available immediately).
   * The WorkRail session ID (sess_*) is set later via handle.setWorkrailSessionId()
   * once the continueToken is decoded.
   * @param onSteer - Callback that closes over state.pendingSteerParts in runWorkflow().
   */
  register(sessionId: RunId, onSteer: (text: string) => void): SessionHandle {
    const handle = new SessionHandleImpl(sessionId, onSteer, this);
    this._handles.set(sessionId, handle);
    return handle;
  }

  get(sessionId: RunId): SessionHandle | undefined {
    return this._handles.get(sessionId);
  }

  /**
   * Iterate all active session handles (for shutdown event emission and abort).
   * Each handle carries both sessionId (RunId) and workrailSessionId (string | null).
   */
  handles(): IterableIterator<SessionHandle> {
    return this._handles.values();
  }

  /** Abort all in-flight sessions simultaneously (SIGTERM/SIGINT handler). */
  abortAll(): void {
    for (const handle of this._handles.values()) {
      handle.abort();
    }
  }

  get size(): number {
    return this._handles.size;
  }

  /** Called by SessionHandleImpl.dispose() -- not for external callers. */
  _remove(sessionId: RunId): void {
    this._handles.delete(sessionId);
  }
}
