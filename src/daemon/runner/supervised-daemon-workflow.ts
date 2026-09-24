import { z } from 'zod';
import type { SessionSource, WorkflowTrigger, WorkflowRunResult } from '../types.js';
import type { DaemonEventEmitter } from '../daemon-events.js';
import { asRunId } from '../daemon-events.js';
import { asSessionId } from '../../v2/durable-core/ids/index.js';
import { admissionFileName } from '../../answer-v1/immutable-admission-file.js';
import { runSupervisedWorkflow } from './supervised-workflow.js';

const SupportedTrigger = z.object({ workflowId: z.string(), goal: z.string(), workspacePath: z.string(), branchStrategy: z.literal('none').optional() }).strict();

/** Explicit opt-in at the existing daemon entrypoint. Unsupported legacy trigger
 * effects are refused rather than silently dropped or run against the host checkout. */
export async function runSupervisedDaemonWorkflow(trigger: WorkflowTrigger,
  source: Extract<SessionSource, { kind: 'supervised' }>, emitter?: DaemonEventEmitter): Promise<WorkflowRunResult> {
  const request = source.operation.request;
  if (!admissionFileName(source.operation.operationId) || !SupportedTrigger.safeParse(trigger).success || trigger.workflowId !== request.workflowId || trigger.goal !== request.goal || trigger.workspacePath !== request.workspacePath) {
    return { _tag: 'error', workflowId: trigger.workflowId, stopReason: 'unsupported_supervised_trigger',
      message: 'Supervised execution requires matching retained intent and no legacy context, checkout or delivery effects' };
  }
  const sessionId = asRunId(source.operation.operationId);
  emitter?.emit({ kind: 'session_started', sessionId, workflowId: request.workflowId, workspacePath: request.workspacePath });
  const result = await runSupervisedWorkflow(source.scheduler, source.operation, source.signal);
  if (result.kind === 'completed') {
    const workrailSessionId = asSessionId(result.execution);
    emitter?.emit({ kind: 'session_completed', sessionId, workflowId: request.workflowId, workrailSessionId,
      outcome: 'success', detail: 'Workflow execution completed; task outcome remains separately reported' });
    return { _tag: 'success', workflowId: request.workflowId, stopReason: 'workflow_completed', workrailSessionId,
      taskOutcome: result.view.taskOutcome, lastStepNotes: result.output.notesMarkdown, lastStepArtifacts: result.output.artifacts };
  }
  if (result.kind === 'not_started' && result.enrollment.kind === 'refused') {
    emitter?.emit({ kind: 'session_completed', sessionId, workflowId: request.workflowId, outcome: 'error', detail: result.enrollment.reason });
    return { _tag: 'error', workflowId: request.workflowId, stopReason: result.enrollment.reason, message: 'Supervised admission refused before execution' };
  }
  // Suspended and uncertain execution retains operation correlation. Existing
  // finalization already knows this result must not delete sidecars or deliver changes.
  emitter?.emit({ kind: 'session_suspended', sessionId, workflowId: request.workflowId,
    operationId: source.operation.operationId, reason: 'execution_unconfirmed' });
  return { _tag: 'recovery_pending', workflowId: request.workflowId, stopReason: 'recovery_pending',
    operationId: source.operation.operationId, reason: 'execution_unconfirmed' };
}
