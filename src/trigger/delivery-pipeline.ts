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
import type { WorkflowRunSuccess } from '../daemon/workflow-runner.js';
import { DAEMON_SESSIONS_DIR } from '../daemon/workflow-runner.js';
import type { TriggerDefinition } from './types.js';
import type { ExecFn, HandoffArtifact } from './delivery-action.js';
import { parseHandoffArtifact, runDelivery } from './delivery-action.js';

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
): Promise<void> {
  const ctx: PipelineContext = {};

  try {
    for (const stage of stages) {
      const outcome = await stage.run(result, trigger, execFn, ctx);
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
        break;
      case 'pr_opened':
        console.log(
          `[DeliveryPipeline] Delivery PR opened: triggerId=${trigger.id} url=${deliveryResult.url}`,
        );
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
 * 1. parseHandoffStage -- sets ctx.handoffArtifact; stops pipeline on failure
 * 2. gitDeliveryStage  -- reads ctx.handoffArtifact; commits and optionally opens PR
 * 3. cleanupWorktreeStage -- removes the worktree (worktree sessions only)
 * 4. deleteSidecarStage -- removes sidecar + conversation file (worktree sessions only)
 *
 * Future stages are additive: add a new DeliveryStage, add it to this array.
 */
export const DEFAULT_DELIVERY_PIPELINE: readonly DeliveryStage[] = [
  parseHandoffStage,
  gitDeliveryStage,
  cleanupWorktreeStage,
  deleteSidecarStage,
];
