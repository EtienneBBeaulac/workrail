/**
 * Gate Session Resumption
 *
 * Resumes a daemon session that was parked at a gate checkpoint after the
 * coordinator has evaluated the gate and produced a typed GateVerdict.
 *
 * Design invariants:
 * - resumeFromGate() never throws -- all failures return err().
 * - The gate verdict is injected into firstStepPrompt (not via rehydrate context,
 *   which is silently discarded by handleRehydrateIntent).
 * - The OLD gate sidecar is explicitly deleted before firing runWorkflow() to
 *   prevent stale sidecar accumulation (runWorkflow uses a fresh sessionId).
 * - On token expiry: postToOutbox() + delete sidecar + return err().
 * - runWorkflow() is fire-and-forget; callers do not await the resumed session.
 *
 * WHY verdict in firstStepPrompt (not context): handleRehydrateIntent in
 * continue-rehydrate.ts does not store input.context -- it is silently discarded.
 * Context injection only happens via context_set events written on advance calls.
 * firstStepPrompt becomes the first user message in the agent loop, so the agent
 * receives the verdict immediately and can pass it as context when it advances.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { V2ToolContext } from '../mcp/types.js';
import { executeContinueWorkflow } from '../mcp/handlers/v2-execution/index.js';
import { ok, err, type Result } from '../runtime/result.js';
import type { WorkflowTrigger, AllocatedSession, SessionSource } from './types.js';
import type { DaemonRegistry } from '../v2/infra/in-memory/daemon-registry/index.js';
import type { DaemonEventEmitter } from './daemon-events.js';
import type { ActiveSessionSet } from './active-sessions.js';
import { DAEMON_SESSIONS_DIR } from './tools/_shared.js';
import type { runWorkflow } from './workflow-runner.js';
import type { GateVerdict } from '../coordinators/gate-evaluator-dispatcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResumeFromGateError =
  | { readonly kind: 'missing_sidecar_fields'; readonly message: string }
  | { readonly kind: 'token_expired'; readonly message: string }
  | { readonly kind: 'no_pending_step'; readonly message: string }
  | { readonly kind: 'sidecar_read_failed'; readonly message: string };

/** Inlined postToOutbox to avoid import dependency on CoordinatorDepsImpl. */
async function postToOutboxFile(message: string, metadata: Record<string, unknown>): Promise<void> {
  const outboxPath = path.join(os.homedir(), '.workrail', 'outbox.jsonl');
  const entry = JSON.stringify({ id: randomUUID(), message, metadata, timestamp: new Date().toISOString() }) + '\n';
  await fs.appendFile(outboxPath, entry, 'utf8').catch(() => { /* best-effort */ });
}

// ---------------------------------------------------------------------------
// resumeFromGate
// ---------------------------------------------------------------------------

/**
 * Resume a gate-parked session after coordinator gate evaluation.
 *
 * @param sessionId - The parked session's daemon-local UUID (keys the sidecar file)
 * @param verdict - The typed GateVerdict from GateEvaluatorDispatcher
 * @param ctx - V2ToolContext from the shared DI container
 * @param apiKey - Anthropic API key for the resumed agent loop
 * @param runWorkflowFn - Injectable runWorkflow for testing
 * @param daemonRegistry - Optional registry for tracking live sessions
 * @param emitter - Optional event emitter for observability
 * @param activeSessionSet - Optional session set for steer injection capability
 * @param sessionsDir - Override for the sessions directory (for testing)
 */
