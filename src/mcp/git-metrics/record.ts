/**
 * Fire-and-forget git metrics recorders.
 *
 * These functions follow the same pattern as collectAndRecordUsage and
 * recordTokenCheckpoint in src/mcp/handlers/v2-execution/index.ts:
 * - Acquire a fresh session gate lock (never block on the main lock)
 * - Re-read session events to extract required context (repoRoot, startSha, runId)
 * - Append a new event fire-and-forget
 * - Never throw; all errors are caught and logged
 *
 * WHY standalone functions (not inside the lock chain): git I/O runs after the
 * session lock is released. Acquiring a fresh lock per function, sequentially,
 * prevents SESSION_LOCK_REENTRANT errors.
 */

import type { V2ToolContext } from '../types.js';
import type { SessionId } from '../../v2/durable-core/ids/index.js';
import { EVENT_KIND } from '../../v2/durable-core/constants.js';
import { buildSessionIndex } from '../../v2/durable-core/session-index.js';
import { asSortedEventLog } from '../../v2/durable-core/sorted-event-log.js';
import { okAsync } from 'neverthrow';
import {
  readWorkingTreeState,
  readCommittedDiff,
  readCommitShasAndPrRefs,
} from './reader.js';

// Timeouts per operation (ms)
const DIFF_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;

type SessionStore = V2ToolContext['v2']['sessionStore'];
type Gate = V2ToolContext['v2']['gate'];
type IdFactory = V2ToolContext['v2']['idFactory'];

// ---------------------------------------------------------------------------
// recordGitStart
// ---------------------------------------------------------------------------

/**
 * Capture baseline working-tree state at session start.
 *
 * Appends a `git_start_recorded` event. Fires after start_workflow returns,
 * before any agent interaction. Uses the repoRoot passed directly (available
 * at session start from input.workspacePath).
 *
 * Must never throw or reject.
 */
