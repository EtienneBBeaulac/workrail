/**
 * WorkRail Daemon: Structured Event Stream
 *
 * Appends structured JSON events to a daily JSONL file at
 * ~/.workrail/events/daemon/YYYY-MM-DD.jsonl.
 *
 * Design decisions:
 * - emit() is fire-and-forget (returns void synchronously). All async work runs
 *   in a detached Promise that swallows errors unconditionally. Observability
 *   must never affect correctness -- a failed append is always silent.
 * - File path is computed fresh from new Date() on each emit() call, so daily
 *   rotation happens automatically with zero state.
 * - Directory is created lazily on the first write (recursive mkdir is idempotent).
 * - DaemonEventEmitter is injected as an optional parameter wherever events are
 *   emitted (pattern mirrors DaemonRegistry in workflow-runner.ts). Callers that
 *   do not inject an emitter pay zero overhead.
 * - DaemonEvent is a discriminated union so invalid event shapes are impossible
 *   to construct at compile time.
 * - dirOverride is provided for testing: pass a temp directory to capture events
 *   without touching ~/.workrail.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// DaemonEvent: discriminated union of all event kinds
// ---------------------------------------------------------------------------

/** Daemon process started and webhook server is listening. */
export interface DaemonStartedEvent {
  readonly kind: 'daemon_started';
  readonly port: number;
  readonly workspacePath: string;
}

/** Incoming webhook accepted and validated. */
export interface TriggerFiredEvent {
  readonly kind: 'trigger_fired';
  readonly triggerId: string;
  readonly workflowId: string;
}

/** Workflow run entered the KeyedAsyncQueue (may wait for a slot). */
export interface SessionQueuedEvent {
  readonly kind: 'session_queued';
  readonly triggerId: string;
  readonly workflowId: string;
}

/** Workflow run started (session ID assigned, agent loop about to start). */
export interface SessionStartedEvent {
  readonly kind: 'session_started';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly workspacePath: string;
}

/** An agent tool was called. */
export interface ToolCalledEvent {
  readonly kind: 'tool_called';
  readonly sessionId: string;
  readonly toolName: string;
  /** First 80 chars of the primary tool parameter (e.g. bash command, file path). */
  readonly summary?: string;
}

/** A tool returned an error result (isError=true). */
export interface ToolErrorEvent {
  readonly kind: 'tool_error';
  readonly sessionId: string;
  readonly toolName: string;
  /** First 200 chars of the error message. */
  readonly error: string;
}

/** Workflow advanced to the next step. */
export interface StepAdvancedEvent {
  readonly kind: 'step_advanced';
  readonly sessionId: string;
}

/** Workflow run ended (success, error, or timeout). */
export interface SessionCompletedEvent {
  readonly kind: 'session_completed';
  readonly sessionId: string;
  readonly workflowId: string;
  readonly outcome: 'success' | 'error' | 'timeout';
  /** Human-readable reason (stopReason, error message, or timeout type). */
  readonly detail?: string;
}

/** HTTP POST to callbackUrl was attempted. */
export interface DeliveryAttemptedEvent {
  readonly kind: 'delivery_attempted';
  readonly callbackUrl: string;
  readonly outcome: 'success' | 'http_error' | 'network_error';
  readonly statusCode?: number;
}

/**
 * Union of all daemon lifecycle events.
 *
 * Each member has a `kind` discriminant so switch exhaustiveness is enforced
 * by the TypeScript compiler.
 */
export type DaemonEvent =
  | DaemonStartedEvent
  | TriggerFiredEvent
  | SessionQueuedEvent
  | SessionStartedEvent
  | ToolCalledEvent
  | ToolErrorEvent
  | StepAdvancedEvent
  | SessionCompletedEvent
  | DeliveryAttemptedEvent;

// ---------------------------------------------------------------------------
// DaemonEventEmitter
// ---------------------------------------------------------------------------

/**
 * Append-only event emitter for the WorkRail daemon.
 *
 * Each call to emit() writes one JSON line to the daily file:
 *   ~/.workrail/events/daemon/YYYY-MM-DD.jsonl
 * (or dirOverride/YYYY-MM-DD.jsonl in tests).
 *
 * The emitter is injected as an optional parameter wherever events are emitted.
 * Callers that do not inject an instance pay zero cost.
 */
export class DaemonEventEmitter {
  private readonly _dir: string;

  /**
   * @param dirOverride - Override the output directory. Used in tests to
   *   capture events in a temp directory without touching ~/.workrail.
   *   Production code omits this parameter.
   */
  constructor(dirOverride?: string) {
    this._dir = dirOverride ?? path.join(os.homedir(), '.workrail', 'events', 'daemon');
  }

  /**
   * Append a structured event to the daily JSONL file.
   *
   * Fire-and-forget: returns void synchronously. The underlying append runs
   * in a detached Promise. All errors are swallowed -- observability must
   * never affect correctness.
   *
   * WHY void + catch: the event append is diagnostic only. A failed write
   * (disk full, permission denied) must not propagate to the caller or
   * interrupt the workflow session.
   */
  emit(event: DaemonEvent): void {
    void this._append(event).catch(() => {
      // Intentionally empty: errors are silently swallowed.
    });
  }

  /**
   * Internal async append implementation.
   *
   * WHY separated from emit(): keeps emit() synchronous and the async I/O
   * path unit-testable in isolation.
   */
  private async _append(event: DaemonEvent): Promise<void> {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(this._dir, `${date}.jsonl`);

    await fs.mkdir(this._dir, { recursive: true });

    const line = JSON.stringify({ ...event, ts: Date.now() }) + '\n';
    await fs.appendFile(filePath, line, 'utf8');
  }
}
