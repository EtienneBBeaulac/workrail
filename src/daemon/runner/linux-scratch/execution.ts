import type { ClientOptions } from '@anthropic-ai/sdk/client';
import type { AnswerEngine } from '../../../answer-v1/engine-composition.js';
import type { SharedAuthorityConfig, DurableJournalFaultSeam, RuntimeCloseResult } from '../../../answer-v1/contracts/host-composition.js';
import type { HostEnrollment, OwnerFence } from '../../../answer-v1/contracts/invocation-contract.js';
import type { ExecutionDeadline, DeadlineStopReason } from '../../../answer-v1/execution-deadline.js';
import { createExecutionRunner, type OperationTracker } from '../../../answer-v1/execution-runner.js';
import { manageExecutionResource } from '../../../answer-v1/execution-resource.js';
import { createLinuxScratchDeliveryModelFactory } from '../delivery-answer-model.js';
import type { AnswerTransportCredentials } from '../answer-transport.js';
import { createLinuxScratchWorkspace, type LinuxScratchWorkspace, type ScratchFinish, type CreateScratchResult } from './workspace.js';
import type { DockerCli } from './docker-cli.js';
import type { ClaimFreshAdmissionResult, FreshAdmission, createFreshAdmissionAuthority } from '../../../answer-v1/host-admission.js';
import { SessionJournal } from '../../../answer-v1/journal.js';

/** Trusted adoption of one already provisioned workspace and its original deadline.
 * This is not admission: a durable pointer does not grant the live workspace capability.
 * The caller retains ownership through close and must reconcile unknown bootstrap separately.
 * Public daemon routing remains unavailable until that preparation path is integrated. */
export function bindLinuxScratchExecution(options: Readonly<{
  engine: AnswerEngine;
  config: SharedAuthorityConfig & Readonly<{ faultSeam?: DurableJournalFaultSeam }>;
  enrollment: HostEnrollment;
  owner: OwnerFence;
  deadline: ExecutionDeadline;
  workspace: LinuxScratchWorkspace;
  credentials: AnswerTransportCredentials;
  fetch: NonNullable<ClientOptions['fetch']>;
  lifetime: AbortSignal;
  track: OperationTracker;
}>) {
  let observation: ScratchFinish = { inspection: { kind: 'unavailable' }, cleanup: 'unconfirmed' };
  const factory = createLinuxScratchDeliveryModelFactory(options.credentials, options.workspace, options.fetch);
  const managed = manageExecutionResource(
    lifetime => createExecutionRunner(options.engine, { ...options.config, modelFactory: factory },
      options.enrollment, options.owner, lifetime, options.track, { kind: 'deadline', deadline: options.deadline }),
    { async close(): Promise<RuntimeCloseResult> {
      // The backend owns the finite cleanup deadline. Inference/host cancellation must
      // revoke work without also revoking the ability to retain and perform its stop.
      observation = await options.workspace.finish(new AbortController().signal);
      return observation.cleanup === 'removed' ? { kind: 'closed' }
        : { kind: 'incomplete', reason: 'cleanup_failed', detail: 'Workspace cleanup unconfirmed' };
    } }, options.deadline, options.lifetime, options.track);
  return {
    runner: managed.runner,
    async close(): Promise<Readonly<{ lifecycle: RuntimeCloseResult; workspace: ScratchFinish }>> {
      const lifecycle = await managed.close();
      return { lifecycle, workspace: observation };
    },
  };
}

export type PrepareLinuxScratchExecutionResult =
  | Readonly<{ kind: 'ready'; enrollment: HostEnrollment; owner: OwnerFence; execution: ReturnType<typeof bindLinuxScratchExecution> }>
  | Readonly<{ kind: 'admission_failed'; result: Exclude<ClaimFreshAdmissionResult, { kind: 'owned' }> }>
  | Readonly<{ kind: 'not_prepared'; enrollment: HostEnrollment; owner: OwnerFence; outcome:
      Exclude<CreateScratchResult, { kind: 'ready' }>
      | Readonly<{ kind: 'unsupported_profile' }>
      | Readonly<{ kind: 'deadline_stopped'; reason: DeadlineStopReason; cleanup: ScratchFinish }>
      | Readonly<{ kind: 'binding_failed'; cleanup: ScratchFinish }>
      | Readonly<{ kind: 'boundary_unknown'; cleanup: 'unconfirmed' }> }>;

