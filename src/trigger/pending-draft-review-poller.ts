/**
 * PendingDraftReviewPoller: platform-agnostic draft review submission detector.
 *
 * Polls on a fixed interval, delegating the "is it submitted?" check entirely
 * to the ReviewApprovalAdapter. GitHub checks GET /reviews/:id; GitLab (future)
 * will check its own signal -- the poller is unaware of either.
 *
 * Lifecycle:
 * 1. Caller writes pending-draft sidecar BEFORE calling start().
 * 2. start() begins polling; returns immediately (non-blocking).
 * 3. On submission detected: appends review_draft_submitted to session event log,
 *    deletes the sidecar, calls onSubmitted callback, stops itself.
 * 4. stop() cancels the interval regardless of state (safe to call before start).
 *
 * WHY follows PollingScheduler pattern (class with start/stop, mutable interval
 * handle): Node.js interval management requires mutable handles. The pattern is
 * established in the codebase and is the correct imperative shell for I/O polling.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ReviewApprovalAdapter, CheckSubmissionOpts } from './review-approval-adapter.js';
import type { SessionEventLogAppendStorePortV2, SessionEventLogReadonlyStorePortV2 } from '../v2/ports/session-event-log-store.port.js';
import type { ExecutionSessionGateV2 } from '../v2/usecases/execution-session-gate.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import { buildSessionIndex } from '../v2/durable-core/session-index.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { okAsync } from 'neverthrow';
import { EVENT_KIND } from '../v2/durable-core/constants.js';
import { DAEMON_SESSIONS_DIR } from '../daemon/tools/_shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingDraftReviewPollerOptions {
  readonly prNumber: number;
  readonly prRepo: string;
  readonly reviewId: number;
  readonly token: string;
  readonly login: string;
  /** WorkRail session ID (sess_...) for appending events to the session log. */
  readonly workrailSessionId: string;
  /** Daemon-local session UUID (keys the pending-draft sidecar file). */
  readonly daemonSessionId: string;
  /** How often to poll in milliseconds. Default: 45 000 (45s). */
  readonly pollIntervalMs?: number;
  /** Injectable session store for appending the review_draft_submitted event. */
  readonly sessionStore: SessionEventLogAppendStorePortV2 & SessionEventLogReadonlyStorePortV2;
  /** Gate for acquiring the session lock needed by sessionStore.append(). */
  readonly gate: ExecutionSessionGateV2;
  /** Injectable event ID factory. */
  readonly mintEventId: () => string;
  /** Injectable sessions directory (for sidecar deletion). Default: DAEMON_SESSIONS_DIR. */
  readonly sessionsDir?: string;
  /**
   * Called when submission is detected, after the event is appended and the sidecar deleted.
   * Fire-and-forget from the caller's perspective -- errors are logged internally.
   */
  readonly onSubmitted?: (submittedAt: string) => void;
}

export interface PendingDraftSidecar {
  readonly reviewId: number;
  readonly prNumber: number;
  readonly prRepo: string;
  readonly daemonSessionId: string;
  readonly workrailSessionId: string;
  readonly token: string;
  readonly login: string;
  readonly createdAt: string;
  readonly triggerId: string;
}

const DEFAULT_POLL_INTERVAL_MS = 45_000;

// ---------------------------------------------------------------------------
// PendingDraftReviewPoller
// ---------------------------------------------------------------------------

export class PendingDraftReviewPoller {
  private _intervalHandle: ReturnType<typeof setInterval> | undefined = undefined;
  private _stopped = false;

  constructor(
    private readonly adapter: ReviewApprovalAdapter,
    private readonly opts: PendingDraftReviewPollerOptions,
  ) {}

