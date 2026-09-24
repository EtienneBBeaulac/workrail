import type { CompletedAnswerOutput } from '../../answer-v1/completed-output.js';
import type { TurnOutcome } from '../../answer-v1/contracts/host-composition.js';
import type { WorkView } from '../../answer-v1/contracts/answer-contract.js';
import type { createSupervisedAnswerHost, SupervisedOperation } from './supervised-answer-host.js';

type Scheduler = Extract<Awaited<ReturnType<typeof createSupervisedAnswerHost>>, { kind: 'created' }>['scheduler'];
type Enrollment = Awaited<ReturnType<Scheduler['enroll']>>;
type Ready = Extract<Extract<Enrollment, { kind: 'preparation_result' }>['result'], { kind: 'ready' }>;
type Release = Awaited<ReturnType<Ready['execution']['release']>>;

type CompletedView = Omit<Extract<WorkView, { kind: 'finished' }>, 'execution'> & Readonly<{ execution: Readonly<{ kind: 'completed' }> }>;

export type SupervisedWorkflowResult =
  | Readonly<{ kind: 'completed'; operation: SupervisedOperation; execution: Ready['enrollment']['execution']; view: CompletedView; output: CompletedAnswerOutput; outcome: TurnOutcome }>
  | Readonly<{ kind: 'not_started'; operation: SupervisedOperation; enrollment: Exclude<Enrollment, { kind: 'preparation_result'; result: Ready }> }>
  | Readonly<{ kind: 'suspended'; operation: SupervisedOperation; execution: Ready['enrollment']['execution']; outcome: TurnOutcome; release?: Release }>
  | Readonly<{ kind: 'output_unavailable'; operation: SupervisedOperation; execution: Ready['enrollment']['execution']; outcome: TurnOutcome }>
  | Readonly<{ kind: 'unconfirmed'; operation: SupervisedOperation }>;

/** The host advances deliveries; a model only answers its current question. This driver
 * never falls back to legacy tools or replaces an uncertain operation with a new one.
 * Each iteration consumes the retained execution deadline and model-call budget. */
export async function runSupervisedWorkflow(scheduler: Pick<Scheduler, 'enroll'>, operation: SupervisedOperation, signal: AbortSignal): Promise<SupervisedWorkflowResult> {
  try {
    const enrolled = await scheduler.enroll(operation, signal);
    if (enrolled.kind !== 'preparation_result') return { kind: 'not_started', operation, enrollment: enrolled };
    if (enrolled.result.kind !== 'ready') return { kind: 'not_started', operation, enrollment: { ...enrolled, result: enrolled.result } };
    const ready = enrolled.result;
    while (true) {
      const outcome = await ready.execution.runner.runTurn(signal);
      const view = resultView(outcome);
      if (view?.kind === 'question' && (outcome.kind === 'advanced' || outcome.kind === 'partial' || outcome.kind === 'rejected')) continue;
      if (view?.kind === 'finished' && view.execution.kind === 'completed') {
        // A committed final answer is preserved even when cleanup prevents release.
        const output = await ready.execution.output(signal);
        if (output.kind !== 'available') return { kind: 'output_unavailable', operation, execution: ready.enrollment.execution, outcome };
        const release = await ready.execution.release(signal);
        return release.kind === 'released'
          ? { kind: 'completed', operation, execution: ready.enrollment.execution, view: { ...view, execution: view.execution }, output: output.output, outcome }
          : { kind: 'suspended', operation, execution: ready.enrollment.execution, outcome, release };
      }
      return { kind: 'suspended', operation, execution: ready.enrollment.execution, outcome };
    }
  } catch {
    // No fabricated completion, retry identity or lost recovery correlation.
    return { kind: 'unconfirmed', operation };
  }
}

function resultView(outcome: TurnOutcome): WorkView | undefined {
  switch (outcome.kind) {
    case 'advanced': case 'partial': return outcome.nextView;
    case 'rejected': return outcome.correctionView;
    case 'settled': case 'no_work_required': return outcome.view;
    case 'refused': case 'stopped': case 'unconfirmed': case 'stale_owner': case 'cancelled': return undefined;
  }
}
