/**
 * WorkRail Auto: Delivery Pipeline
 *
 * Defines the staged delivery pipeline executed after a successful workflow run.
 * Each stage is an independent unit of work that can fail without affecting later
 * stages (cleanup stages) or that stops the pipeline (parse stage).
 *
 * WHY staged design (not a monolithic function):
 * Future features (MR lifecycle manager, PR template support, escalating review gates)
 * are each a new DeliveryStage entry in DEFAULT_DELIVERY_PIPELINE. Adding a stage is
 * additive -- one new stage object, one new entry. Without stages, each addition grows
 * maybeRunDelivery() the same way workflow-runner.ts grew to 5000 lines.
 *
 * WHY PipelineContext (not stage return values):
 * parseHandoffStage produces a HandoffArtifact that gitDeliveryStage needs. The
 * DeliveryStage.run() interface does not chain outputs to inputs to keep the interface
 * simple. PipelineContext is a scoped mutable object created per pipeline run -- the
 * mutation is bounded and not observable outside runDeliveryPipeline().
 *
 * WHY top-level try/catch in runDeliveryPipeline:
 * maybeRunDelivery() is called inside a void queue.enqueue() callback. Any uncaught
 * exception would be an unhandled rejection that exits the Node 20 process. The
 * try/catch converts any unexpected error into a log entry, never a process crash.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowRunSuccess } from '../daemon/types.js';
import { DAEMON_SESSIONS_DIR } from '../daemon/workflow-runner.js';
import type { TriggerDefinition } from './types.js';
import type { ExecFn, HandoffArtifact } from './delivery-action.js';
import { parseHandoffArtifact, runDelivery } from './delivery-action.js';
import type { ExecutionSessionGateV2 } from '../v2/usecases/execution-session-gate.js';
import type { SessionEventLogAppendStorePortV2 } from '../v2/ports/session-event-log-store.port.js';
import { EVENT_KIND } from '../v2/durable-core/constants.js';
import { asSessionId } from '../v2/durable-core/ids/index.js';
import { buildSessionIndex } from '../v2/durable-core/session-index.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { okAsync } from 'neverthrow';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of running a single DeliveryStage.
 *
 * 'continue' means proceed to the next stage.
 * 'stop' means halt the pipeline (no subsequent stages run).
 */
export type DeliveryStageOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'stop'; readonly reason: string };

/**
 * A single step in the post-workflow delivery pipeline.
 *
 * Stages are independent: each stage receives the same (result, trigger, execFn)
 * arguments and communicates with adjacent stages only through PipelineContext.
 *
 * Stage contract:
 * - Must never throw. Catch all errors internally; return stop or continue.
 * - Cleanup stages (worktree remove, sidecar delete) should return continue even
 *   on error (best-effort semantics).
 * - Blocking stages (parseHandoffStage) return stop on failure to prevent later
 *   stages from running with incomplete context.
 */
export interface DeliveryStage {
  readonly name: string;
  run(
    result: WorkflowRunSuccess,
    trigger: TriggerDefinition,
    execFn: ExecFn,
    ctx: PipelineContext,
    deps?: DeliveryPipelineDeps,
  ): Promise<DeliveryStageOutcome>;
}

/**
 * Shared mutable context threaded through a single pipeline run.
 *
 * WHY mutable: parseHandoffStage sets ctx.handoffArtifact; gitDeliveryStage reads it.
 * The mutation is scoped to one runDeliveryPipeline() call -- not observable outside.
 *
 * WHY not pass HandoffArtifact as a stage return value:
 * DeliveryStage.run() returns a control-flow signal (continue/stop), not data. Adding
 * a data channel to the return type would widen the interface for all stages that don't
 * produce data. PipelineContext is the minimal pattern.
 */
