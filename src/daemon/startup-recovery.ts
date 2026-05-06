/**
 * Daemon startup crash recovery.
 *
 * WHY this module: these functions scan for orphaned session files from a
 * previous daemon crash and either resume them (if they have meaningful progress)
 * or discard them. They belong in their own module because crash recovery is a
 * distinct concern from the session execution path in runWorkflow().
 *
 * WHY this module may import node: modules: it IS I/O-heavy -- it reads session
 * files, decodes tokens, counts event log entries, and removes orphan worktrees.
 *
 * MAX_ORPHAN_AGE_MS and MAX_WORKTREE_ORPHAN_AGE_MS live here alongside the
 * functions that use them.
 */

import 'reflect-metadata';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { V2ToolContext } from '../mcp/types.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import { parseContinueTokenOrFail } from '../mcp/handlers/v2-token-ops.js';
import type { ContinueTokenResolved } from '../mcp/handlers/v2-token-ops.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import type { SessionEventLogReadonlyStorePortV2, LoadedValidatedPrefixV2, SessionEventLogStoreError } from '../v2/ports/session-event-log-store.port.js';
import type { ToolFailure } from '../mcp/handlers/v2-execution-helpers.js';
import type { ResultAsync } from 'neverthrow';
import { assertNever } from '../runtime/assert-never.js';
import { evaluateRecovery } from './session-recovery-policy.js';
import { DAEMON_SESSIONS_DIR } from './tools/_shared.js';
import type { OrphanedSession, SessionSource, AllocatedSession, WorkflowTrigger } from './types.js';
import { WORKTREES_DIR } from './runner/runner-types.js';
import { runWorkflow } from './workflow-runner.js';

const execFileAsync = promisify(execFile);

/**
 * Maximum age for an orphaned session file before it is treated as definitely stale.
 * Tokens from a 2h+ old crash are expired in all realistic configurations.
 */
const MAX_ORPHAN_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Maximum age for an orphaned worktree before it is removed during startup recovery.
 * WHY 24h: failed worktrees are more useful for debugging than session sidecars.
 */
const MAX_WORKTREE_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Read a previously persisted session state from ~/.workrail/daemon-sessions/<sessionId>.json.
 *
 * Returns null if the file does not exist (first run, or already cleaned up after success).
 * The continueToken can be used to resume the session with executeContinueWorkflow().
 *
 * @param sessionId - The process-local UUID that was used when the session was started.
 */