/** Consume a fresh process-local admission handoff once. Provision only its retained
 * manifest, never a caller replacement or an implicit checkout crawl. Unknown bootstrap
 * stays owned and visible for reconciliation; it cannot become a runnable replacement. */
export function prepareLinuxScratchExecution(options: Readonly<{
  engine: AnswerEngine;
  config: SharedAuthorityConfig & Readonly<{ faultSeam?: DurableJournalFaultSeam }>;
  admission: Pick<ReturnType<typeof createFreshAdmissionAuthority>, 'claim'>;
  handoff: FreshAdmission;
  docker: Pick<DockerCli, 'run' | 'stream'>;
  artifactDirectory: string;
  credentials: AnswerTransportCredentials;
  fetch: NonNullable<ClientOptions['fetch']>;
  lifetime: AbortSignal;
  track: OperationTracker;
}>, signal: AbortSignal): Promise<PrepareLinuxScratchExecutionResult> {
  return options.track((async (): Promise<PrepareLinuxScratchExecutionResult> => {
    const claimed = await options.admission.claim(options.handoff, AbortSignal.any([signal, options.lifetime]));
    if (claimed.kind !== 'owned') return { kind: 'admission_failed', result: claimed };
    const identity = { enrollment: claimed.enrollment, owner: claimed.owner };
    const cancelPreparation = () => claimed.deadline.close();
    signal.addEventListener('abort', cancelPreparation, { once: true });
    options.lifetime.addEventListener('abort', cancelPreparation, { once: true });
    let adopted = false;
    let workspace: LinuxScratchWorkspace | undefined;
    try {
      if (signal.aborted || options.lifetime.aborted) cancelPreparation();
      const profile = claimed.reservation.request.daemonPolicy?.workspace;
      if (profile?.kind !== 'linux_scratch') return { kind: 'not_prepared', ...identity, outcome: { kind: 'unsupported_profile' } };
      const journal = new SessionJournal(options.engine, claimed.enrollment,
        { ...options.config, model: { async generate() { return { kind: 'cancelled' }; } } },
        s => !s.aborted && !options.lifetime.aborted && claimed.deadline.check().kind === 'active');
      const created = await createLinuxScratchWorkspace({ journal, owner: claimed.owner, deadline: claimed.deadline,
        profile, docker: options.docker, artifactDirectory: options.artifactDirectory });
      if (created.kind !== 'ready') return { kind: 'not_prepared', ...identity, outcome: created };
      workspace = created.workspace;
      const status = claimed.deadline.check();
      if (status.kind === 'stopped') {
        const cleanup = await finishPreparedWorkspace(workspace);
        return { kind: 'not_prepared', ...identity, outcome: { kind: 'deadline_stopped', reason: status.reason, cleanup } };
      }
      const execution = bindLinuxScratchExecution({ ...options, ...identity, deadline: claimed.deadline, workspace });
      adopted = true;
      return { kind: 'ready', ...identity, execution };
    } catch {
      // A throwing bootstrap may have allocated a resource without returning its handle.
      // Never invent a cleanup receipt or retry creation from that uncertainty.
      if (workspace) return { kind: 'not_prepared', ...identity,
        outcome: { kind: 'binding_failed', cleanup: await finishPreparedWorkspace(workspace) } };
      return { kind: 'not_prepared', ...identity, outcome: { kind: 'boundary_unknown', cleanup: 'unconfirmed' } };
    } finally {
      signal.removeEventListener('abort', cancelPreparation);
      options.lifetime.removeEventListener('abort', cancelPreparation);
      if (!adopted) claimed.deadline.close();
    }
  })());
}

/** Normalize a throwing boundary without issuing a second cleanup attempt. */
async function finishPreparedWorkspace(workspace: LinuxScratchWorkspace): Promise<ScratchFinish> {
  try { return await workspace.finish(new AbortController().signal); }
  catch { return { inspection: { kind: 'unavailable' }, cleanup: 'unconfirmed' }; }
}
