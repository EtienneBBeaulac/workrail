/**
 * Session finalization for completed daemon workflow runs.
 *
 * WHY this module: finalizeSession() consolidates all cleanup I/O for a
 * completed runWorkflow() call -- event emission, registry cleanup, stats,
 * sidecar deletion, conversation file deletion. It belongs in runner/ (the
 * orchestration layer), not in workflow-runner.ts.
 *
 * WHY runner/ can import io/ and core/: runner/ is the orchestration layer.
 * Correct direction: runner/ -> io/ and runner/ -> core/.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowRunResult } from '../types.js';
import type { FinalizationContext } from './runner-types.js';
import { tagToStatsOutcome, sidecardLifecycleFor } from '../core/index.js';
import { writeExecutionStats } from '../io/index.js';
import { withWorkrailSession } from '../tools/_shared.js';
import { assertNever } from '../../runtime/assert-never.js';

/**
 * Consolidate all session cleanup I/O for a completed runWorkflow() call.
 *
 * Handles:
 * 1. emitter?.emit({ kind: 'session_completed', ... })
 * 2. daemonRegistry?.unregister()
 * 3. writeExecutionStats()
 * 4. Sidecar file deletion (all paths except success+worktree)
 * 5. Conversation file deletion (success+non-worktree only)
 *
 * WHY consolidated here: each result path previously had ~15-20 lines of
 * identical cleanup code. A single function guarantees consistent behavior.
 */
export async function finalizeSession(
  result: WorkflowRunResult,
  ctx: FinalizationContext,
): Promise<void> {
  const outcome = tagToStatsOutcome(result._tag);
  const detail = result._tag === 'stuck' ? result.reason
    : result._tag === 'timeout' ? result.reason
    : result._tag === 'error' ? result.message.slice(0, 200)
    : result._tag === 'delivery_failed' ? result.deliveryError.slice(0, 200)
    : result.stopReason;
  ctx.emitter?.emit({
    kind: 'session_completed',
    sessionId: ctx.sessionId,
    workflowId: ctx.workflowId,
    outcome,
    detail,
    ...withWorkrailSession(ctx.workrailSessionId),
  });

  if (ctx.workrailSessionId !== null) {
    ctx.daemonRegistry?.unregister(
      ctx.workrailSessionId,
      result._tag === 'success' || result._tag === 'delivery_failed' ? 'completed' : 'failed',
    );
  }

  writeExecutionStats(ctx.statsDir, ctx.sessionId, ctx.workflowId, ctx.startMs, outcome, ctx.stepAdvanceCount);

  const lifecycle = sidecardLifecycleFor(result._tag, ctx.branchStrategy);
  switch (lifecycle.kind) {
    case 'delete_now':
      await fs.unlink(path.join(ctx.sessionsDir, `${ctx.sessionId}.json`)).catch(() => {});
      break;
    case 'retain_for_delivery':
      break;
    default:
      assertNever(lifecycle);
  }

  if (result._tag === 'success' && ctx.branchStrategy !== 'worktree') {
    await fs.unlink(ctx.conversationPath).catch(() => {});
  }
}