  /**
   * Begin polling. Returns immediately -- polling runs in the background.
   * Safe to call only once; subsequent calls are no-ops.
   */
  start(): void {
    if (this._stopped || this._intervalHandle !== undefined) return;
    const intervalMs = this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this._intervalHandle = setInterval(() => {
      void this._tick().catch((e: unknown) => {
        console.warn(
          `[PendingDraftReviewPoller] Unexpected error in tick: ` +
          `daemonSessionId=${this.opts.daemonSessionId} ` +
          `${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }, intervalMs);
  }

  /**
   * Stop polling. Safe to call before start() or after already stopped.
   */
  stop(): void {
    this._stopped = true;
    if (this._intervalHandle !== undefined) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = undefined;
    }
  }

  private async _tick(): Promise<void> {
    if (this._stopped) return;

    const checkOpts: CheckSubmissionOpts = {
      prNumber: this.opts.prNumber,
      prRepo: this.opts.prRepo,
      token: this.opts.token,
      login: this.opts.login,
      reviewId: this.opts.reviewId,
    };

    const result = await this.adapter.checkSubmission(checkOpts);

    if (result.kind === 'err') {
      console.warn(
        `[PendingDraftReviewPoller] Submission check failed: ` +
        `daemonSessionId=${this.opts.daemonSessionId} ` +
        `prRepo=${this.opts.prRepo} prNumber=${this.opts.prNumber} ` +
        `error=${result.error.message}`,
      );
      return; // Retry on next tick.
    }

    if (result.kind === 'pending') {
      return; // Still waiting.
    }

    // Submitted. Stop polling before doing I/O to avoid double-fire.
    this.stop();

    const { submittedAt } = result;
    console.log(
      `[PendingDraftReviewPoller] Draft review submitted: ` +
      `daemonSessionId=${this.opts.daemonSessionId} ` +
      `prRepo=${this.opts.prRepo} prNumber=${this.opts.prNumber} ` +
      `reviewId=${this.opts.reviewId} submittedAt=${submittedAt}`,
    );

    // Append review_draft_submitted event to session log (same gate-lock pattern
    // as recordCommitShasStage in delivery-pipeline.ts).
    if (this.opts.workrailSessionId) {
      const sid = asSessionId(this.opts.workrailSessionId);
      await this.opts.gate.withHealthySessionLock(sid, (lock) =>
        this.opts.sessionStore.load(sid).andThen((truth) => {
          const sortedResult = asSortedEventLog(truth.events);
          if (sortedResult.isErr()) return okAsync(undefined as void);
          const index = buildSessionIndex(sortedResult.value);
          const runId = this.opts.daemonSessionId;
          const event = {
            v: 1 as const,
            eventId: this.opts.mintEventId(),
            eventIndex: index.nextEventIndex,
            sessionId: this.opts.workrailSessionId,
            kind: EVENT_KIND.REVIEW_DRAFT_SUBMITTED,
            dedupeKey: `review_draft_submitted:${this.opts.reviewId}`,
            scope: { runId },
            data: {
              reviewId: this.opts.reviewId,
              prUrl: `https://github.com/${this.opts.prRepo}/pull/${this.opts.prNumber}`,
              submittedAt,
            },
            timestampMs: Date.now(),
          };
          return this.opts.sessionStore.append(lock, { events: [event], snapshotPins: [] });
        })
      ).match(
        () => { /* success -- no-op */ },
        (err) => {
          console.warn(
            `[PendingDraftReviewPoller] Failed to append review_draft_submitted event: ` +
            `daemonSessionId=${this.opts.daemonSessionId} err=${JSON.stringify(err)}`,
          );
        },
      );
    }

    // Delete pending-draft sidecar.
    const sessionsDir = this.opts.sessionsDir ?? DAEMON_SESSIONS_DIR;
    const sidecarPath = path.join(sessionsDir, `pending-draft-${this.opts.daemonSessionId}.json`);
    await fs.unlink(sidecarPath).catch((e: unknown) => {
      console.warn(
        `[PendingDraftReviewPoller] Could not delete pending-draft sidecar: ` +
        `${sidecarPath} ${e instanceof Error ? e.message : String(e)}`,
      );
    });

    // Notify caller.
    try { this.opts.onSubmitted?.(submittedAt); } catch { /* fire-and-forget */ }
  }
}

// ---------------------------------------------------------------------------
// Sidecar helpers
// ---------------------------------------------------------------------------

/**
 * Write a pending-draft sidecar before starting the poller.
 * Must be called BEFORE PendingDraftReviewPoller.start() -- crash recovery
 * depends on the sidecar existing before the background task begins.
 */
export async function writePendingDraftSidecar(
  sidecar: PendingDraftSidecar,
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<void> {
  const sidecarPath = path.join(sessionsDir, `pending-draft-${sidecar.daemonSessionId}.json`);
  const tmpPath = `${sidecarPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(sidecar, null, 2), 'utf8');
  await fs.rename(tmpPath, sidecarPath);
}

/**
 * Read all pending-draft sidecars from the sessions directory.
 * Used by startup recovery to restart pollers after a daemon crash.
 */
export async function readAllPendingDraftSidecars(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<PendingDraftSidecar[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const sidecars: PendingDraftSidecar[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('pending-draft-') || !entry.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, entry);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PendingDraftSidecar>;
      if (
        typeof parsed.reviewId === 'number' &&
        typeof parsed.prNumber === 'number' &&
        typeof parsed.prRepo === 'string' &&
        typeof parsed.daemonSessionId === 'string' &&
        typeof parsed.workrailSessionId === 'string' &&
        typeof parsed.token === 'string' &&
        typeof parsed.login === 'string' &&
        typeof parsed.triggerId === 'string'
      ) {
        sidecars.push(parsed as PendingDraftSidecar);
      } else {
        console.warn(`[PendingDraftReviewPoller] Skipping malformed pending-draft sidecar: ${filePath}`);
      }
    } catch (e: unknown) {
      console.warn(
        `[PendingDraftReviewPoller] Could not read pending-draft sidecar ${filePath}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return sidecars;
}