export async function resumeFromGate(
  sessionId: string,
  verdict: GateVerdict,
  ctx: V2ToolContext,
  apiKey: string,
  runWorkflowFn: typeof runWorkflow,
  daemonRegistry?: DaemonRegistry,
  emitter?: DaemonEventEmitter,
  activeSessionSet?: ActiveSessionSet,
  sessionsDir: string = DAEMON_SESSIONS_DIR,
  // Optional injection point for testing -- defaults to the real implementation.
  _executeContinueWorkflowFn: typeof executeContinueWorkflow = executeContinueWorkflow,
): Promise<Result<void, ResumeFromGateError>> {
  const sidecarPath = path.join(sessionsDir, `${sessionId}.json`);

  // ---- Step 1: Read sidecar ----
  let sidecar: {
    gateState?: { kind: string; gateToken: string; stepId: string };
    workflowId?: string;
    goal?: string;
    workspacePath?: string;
    worktreePath?: string;
    continueToken?: string;
  };
  try {
    const raw = await fs.readFile(sidecarPath, 'utf8');
    sidecar = JSON.parse(raw) as typeof sidecar;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({ kind: 'sidecar_read_failed', message: `Could not read gate sidecar for session ${sessionId}: ${msg}` });
  }

  const gateToken = sidecar.gateState?.gateToken;
  const workflowId = sidecar.workflowId;
  const workspacePath = sidecar.workspacePath;
  const goal = sidecar.goal ?? 'Resumed gate session';

  if (!gateToken || !workflowId || !workspacePath) {
    const missing = [!gateToken && 'gateToken', !workflowId && 'workflowId', !workspacePath && 'workspacePath']
      .filter(Boolean).join(', ');
    await fs.unlink(sidecarPath).catch(() => {});
    return err({ kind: 'missing_sidecar_fields', message: `Gate sidecar missing required fields: ${missing}` });
  }

  // ---- Step 2: Rehydrate (no context -- silently discarded by handleRehydrateIntent) ----
  const rehydrateResult = await _executeContinueWorkflowFn(
    { continueToken: gateToken, intent: 'rehydrate' },
    ctx,
  );

  if (rehydrateResult.isErr()) {
    const msg = `${rehydrateResult.error.kind}: ${JSON.stringify(rehydrateResult.error)}`;
    await postToOutboxFile(
      `Gate session ${sessionId} could not be resumed -- token expired or invalid. Trigger will re-fire on next poll cycle.`,
      { sessionId, workflowId, stepId: sidecar.gateState?.stepId ?? '', error: msg },
    );
    await fs.unlink(sidecarPath).catch(() => {});
    return err({ kind: 'token_expired', message: `Rehydrate failed for gate session ${sessionId}: ${msg}` });
  }

  const rehydrated = rehydrateResult.value.response;

  // Defensive gate_checkpoint guard for type narrowing. handleRehydrateIntent returns
  // 'ok' or 'blocked' -- never 'gate_checkpoint' -- but the type system sees the full
  // V2ContinueWorkflowOutputSchema union which includes gate_checkpoint from PR 1.
  if (rehydrated.kind === 'gate_checkpoint') {
    // This path is unreachable in practice (rehydrate never returns gate_checkpoint),
    // but is required for TypeScript narrowing. Log and discard.
    console.warn(`[GateResume] Unexpected gate_checkpoint rehydrate response for session ${sessionId}. Discarding.`);
    await fs.unlink(sidecarPath).catch(() => {});
    return err({ kind: 'no_pending_step', message: `Gate session ${sessionId} returned unexpected gate_checkpoint on rehydrate` });
  }

  if (rehydrated.isComplete) {
    await fs.unlink(sidecarPath).catch(() => {});
    return err({ kind: 'no_pending_step', message: `Gate session ${sessionId} is already complete` });
  }

  const pendingPrompt = rehydrated.pending?.prompt ?? '';
  const freshContinueToken = rehydrated.continueToken ?? '';
  const freshCheckpointToken = rehydrated.checkpointToken ?? null;

  // ---- Step 3: Build firstStepPrompt with verdict injected ----
  // WHY inject here (not via context): handleRehydrateIntent ignores input.context.
  // The firstStepPrompt becomes the first user message in the agent loop, ensuring the
  // agent receives the verdict in its first turn and can pass it as context when advancing.
  const verdictBlock = [
    '---',
    `**Gate evaluation result for step '${verdict.stepId}':**`,
    `- Verdict: **${verdict.verdict}**`,
    `- Confidence: ${verdict.confidence}`,
    `- Rationale: ${verdict.rationale}`,
    '',
    verdict.verdict === 'approved'
      ? 'The gate has been approved. Continue with the step as described above.'
      : `The gate verdict is **${verdict.verdict}**. Review the rationale above before proceeding.`,
  ].join('\n');

  const firstStepPrompt = pendingPrompt
    ? `${pendingPrompt}\n\n${verdictBlock}`
    : verdictBlock;

  // ---- Step 4: Build AllocatedSession + WorkflowTrigger ----
  const allocatedSession: AllocatedSession = {
    continueToken: freshContinueToken,
    checkpointToken: freshCheckpointToken,
    firstStepPrompt,
    isComplete: false,
    triggerSource: 'daemon',
    ...(sidecar.worktreePath !== undefined ? { sessionWorkspacePath: sidecar.worktreePath } : {}),
  };

  const recoveredTrigger: WorkflowTrigger = {
    workflowId,
    goal,
    workspacePath,
    branchStrategy: 'none' as const,
  };

  const source: SessionSource = {
    kind: 'pre_allocated',
    trigger: recoveredTrigger,
    session: allocatedSession,
  };

  // ---- Step 5: Delete the gate sidecar BEFORE firing runWorkflow ----
  // WHY before: runWorkflow creates a fresh sessionId with its own sidecar.
  // The old gate sidecar (keyed by gateSessionId) would otherwise accumulate
  // until the next startup-recovery cycle.
  await fs.unlink(sidecarPath).catch(() => {});

  console.log(
    `[GateResume] Resuming session ${sessionId} workflowId=${workflowId} ` +
    `verdict=${verdict.verdict} stepId=${verdict.stepId}`,
  );

  // ---- Step 6: Fire-and-forget runWorkflow ----
  void runWorkflowFn(
    recoveredTrigger,
    ctx,
    apiKey,
    daemonRegistry,
    emitter,
    activeSessionSet,
    undefined,
    undefined,
    source,
  ).then((result) => {
    console.log(`[GateResume] Resumed session ${sessionId} completed: ${result._tag}`);
  }).catch((e: unknown) => {
    console.error(`[GateResume] Resumed session ${sessionId} threw: ${e instanceof Error ? e.message : String(e)}`);
  });

  return ok(undefined);
}
