import type { BoundTurnRunner, RuntimeCloseResult, TurnOutcome } from './contracts/host-composition.js';
import type { ExecutionDeadline } from './execution-deadline.js';
import type { OperationTracker } from './execution-runner.js';

/** Host-only ownership of an already provisioned resource. close must use its own finite
 * cleanup budget, never the inference signal. It cannot grant model or tool authority. */
export interface ExecutionResource {
  close(): Promise<RuntimeCloseResult>;
}
export interface ManagedExecution {
  readonly runner: BoundTurnRunner;
  close(): Promise<RuntimeCloseResult>;
}

function endsExecution(outcome: TurnOutcome): boolean {
  switch (outcome.kind) {
    case 'partial': case 'advanced': return outcome.nextView.kind === 'finished';
    case 'settled': return outcome.view.kind === 'finished';
    case 'rejected': return outcome.correctionView.kind === 'finished';
    case 'no_work_required': return outcome.view.kind === 'finished';
    case 'stopped': case 'unconfirmed': case 'stale_owner': case 'cancelled': case 'refused': return true;
  }
}

/** One live execution owns one resource across deliveries. The callback binds the existing
 * canonical runner to a revocable lifetime; it must not provision a replacement workspace.
 * No serialized identity can rebuild this scope. The host tracks cleanup even between turns.
 * An answer receipt and resource cleanup are separate facts: cleanup never rewrites a receipt. */
export function manageExecutionResource(
  bindRunner: (lifetime: AbortSignal) => BoundTurnRunner,
  resource: ExecutionResource,
  deadline: ExecutionDeadline,
  lifetime: AbortSignal,
  track: OperationTracker,
): ManagedExecution {
  const revocation = new AbortController();
  const inference = AbortSignal.any([lifetime, deadline.signal, revocation.signal]);
  const bound = bindRunner(inference);
  type State = Readonly<{ kind: 'active' }>
    | Readonly<{ kind: 'stopping'; result: Promise<RuntimeCloseResult> }>
    | Readonly<{ kind: 'finished'; result: RuntimeCloseResult }>;
  let state: State = { kind: 'active' };
  let running = false;

  const stop = (): Promise<RuntimeCloseResult> => {
    if (state.kind === 'stopping') return state.result;
    if (state.kind === 'finished') return Promise.resolve(state.result);
    // Publish stopping before abort dispatch or external I/O can reenter this scope.
    const result = Promise.resolve().then(async (): Promise<RuntimeCloseResult> => {
      try { return await resource.close(); }
      catch { return { kind: 'incomplete', reason: 'cleanup_failed', detail: 'Resource cleanup outcome unknown' }; }
    }).then(result => { state = { kind: 'finished', result }; return result; });
    state = { kind: 'stopping', result };
    inference.removeEventListener('abort', stopped);
    revocation.abort();
    deadline.close();
    return track(result);
  };
  const stopped = () => { void stop(); };
  inference.addEventListener('abort', stopped, { once: true });
  if (inference.aborted) stopped();

  return {
    runner: { execution: bound.execution, async runTurn(signal) {
      if (state.kind !== 'active') return { kind: 'cancelled' };
      // A competing caller has no authority to tear down the active caller's execution.
      if (running) return { kind: 'refused', reason: 'dispatch_refused', detail: 'Runner already active' };
      running = true;
      signal.addEventListener('abort', stopped, { once: true });
      try {
        if (signal.aborted || inference.aborted || deadline.check().kind !== 'active') {
          await stop();
          return { kind: 'cancelled' };
        }
        const outcome = await bound.runTurn(AbortSignal.any([signal, inference]));
        if (endsExecution(outcome) || inference.aborted) await stop();
        return outcome;
      } catch {
        await stop();
        return { kind: 'refused', reason: 'storage_unavailable', detail: 'Execution boundary failed' };
      } finally {
        signal.removeEventListener('abort', stopped);
        running = false;
      }
    } },
    async close() {
      const result = await stop();
      return result.kind === 'closed' && running
        ? { kind: 'incomplete', reason: 'work_in_flight', detail: 'Resource closed; execution call is still settling' }
        : result;
    },
  };
}