export async function readDaemonSessionState(
  sessionId: string,
): Promise<{ continueToken: string; checkpointToken: string | null } | null> {
  const sessionPath = path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`);
  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw) as { continueToken: string; checkpointToken: string | null };
    return { continueToken: parsed.continueToken, checkpointToken: parsed.checkpointToken };
  } catch {
    // ENOENT or parse error -- treat as no persisted state
    return null;
  }
}

/**
 * Read all orphaned session files from ~/.workrail/daemon-sessions/.
 *
 * Returns an array of valid, parseable session entries. Corrupt files (JSON parse
 * errors, missing required fields) are skipped with a warning log and left on disk --
 * runStartupRecovery() only deletes files returned by this function. This is an
 * accepted limitation: cleaning up corrupt files would require a second readdir pass,
 * which is not implemented at MVP.
 *
 * Returns an empty array if the directory does not exist (ENOENT on first run) or
 * if no valid session files are found. Never throws.
 *
 * WHY exported: called by runStartupRecovery() and testable in isolation without
 * starting the full daemon listener.
 *
 * @param sessionsDir - Optional override for the sessions directory. Defaults to
 *   DAEMON_SESSIONS_DIR. Pass a temp dir in tests to avoid touching real state.
 */
export async function readAllDaemonSessions(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
): Promise<OrphanedSession[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch (err: unknown) {
    const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isEnoent) {
      console.warn(
        `[WorkflowRunner] Could not read sessions directory ${sessionsDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return [];
  }

  const sessions: OrphanedSession[] = [];

  for (const entry of entries) {
    // Only consider complete session files. Temp files are named <sessionId>.json.tmp
    // (i.e. they end with .tmp, not .json) -- the endsWith('.json') check already
    // excludes them. The belt-and-suspenders check keeps this robust to naming changes.
    // queue-issue-*.json sidecars live in the same directory; skip them here.
    if (!entry.endsWith('.json') || entry.startsWith('queue-issue-')) continue;

    const sessionId = entry.slice(0, -5); // strip .json
    const filePath = path.join(sessionsDir, entry);

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        continueToken?: unknown;
        checkpointToken?: unknown;
        ts?: unknown;
        worktreePath?: unknown;
        workflowId?: unknown;
        goal?: unknown;
        workspacePath?: unknown;
      };

      if (typeof parsed.continueToken !== 'string' || typeof parsed.ts !== 'number') {
        console.warn(`[WorkflowRunner] Skipping malformed session file: ${filePath}`);
        continue;
      }

      sessions.push({
        sessionId,
        continueToken: parsed.continueToken,
        checkpointToken: typeof parsed.checkpointToken === 'string' ? parsed.checkpointToken : null,
        ts: parsed.ts,
        // worktreePath is optional -- absent in sessions created before Issue #627.
        // Use undefined (not null) to match the OrphanedSession.worktreePath? type.
        ...(typeof parsed.worktreePath === 'string' ? { worktreePath: parsed.worktreePath } : {}),
        // Recovery context fields (workflowId, goal, workspacePath) -- written by persistTokens()
        // on the first call in runWorkflow(). Absent in old-format sidecars (backward compat).
        // Sessions lacking workflowId or workspacePath will fall through to discard in
        // runStartupRecovery() rather than being resumed.
        ...(typeof parsed.workflowId === 'string' ? { workflowId: parsed.workflowId } : {}),
        ...(typeof parsed.goal === 'string' ? { goal: parsed.goal } : {}),
        ...(typeof parsed.workspacePath === 'string' ? { workspacePath: parsed.workspacePath } : {}),
      });
    } catch (err: unknown) {
      console.warn(
        `[WorkflowRunner] Skipping unreadable session file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return sessions;
}

/**
 * Scan DAEMON_SESSIONS_DIR for orphaned session files and handle them.
 *
 * Called once during daemon startup, before the HTTP server begins accepting
 * webhook requests. Two recovery behaviors fire unconditionally:
 *
 * Phase A: Delete all queue-issue-*.json sidecars so blocked GitHub issues
 *   become eligible for re-dispatch within one poll cycle (~5 min).
 *
 * Phase B (requires ctx): For each orphaned session, decode the continueToken,
 *   count advance_recorded events in the WorkRail session event log, and apply
 *   the binary evaluateRecovery() policy:
 *   - stepAdvances >= 1 -> attempt resume: rehydrate via executeContinueWorkflow, reconstruct
 *     WorkflowTrigger with a pre_allocated SessionSource, call runWorkflow fire-and-forget.
 *     Falls through to discard if sidecar lacks recovery context fields (backward compat),
 *     if the worktree directory is gone, if rehydrate fails, or if the session is complete.
 *   - stepAdvances === 0 -> discard (sidecar deleted; issue re-dispatched)
 *   When ctx is absent, all sessions fall to discard (backward-compatible behavior).
 *
 * Non-fatal: any error during recovery is caught and logged. The daemon starts
 * regardless of whether recovery succeeds.
 *
 * @param sessionsDir - Optional override for the sessions directory. Defaults to
 *   DAEMON_SESSIONS_DIR. Pass a temp dir in tests to avoid touching real state.
 * @param execFn - Injectable exec function for git worktree removal.
 *   Defaults to execFileAsync. Override in tests to avoid real git calls.
 * @param ctx - Optional V2ToolContext for phase B logic. When provided,
 *   sessions with step advances are resumed rather than discarded.
 * @param _countStepAdvancesFn - Injectable step-count implementation for testing.
 *   Defaults to the real countOrphanStepAdvances() implementation.
 * @param _executeContinueWorkflowFn - Injectable continue-workflow implementation for testing.
 *   Used in the resume path to call intent: 'rehydrate' and get the current step prompt.
 *   Defaults to the real executeContinueWorkflow().
 * @param _runWorkflowFn - Injectable runWorkflow implementation for testing.
 *   Used in the resume path to start a new agent loop from the current step.
 *   Defaults to the real runWorkflow(). Passed as fire-and-forget in production.
 * @param apiKey - Anthropic API key forwarded to runWorkflow() on the resume path.
 *   Injected by the caller (startTriggerListener) rather than read from process.env
 *   so this function stays boundary-clean. Defaults to '' for tests that do not
 *   exercise the resume path.
 */
export async function runStartupRecovery(
  sessionsDir: string = DAEMON_SESSIONS_DIR,
  execFn: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> = execFileAsync,
  ctx?: V2ToolContext,
  _countStepAdvancesFn: typeof countOrphanStepAdvances = countOrphanStepAdvances,
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
  _runWorkflowFn: typeof runWorkflow = runWorkflow,
  // WHY last / default '': adding after all injectable params keeps every existing call
  // site valid without positional changes. Production passes the key from startTriggerListener;
  // tests that don't exercise the resume path can omit it.
  apiKey: string = '',
): Promise<void> {
  // Phase A: Delete all queue-issue-*.json sidecars unconditionally.
  // WHY first: queue-issue cleanup is independent of session state and must
  // always run, even if session recovery fails or ctx is absent.
  await clearQueueIssueSidecars(sessionsDir);

  // Read all parseable session files.
  const sessions = await readAllDaemonSessions(sessionsDir);

  if (sessions.length === 0) {
    // Also attempt to clear any stray .tmp files left from a crash mid-write.
    await clearStrayTmpFiles(sessionsDir);
    return;
  }

  console.log(`[WorkflowRunner] Startup recovery: found ${sessions.length} orphaned session(s).`);

  const now = Date.now();
  let cleared = 0;
  let preserved = 0;

  for (const session of sessions) {
    const ageMs = now - session.ts;
    const isStale = ageMs > MAX_ORPHAN_AGE_MS;
    const ageSec = Math.round(ageMs / 1000);

    // Orphan worktree cleanup: if this session created a worktree and the worktree
    // has been orphaned long enough (24h), remove it.
    //
    // WHY different age threshold (MAX_WORKTREE_ORPHAN_AGE_MS = 24h) from session sidecar
    // threshold (MAX_ORPHAN_AGE_MS = 2h): failed worktrees are useful for debugging.
    // A developer investigating a failed session wants the worktree intact for a reasonable
    // inspection window. Session sidecars hold expired tokens; worktrees hold file state.
    //
    // WHY best-effort (try/catch, log + continue): worktree removal must never block
    // daemon startup. A non-removable worktree (e.g. disk full, path deleted by user)
    // is logged and skipped; the session sidecar is still deleted so the next startup
    // does not attempt the removal again.
    if (session.worktreePath && ageMs > MAX_WORKTREE_ORPHAN_AGE_MS) {
      console.log(
        `[WorkflowRunner] Removing orphan worktree: sessionId=${session.sessionId} worktreePath=${session.worktreePath}`,
      );
      try {
        await execFn('git', ['worktree', 'remove', '--force', session.worktreePath]);
        console.log(`[WorkflowRunner] Removed orphan worktree: ${session.worktreePath}`);
      } catch (err: unknown) {
        // Best-effort: log and continue. The sidecar will still be deleted below so
        // the next startup does not attempt this removal again.
        console.warn(
          `[WorkflowRunner] Could not remove orphan worktree ${session.worktreePath}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (session.worktreePath && ageMs <= MAX_WORKTREE_ORPHAN_AGE_MS) {
      // Worktree exists but is not yet old enough to reap. Keep it for debugging.
      const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
      console.log(
        `[WorkflowRunner] Keeping recent orphan worktree: sessionId=${session.sessionId} ` +
        `age=${ageHours}h (threshold=24h) worktreePath=${session.worktreePath}`,
      );
    }

    // Phase B: Resume-or-discard decision when ctx is available.
    // When ctx is absent, fall through to discard (same as previous behavior).
    if (ctx !== undefined) {
      let stepAdvances = 0;
      try {
        stepAdvances = await _countStepAdvancesFn(session.continueToken, ctx);
      } catch (err: unknown) {
        // Non-fatal: if step count fails, fall through to discard.
        console.warn(
          `[WorkflowRunner] Could not count step advances for orphaned session ${session.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)} -- falling back to discard`,
        );
      }

      const action = evaluateRecovery({ stepAdvances, ageMs });

      // Exhaustive switch: assertNever prevents silent fall-through if
      // RecoveryAction gains new variants in the future.
      switch (action) {
        case 'resume': {
          // Phase B: attempt to resume an orphaned session that had meaningful progress.
          //
          // Required conditions (all must pass; any failure falls through to discard):
          //   1. Sidecar has workflowId + workspacePath (written by persistTokens since Phase B).
          //      Old-format sidecars (missing fields) are discarded for backward compatibility.
          //   2. Session is not stale (age <= MAX_ORPHAN_AGE_MS = 2h).
          //   3. If a worktree was used: the worktree directory still exists on disk.
          //      (No worktree re-creation -- pitch no-go #7.)
          //   4. Rehydrate call succeeds (executeContinueWorkflow returns ok).
          //   5. Session is not already complete and has a pending step.

          const hasContext = typeof session.workflowId === 'string' &&
            typeof session.workspacePath === 'string';

          if (!hasContext) {
            console.log(
              `[WorkflowRunner] Startup recovery: cannot resume session ${session.sessionId} -- ` +
              `missing workflowId/workspacePath in sidecar (old format). Discarding.`,
            );
            break; // fall through to sidecar deletion
          }

          if (isStale) {
            console.log(
              `[WorkflowRunner] Startup recovery: discarding stale resumable session ${session.sessionId} ` +
              `(age=${ageSec}s > ${MAX_ORPHAN_AGE_MS / 1000}s threshold).`,
            );
            break;
          }

          // Worktree existence check: if the session used a worktree, verify it is still on disk.
          // WHY: runWorkflow with branchStrategy: 'none' uses worktreePath as workspacePath.
          // A missing worktree means the agent would fail immediately on any file operation.
          // Discarding is safer than re-creating (pitch no-go #7).
          if (session.worktreePath !== undefined) {
            let worktreeExists = true;
            try {
              await fs.access(session.worktreePath);
            } catch {
              worktreeExists = false;
            }
            if (!worktreeExists) {
              console.log(
                `[WorkflowRunner] Startup recovery: discarding session ${session.sessionId} -- ` +
                `worktree no longer exists at ${session.worktreePath}.`,
              );
              break;
            }
          }

          // Rehydrate: call executeContinueWorkflow with intent: 'rehydrate' to get the current
          // step prompt and a fresh continueToken, without advancing the session.
          let rehydrateResult: Awaited<ReturnType<typeof _executeContinueWorkflowFn>>;
          try {
            rehydrateResult = await _executeContinueWorkflowFn(
              { continueToken: session.continueToken, intent: 'rehydrate' },
              ctx!,
            );
          } catch (err: unknown) {
            console.warn(
              `[WorkflowRunner] Startup recovery: rehydrate failed for session ${session.sessionId}: ` +
              `${err instanceof Error ? err.message : String(err)}. Discarding.`,
            );
            break;
          }

          if (rehydrateResult.isErr()) {
            console.warn(
              `[WorkflowRunner] Startup recovery: rehydrate error for session ${session.sessionId}: ` +
              `${rehydrateResult.error.kind}. Discarding.`,
            );
            break;
          }

          const rehydrated = rehydrateResult.value.response;

          // Only resume if the session has a pending step. isComplete=true means nothing to do.
          if (rehydrated.isComplete || !rehydrated.pending) {
            console.log(
              `[WorkflowRunner] Startup recovery: session ${session.sessionId} is already complete ` +
              `or has no pending step. Discarding.`,
            );
            break;
          }

          // Build a SessionSource to pass to runWorkflow() so it skips executeStartWorkflow().
          // WHY SessionSource (not _preAllocatedStartResponse): _preAllocatedStartResponse was
          // removed from WorkflowTrigger in A9. SessionSource is the typed replacement.
          // V2ContinueWorkflowOutputSchema 'ok' variant shares the fields we care about with
          // AllocatedSession: continueToken, checkpointToken, isComplete, and pending.prompt.
          const recoveryAllocatedSession: AllocatedSession = {
            continueToken: rehydrated.continueToken ?? '',
            checkpointToken: rehydrated.checkpointToken,
            firstStepPrompt: rehydrated.pending.prompt ?? '',
            isComplete: rehydrated.isComplete,
            triggerSource: 'daemon',
            // Pass the effective workspace path so buildPreAgentSession() can override
            // sessionWorkspacePath for recovered worktree sessions. Without this, the
            // recovery trigger has workspacePath=worktreePath (so the agent uses the
            // correct directory) but isWorktreeSession evaluates false (no scope boundary).
            // See AllocatedSession.sessionWorkspacePath for the full rationale.
            ...(session.worktreePath !== undefined
              ? { sessionWorkspacePath: session.worktreePath }
              : {}),
          };

          // Suppress worktree re-creation: the worktree already exists (or was never created).
          const branchStrategy: 'none' = 'none';

          // WHY workspacePath = session.workspacePath (main checkout), not session.worktreePath:
          // buildSystemPrompt() determines isWorktreeSession by comparing effectiveWorkspacePath
          // against trigger.workspacePath. If both are set to the worktree path, isWorktreeSession
          // is always false and the scope boundary paragraph is never injected. Setting
          // trigger.workspacePath to the original main checkout preserves the comparison,
          // and sessionWorkspacePath (from session.worktreePath) flows through buildPreAgentSession
          // as the actual workspace the agent uses.
          const recoveredTrigger: WorkflowTrigger = {
            workflowId: session.workflowId!,
            goal: session.goal ?? 'Resumed session (crash recovery)',
            workspacePath: session.workspacePath!,
            branchStrategy,
          };
          const recoverySource: SessionSource = {
            kind: 'pre_allocated',
            trigger: recoveredTrigger,
            session: recoveryAllocatedSession,
          };

          console.log(
            `[WorkflowRunner] Startup recovery: resuming session ${session.sessionId} ` +
            `workflowId=${session.workflowId} stepAdvances=${stepAdvances}`,
          );

          // Fire-and-forget: run the resumed session without blocking startup.
          // The sidecar is NOT deleted here -- runWorkflow() manages its own lifecycle.
          //
          // WHY bypass TriggerRouter semaphore: recovery sessions are rare and bounded by the
          // number of orphaned sidecars (typically 0-2). Routing through TriggerRouter.dispatch()
          // would require a triggerId and blocks on the semaphore -- neither is appropriate here.
          // Same tradeoff as spawn_agent (see makeSpawnAgentTool WHY comment).
          void _runWorkflowFn(
            recoveredTrigger,
            ctx!,
            apiKey,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            recoverySource,
          ).then((result) => {
            console.log(
              `[WorkflowRunner] Startup recovery: resumed session ${session.sessionId} completed: ${result._tag}`,
            );
          }).catch((err: unknown) => {
            console.warn(
              `[WorkflowRunner] Startup recovery: resumed session ${session.sessionId} failed: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          });

          preserved++;
          continue; // do NOT delete sidecar -- runWorkflow() manages its own lifecycle
        }
        case 'discard': {
          const label = isStale ? 'stale orphaned session' : 'orphaned session';
          console.log(
            `[WorkflowRunner] Discarding ${label}: sessionId=${session.sessionId} ` +
            `stepAdvances=${stepAdvances} age=${ageSec}s`,
          );
          break;
        }
        default:
          assertNever(action);
      }
    } else {
      // No ctx: log discard as before (backward-compatible behavior).
      const label = isStale ? 'stale orphaned session' : 'orphaned session';
      console.log(
        `[WorkflowRunner] Clearing ${label}: sessionId=${session.sessionId} age=${ageSec}s`,
      );
    }

    try {
      await fs.unlink(path.join(sessionsDir, `${session.sessionId}.json`));
      cleared++;
    } catch (err: unknown) {
      // Best-effort: ENOENT means already gone, any other error is logged.
      const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isEnoent) {
        console.warn(
          `[WorkflowRunner] Could not clear session file ${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Also clear any stray .tmp files left from a crash mid-write.
  await clearStrayTmpFiles(sessionsDir);

  if (ctx !== undefined) {
    console.log(
      `[WorkflowRunner] Startup recovery complete: preserved=${preserved} discarded=${cleared}/${sessions.length} orphaned session(s).`,
    );
  } else {
    console.log(`[WorkflowRunner] Startup recovery complete: cleared ${cleared}/${sessions.length} orphaned session(s).`);
  }
}

/**
 * Count the number of step advances (advance_recorded events) in a WorkRail session
 * event log for an orphaned session.
 *
 * WHY exported: testable in isolation via injectable _parseFn and _loadFn params --
 * callers can supply fakes without a real V2ToolContext.
 *
 * The injectable params are pre-bound: _parseFn takes only the raw token string, and
 * _loadFn takes only the sessionId. This keeps the function testable without requiring
 * real tokenCodecPorts or sessionStore instances in tests.
 *
 * Uses loadValidatedPrefix() instead of load() to handle truncated JSONL event logs
 * from a crash during append. Both 'complete' and 'truncated' kinds expose .truth.events.
 *
 * Returns 0 on any error (safe: caller falls back to discard).
 *
 * @param _parseFn - Injectable token parser. Receives the raw continueToken string and
 *   returns a ResultAsync<ContinueTokenResolved, ToolFailure>. Defaults to calling
 *   parseContinueTokenOrFail with ctx.v2.tokenCodecPorts and ctx.v2.tokenAliasStore.
 * @param _loadFn - Injectable session loader. Receives the WorkRail SessionId and
 *   returns a ResultAsync<LoadedValidatedPrefixV2, SessionEventLogStoreError>. Defaults to
 *   ctx.v2.sessionStore.loadValidatedPrefix.
 */
export async function countOrphanStepAdvances(
  continueToken: string,
  ctx: V2ToolContext,
  _parseFn: ((raw: string) => ResultAsync<ContinueTokenResolved, ToolFailure>) | undefined = undefined,
  _loadFn: SessionEventLogReadonlyStorePortV2['loadValidatedPrefix'] | undefined = undefined,
): Promise<number> {
  const parseFn = _parseFn ?? ((raw: string) =>
    parseContinueTokenOrFail(raw, ctx.v2.tokenCodecPorts, ctx.v2.tokenAliasStore)
  );
  const loadFn = _loadFn ?? ctx.v2.sessionStore.loadValidatedPrefix.bind(ctx.v2.sessionStore);

  // Decode the continueToken to extract the WorkRail sessionId.
  const resolvedResult = await parseFn(continueToken);

  if (resolvedResult.isErr()) {
    console.warn(
      `[WorkflowRunner] Could not decode continueToken for orphaned session: ${resolvedResult.error.message}`,
    );
    return 0;
  }

  const sessionId = asSessionId(resolvedResult.value.sessionId);

  // Use loadValidatedPrefix to handle crash-truncated JSONL gracefully.
  // Both 'complete' and 'truncated' kinds expose .truth.events with the valid prefix.
  const loadResult = await loadFn(sessionId);

  if (loadResult.isErr()) {
    console.warn(
      `[WorkflowRunner] Could not load session event log for orphaned session: ${loadResult.error.code} -- ${loadResult.error.message}`,
    );
    return 0;
  }

  const events = loadResult.value.truth.events;
  return events.filter((e) => e.kind === 'advance_recorded').length;
}

/**
 * Best-effort cleanup of queue-issue idempotency sidecars in the sessions directory.
 *
 * WHY these files exist: polling-scheduler.ts writes `queue-issue-<N>.json` BEFORE
 * dispatching a GitHub issue to prevent duplicate dispatch within a 56-minute window
 * (DISCOVERY_TIMEOUT_MS + 60s). On clean completion or error, the sidecar is deleted.
 * On daemon crash, it is NOT deleted -- it has a different JSON shape
 * ({ issueNumber, dispatchedAt, ttlMs }) than session sidecars ({ continueToken, ts })
 * and is silently skipped by readAllDaemonSessions().
 *
 * WHY unconditional: there is no link from OrphanedSession to the queue-issue sidecar
 * (OrphanedSession does not store the issue number). We must scan ALL queue-issue-*.json
 * files and delete them all.
 *
 * After deletion, the affected issue becomes eligible for re-dispatch in the next poll
 * cycle (~5 minutes).
 *
 * Non-fatal: any error (ENOENT, permissions) is caught per-file and logged. Never throws.
 *
 * WHY exported: called by runStartupRecovery() and testable in isolation.
 */
export async function clearQueueIssueSidecars(sessionsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return; // ENOENT or permission error -- nothing to clean up
  }

  for (const entry of entries) {
    if (!entry.startsWith('queue-issue-') || !entry.endsWith('.json')) continue;
    try {
      await fs.unlink(path.join(sessionsDir, entry));
      // Extract issue number from filename for log clarity.
      const issueNum = entry.slice('queue-issue-'.length, -'.json'.length);
      console.log(`[WorkflowRunner] Cleared queue-issue sidecar: issue=${issueNum}`);
    } catch (err: unknown) {
      const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isEnoent) {
        console.warn(
          `[WorkflowRunner] Could not clear queue-issue sidecar ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Best-effort cleanup of stray .tmp files in the sessions directory.
 *
 * These are written by persistTokens() as part of the atomic temp-rename pattern.
 * If the daemon crashes between writeFile(tmp) and rename(tmp, final), the .tmp
 * file is orphaned. It holds no useful state (the rename never completed), so we
 * discard it unconditionally.
 */
async function clearStrayTmpFiles(sessionsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return; // ENOENT or permission error -- nothing to clean up
  }

  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue;
    try {
      await fs.unlink(path.join(sessionsDir, entry));
      console.log(`[WorkflowRunner] Cleared stray temp file: ${entry}`);
    } catch {
      // Best-effort -- ignore all errors
    }
  }
}