export interface PipelineContext {
  handoffArtifact?: HandoffArtifact;
  /** SHA produced by gitDeliveryStage on successful commit. Set for write-back. */
  commitSha?: string;
  /** PR URL produced by gitDeliveryStage when autoOpenPR is true. Set for write-back. */
  prUrl?: string;
}

/**
 * Optional session store dependencies for the delivery pipeline.
 *
 * When present, enables recordCommitShasStage to append a delivery_recorded event
 * to the session event log after a successful git commit.
 *
 * WHY optional: the delivery pipeline runs in the daemon context which may not always
 * have session store access (e.g. test contexts). When absent, write-back is silently
 * skipped -- never an error.
 */
export interface DeliveryPipelineDeps {
  readonly gate: ExecutionSessionGateV2;
  readonly sessionStore: SessionEventLogAppendStorePortV2 & import('../v2/ports/session-event-log-store.port.js').SessionEventLogReadonlyStorePortV2;
  readonly idFactory: { readonly mintEventId: () => string };
}

// ---------------------------------------------------------------------------
// runDeliveryPipeline
// ---------------------------------------------------------------------------

/**
 * Run all stages in order. Stop on the first 'stop' outcome.
 *
 * Never throws -- errors inside stages are caught internally by each stage.
 * The top-level try/catch here is a final safety net for unexpected exceptions
 * (e.g. a stage that violates the 'never throw' contract).
 *
 * @param stages - The ordered pipeline to execute
 * @param result - The completed workflow's success result
 * @param trigger - Source of workspacePath, autoCommit, branchStrategy flags
 * @param execFn - Injectable exec function (production: execFileAsync; tests: fake)
 * @param triggerId - Used in log messages for traceability
 */