export async function recordGitStart(
  sessionId: SessionId,
  repoRoot: string | null | undefined,
  sessionStore: SessionStore,
  gate: Gate,
  idFactory: IdFactory,
): Promise<void> {
  if (!repoRoot) return;

  try {
    const workingTree = await readWorkingTreeState(repoRoot, STATUS_TIMEOUT_MS);
    if (workingTree === null) return; // not a git repo or git not installed

    await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.load(sessionId).andThen((truth) => {
        const sortedResult = asSortedEventLog(truth.events);
        if (sortedResult.isErr()) return okAsync(undefined as void);
        const index = buildSessionIndex(sortedResult.value);

        const event = {
          v: 1 as const,
          eventId: idFactory.mintEventId(),
          eventIndex: index.nextEventIndex,
          sessionId: String(sessionId),
          kind: EVENT_KIND.GIT_START_RECORDED,
          dedupeKey: `git-start-recorded:${String(sessionId)}`,
          scope: undefined,
          data: {
            repoRoot,
            stagedFiles: workingTree.stagedFiles,
            unstagedFiles: workingTree.unstagedFiles,
          },
          timestampMs: Date.now(),
        } as const;

        return sessionStore.append(lock, { events: [event], snapshotPins: [] }, truth);
      })
    ).match(
      () => { /* success */ },
      (err) => {
        console.warn(`[workrail:git] Could not write git_start_recorded for ${String(sessionId)}: ${JSON.stringify(err)}`);
      }
    );
  } catch (err: unknown) {
    console.warn(`[workrail:git] Unexpected error in recordGitStart for ${String(sessionId)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// recordGitMetrics
// ---------------------------------------------------------------------------

/**
 * Capture committed diff and final working-tree state at session completion.
 *
 * Re-reads the session store to extract repoRoot and startSha from session events
 * (same pattern as collectAndRecordUsage re-reading workspacePath). Appends a
 * `git_metrics_recorded` event.
 *
 * Must never throw or reject.
 */
export async function recordGitMetrics(
  sessionId: SessionId,
  sessionStore: SessionStore,
  gate: Gate,
  idFactory: IdFactory,
): Promise<void> {
  try {
    // Re-read session events to extract repoRoot, startSha, and runId.
    const loadResult = await sessionStore.load(sessionId);
    if (loadResult.isErr()) return;

    const events = loadResult.value.events;
    if (events.length === 0) return;

    let repoRoot: string | null = null;
    let startSha: string | null = null;
    let runId: string | null = null;

    for (const e of events) {
      if (e.kind === 'observation_recorded') {
        if (e.data.key === 'repo_root') repoRoot = e.data.value.value;
        if (e.data.key === 'git_head_sha') startSha = e.data.value.value;
      }
      if (e.kind === EVENT_KIND.RUN_COMPLETED) {
        runId = e.scope.runId;
      }
      if (repoRoot && startSha && runId) break;
    }

    if (!repoRoot || !runId) return;

    // Run all git operations in parallel (independent commands).
    const [committedDiff, commitResult, workingTree] = await Promise.all([
      readCommittedDiff(repoRoot, startSha, DIFF_TIMEOUT_MS),
      readCommitShasAndPrRefs(repoRoot, startSha, STATUS_TIMEOUT_MS),
      readWorkingTreeState(repoRoot, STATUS_TIMEOUT_MS),
    ]);

    const commitShas = commitResult?.shas ?? [];
    const prRefs = commitResult?.prRefs ?? [];

    // Compute endSha from commitShas: if there are commits, the last one in
    // chronological order is the new HEAD. We rely on git rev-parse HEAD
    // only when startSha is null (no commits made = endSha stays as startSha).
    // For simplicity, read endSha from the run_completed event's data.
    let endSha: string | null = null;
    for (const e of events) {
      if (e.kind === EVENT_KIND.RUN_COMPLETED) {
        endSha = e.data.endGitSha;
        break;
      }
    }

    // Compute captureConfidence.
    const captureConfidence = computeCaptureConfidence({
      startSha,
      endSha,
      commitShas,
      committedDiff,
    });

    await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.load(sessionId).andThen((truth) => {
        const sortedResult = asSortedEventLog(truth.events);
        if (sortedResult.isErr()) return okAsync(undefined as void);
        const index = buildSessionIndex(sortedResult.value);

        const event = {
          v: 1 as const,
          eventId: idFactory.mintEventId(),
          eventIndex: index.nextEventIndex,
          sessionId: String(sessionId),
          kind: EVENT_KIND.GIT_METRICS_RECORDED,
          dedupeKey: `git-metrics-recorded:${String(sessionId)}`,
          scope: { runId },
          data: {
            startSha,
            endSha,
            commitShas: Array.from(commitShas),
            prRefs: Array.from(prRefs),
            filesChanged: committedDiff?.filesChanged ?? null,
            linesAdded: committedDiff?.linesAdded ?? null,
            linesRemoved: committedDiff?.linesRemoved ?? null,
            truncated: committedDiff?.truncated ?? false,
            stagedFiles: workingTree?.stagedFiles ?? null,
            unstagedFiles: workingTree?.unstagedFiles ?? null,
            captureConfidence,
          },
          timestampMs: Date.now(),
        } as const;

        return sessionStore.append(lock, { events: [event], snapshotPins: [] }, truth);
      })
    ).match(
      () => { /* success */ },
      (err) => {
        console.warn(`[workrail:git] Could not write git_metrics_recorded for ${String(sessionId)}: ${JSON.stringify(err)}`);
      }
    );
  } catch (err: unknown) {
    console.warn(`[workrail:git] Unexpected error in recordGitMetrics for ${String(sessionId)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCaptureConfidence(args: {
  startSha: string | null;
  endSha: string | null;
  commitShas: readonly string[];
  committedDiff: import('../../v2/durable-core/schemas/session/git-evidence.js').GitCommittedDiff | null;
}): 'high' | 'partial' | 'none' {
  const { startSha, endSha, commitShas, committedDiff } = args;

  if (!startSha || !endSha) return 'none';

  if (commitShas.length > 0 && committedDiff !== null) {
    return 'high';
  }

  // endSha is available but either no commits were found or the diff failed.
  if (endSha !== startSha || commitShas.length > 0) {
    return 'partial';
  }

  // startSha === endSha and no commits -- no changes were made.
  // Report as partial rather than none: we have valid SHAs but no diff data.
  return 'partial';
}