export async function runDeliveryPipeline(
  stages: readonly DeliveryStage[],
  result: WorkflowRunSuccess,
  trigger: TriggerDefinition,
  execFn: ExecFn,
  triggerId: string,
  deps?: DeliveryPipelineDeps,
): Promise<void> {
  const ctx: PipelineContext = {};

  try {
    for (const stage of stages) {
      const outcome = await stage.run(result, trigger, execFn, ctx, deps);
      if (outcome.kind === 'stop') {
        console.log(
          `[DeliveryPipeline] Stage "${stage.name}" stopped pipeline: triggerId=${triggerId} reason=${outcome.reason}`,
        );
        return;
      }
    }
  } catch (err: unknown) {
    // Safety net: a stage violated the 'never throw' contract.
    // Log and return -- never propagate to the queue callback.
    console.error(
      `[DeliveryPipeline] Unexpected error in pipeline: triggerId=${triggerId} ` +
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

/**
 * Stage 1: Parse the structured handoff artifact from the agent's final step notes.
 *
 * Sets ctx.handoffArtifact on success. Returns stop on failure so subsequent stages
 * do not run without a valid artifact.
 *
 * WHY stop on failure: without a handoff artifact, git delivery cannot stage the
 * correct files. Skipping delivery (stop) is safer than attempting delivery with
 * incomplete data.
 */
const parseHandoffStage: DeliveryStage = {
  name: 'parseHandoff',
  async run(result, trigger, _execFn, ctx) {
    // result.lastStepNotes is guaranteed non-undefined by maybeRunDelivery() preamble.
    // The non-null assertion is safe here.
    const parseResult = parseHandoffArtifact(result.lastStepNotes!);
    if (parseResult.kind === 'err') {
      console.warn(
        `[DeliveryPipeline] Delivery skipped: triggerId=${trigger.id} -- ` +
        `handoff artifact not parseable: ${parseResult.error}. ` +
        `Ensure the workflow's final step produces a JSON block with commitType, filesChanged, etc.`,
      );
      return { kind: 'stop', reason: `handoff artifact parse failed: ${parseResult.error}` };
    }
    ctx.handoffArtifact = parseResult.value;
    return { kind: 'continue' };
  },
};

/**
 * Stage 2: Run git add, commit, push, and optionally gh pr create.
 *
 * Reads ctx.handoffArtifact set by parseHandoffStage. The explicit undefined guard
 * protects against any future pipeline ordering mistake.
 *
 * WHY deliveryCwd uses sessionWorkspacePath ?? workspacePath:
 * Worktree sessions must commit from the worktree (that's where the agent made changes).
 * Non-worktree sessions use trigger.workspacePath (the only checkout). See the original
 * WHY comment in maybeRunDelivery() for full rationale.
 */
const gitDeliveryStage: DeliveryStage = {
  name: 'gitDelivery',
  async run(result, trigger, execFn, ctx) {
    // Defense-in-depth: parseHandoffStage must have run first and set this field.
    // If it is undefined, the pipeline ordering invariant has been violated.
    if (ctx.handoffArtifact === undefined) {
      return {
        kind: 'stop',
        reason: 'handoffArtifact not available -- parseHandoffStage must run before gitDeliveryStage',
      };
    }

    // Use sessionWorkspacePath when available (worktree sessions must commit from the worktree,
    // not from the main checkout). Fall back to trigger.workspacePath for 'none' sessions.
    // WHY: the agent's changes live in the worktree. git add/commit/push must run there.
    const deliveryCwd = result.sessionWorkspacePath ?? trigger.workspacePath;

    const deliveryResult = await runDelivery(
      ctx.handoffArtifact,
      deliveryCwd,
      {
        autoCommit: trigger.autoCommit,
        autoOpenPR: trigger.autoOpenPR,
        // secretScan: pass trigger value (undefined = use default true in runDelivery).
        // WHY ?? true not needed here: runDelivery checks flags.secretScan !== false,
        // so undefined is equivalent to true. Passing trigger.secretScan preserves the
        // explicit false from triggers.yml without needing a default here.
        secretScan: trigger.secretScan ?? true,
        // Attribution: triggerId and workflowId are used in the PR body footer so operators
        // can trace the PR back to the trigger and workflow that produced it.
        triggerId: trigger.id,
        workflowId: trigger.workflowId,
        // Per-command git identity: threaded from WorkflowRunSuccess.botIdentity (which was
        // set from trigger.botIdentity in runWorkflow). Avoids writing to the shared .git/config.
        ...(result.botIdentity !== undefined ? { botIdentity: result.botIdentity } : {}),
        // Branch assertion: verify HEAD matches expected branch before git push.
        // Only meaningful for worktree sessions -- 'none' sessions use trigger.workspacePath.
        // WHY result.sessionId (not split from path): sessionId is threaded directly through
        // WorkflowRunSuccess to avoid fragile path-parsing that couples branch naming convention
        // to the calling code. See WorkflowRunSuccess.sessionId for the full rationale.
        ...(trigger.branchStrategy === 'worktree' && result.sessionWorkspacePath
          ? {
              sessionId: result.sessionId ?? '',
              branchPrefix: trigger.branchPrefix ?? 'worktrain/',
            }
          : {}),
      },
      execFn,
    );

    switch (deliveryResult._tag) {
      case 'committed':
        console.log(
          `[DeliveryPipeline] Delivery committed: triggerId=${trigger.id} sha=${deliveryResult.sha}`,
        );
        ctx.commitSha = deliveryResult.sha;
        break;
      case 'pr_opened':
        console.log(
          `[DeliveryPipeline] Delivery PR opened: triggerId=${trigger.id} url=${deliveryResult.url} sha=${deliveryResult.sha}`,
        );
        ctx.commitSha = deliveryResult.sha;
        ctx.prUrl = deliveryResult.url;
        break;
      case 'skipped':
        console.log(
          `[DeliveryPipeline] Delivery skipped: triggerId=${trigger.id} reason=${deliveryResult.reason}`,
        );
        break;
      case 'error':
        console.warn(
          `[DeliveryPipeline] Delivery error: triggerId=${trigger.id} phase=${deliveryResult.phase} ` +
          `details=${deliveryResult.details}`,
        );
        break;
    }

    return { kind: 'continue' };
  },
};

/**
 * Stage 3: Remove the isolated git worktree after delivery completes.
 *
 * WHY after delivery (not in runWorkflow()): delivery (git add, commit, push, gh pr create)
 * all run inside the worktree. The worktree must exist until delivery finishes. Removing it
 * inside runWorkflow() before delivery would break the delivery path.
 *
 * WHY after delivery regardless of deliveryResult._tag: the worktree's purpose is to
 * serve the session. Once delivery has been attempted (success or error), the worktree
 * has served its purpose and should be cleaned up to avoid disk accumulation.
 *
 * WHY best-effort (catch + log): cleanup failure must never affect the workflow result.
 * A non-removable worktree will be reaped by runStartupRecovery() after 24h.
 *
 * Only runs when branchStrategy === 'worktree' and sessionWorkspacePath is present.
 */
/**
 * Stage 2b: Record commit SHAs into the session event log after delivery.
 *
 * WHY after gitDeliveryStage: commit SHAs only exist after git commit succeeds.
 * The engine's run_completed event fires before delivery -- it cannot know the SHAs.
 * This stage bridges the gap: the delivery layer appends a delivery_recorded event
 * with the authoritative SHA derived from git commit output.
 *
 * WHY best-effort (always return continue): SHA attribution is observability data.
 * A write-back failure must never block worktree cleanup or sidecar deletion.
 *
 * WHY gates on sessionId + commitSha + deps: non-worktree sessions, skipped deliveries,
 * and contexts without session store access all skip silently -- no error.
 */
const recordCommitShasStage: DeliveryStage = {
  name: 'recordCommitShas',
  async run(result, _trigger, _execFn, ctx, deps) {
    const { sessionId } = result;
    if (!sessionId || !ctx.commitSha || !deps) {
      return { kind: 'continue' };
    }

    try {
      const sid = asSessionId(sessionId);
      const shas = [ctx.commitSha];
      const prUrl = ctx.prUrl;

      await deps.gate.withHealthySessionLock(sid, (lock) =>
        deps.sessionStore.load(sid).andThen((truth) => {
          const sortedResult = asSortedEventLog(truth.events);
          if (sortedResult.isErr()) {
            return okAsync(undefined as void);
          }
          const index = buildSessionIndex(sortedResult.value);
          const runCompleted = truth.events.find(e => e.kind === 'run_completed');
          const runId = runCompleted?.scope.runId;
          if (!runId) {
            return okAsync(undefined as void);
          }
          const event = {
            v: 1 as const,
            eventId: deps.idFactory.mintEventId(),
            eventIndex: index.nextEventIndex,
            sessionId,
            kind: EVENT_KIND.DELIVERY_RECORDED,
            dedupeKey: `delivery-recorded:${sessionId}:${runId}`,
            scope: { runId },
            data: { shas, ...(prUrl ? { prUrl } : {}) },
            timestampMs: Date.now(),
          };
          return deps.sessionStore.append(lock, { events: [event], snapshotPins: [] });
        })
      ).match(
        () => {
          console.log(`[DeliveryPipeline] Commit SHAs recorded: sessionId=${sessionId} shas=${shas.join(',')}`);
        },
        (err) => {
          console.warn(`[DeliveryPipeline] Could not record commit SHAs: sessionId=${sessionId} err=${JSON.stringify(err)}`);
        },
      );
    } catch (err: unknown) {
      console.warn(`[DeliveryPipeline] Unexpected error in recordCommitShasStage: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { kind: 'continue' };
  },
};

const cleanupWorktreeStage: DeliveryStage = {
  name: 'cleanupWorktree',
  async run(result, trigger, execFn, _ctx) {
    if (trigger.branchStrategy !== 'worktree' || !result.sessionWorkspacePath) {
      return { kind: 'continue' };
    }

    try {
      await execFn(
        'git',
        ['-C', trigger.workspacePath, 'worktree', 'remove', '--force', result.sessionWorkspacePath],
        { cwd: trigger.workspacePath, timeout: 60_000 },
      );
      console.log(
        `[DeliveryPipeline] Worktree removed: triggerId=${trigger.id} path=${result.sessionWorkspacePath}`,
      );
    } catch (err: unknown) {
      console.warn(
        `[DeliveryPipeline] Could not remove worktree: triggerId=${trigger.id} ` +
        `path=${result.sessionWorkspacePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { kind: 'continue' };
  },
};

/**
 * Stage 4: Delete the session sidecar file and conversation file after delivery and
 * worktree removal complete.
 *
 * WHY here (not in runWorkflow()): this is the safe deletion point for the session
 * sidecar after delivery and worktree removal are complete. Deleting the sidecar in
 * runWorkflow() before returning would leave the worktree invisible to
 * runStartupRecovery() if the daemon crashes between runWorkflow() returning and this
 * point. The sidecar must outlive the runWorkflow() return for worktree sessions.
 * For non-autoCommit sessions this stage is a no-op; startup recovery handles sidecar
 * cleanup for those sessions.
 * NOTE: countActiveSessions() counts sidecars, so this brief inflation during delivery
 * is intentional and semantically correct (the session is still completing).
 *
 * WHY conversation file deleted here: workflow-runner.ts only deletes it for non-worktree
 * (direct) sessions; worktree sessions defer both sidecar and conversation file deletion
 * to this point after delivery completes.
 *
 * Only runs when branchStrategy === 'worktree' and sessionId is present.
 *
 * WHY sessionId guard (not sessionWorkspacePath): sessionId and sessionWorkspacePath
 * are co-present -- both are set or both are absent for worktree sessions (see
 * WorkflowRunSuccess in workflow-runner.ts). Gating on sessionId is equivalent to
 * gating on sessionWorkspacePath for the deletion case; sessionId is what we need
 * to construct the file path.
 */
const deleteSidecarStage: DeliveryStage = {
  name: 'deleteSidecar',
  async run(result, trigger, _execFn, _ctx) {
    if (trigger.branchStrategy !== 'worktree' || result.sessionId === undefined) {
      return { kind: 'continue' };
    }

    await fs.unlink(path.join(DAEMON_SESSIONS_DIR, `${result.sessionId}.json`)).catch(() => {});
    // WHY: conversation file must be cleaned up here alongside the sidecar for worktree sessions.
    await fs.unlink(path.join(DAEMON_SESSIONS_DIR, `${result.sessionId}-conversation.jsonl`)).catch(() => {});
    console.log(
      `[DeliveryPipeline] Session sidecar removed: triggerId=${trigger.id} sessionId=${result.sessionId}`,
    );

    return { kind: 'continue' };
  },
};

// ---------------------------------------------------------------------------
// Default pipeline
// ---------------------------------------------------------------------------

/**
 * The default delivery pipeline executed after every successful workflow run
 * with autoCommit enabled.
 *
 * Stage order matters:
 * 1. parseHandoffStage      -- sets ctx.handoffArtifact; stops pipeline on failure
 * 2. gitDeliveryStage       -- commits and optionally opens PR; sets ctx.commitSha
 * 2b. recordCommitShasStage -- appends delivery_recorded event to session log (best-effort)
 * 3. cleanupWorktreeStage   -- removes the worktree (worktree sessions only)
 * 4. deleteSidecarStage     -- removes sidecar + conversation file (worktree sessions only)
 *
 * Future stages are additive: add a new DeliveryStage, add it to this array.
 */
export const DEFAULT_DELIVERY_PIPELINE: readonly DeliveryStage[] = [
  parseHandoffStage,
  gitDeliveryStage,
  recordCommitShasStage,
  cleanupWorktreeStage,
  deleteSidecarStage,
];
