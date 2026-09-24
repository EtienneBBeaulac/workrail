import type { ClientOptions } from '@anthropic-ai/sdk/client';
import type { AnswerEngine } from '../../../answer-v1/engine-composition.js';
import type { SharedAuthorityConfig, DurableJournalFaultSeam, RuntimeCloseResult } from '../../../answer-v1/contracts/host-composition.js';
import type { HostEnrollment, OwnerFence } from '../../../answer-v1/contracts/invocation-contract.js';
import type { ExecutionDeadline } from '../../../answer-v1/execution-deadline.js';
import { createExecutionRunner, type OperationTracker } from '../../../answer-v1/execution-runner.js';
import { manageExecutionResource } from '../../../answer-v1/execution-resource.js';
import { createLinuxScratchDeliveryModelFactory } from '../delivery-answer-model.js';
import type { AnswerTransportCredentials } from '../answer-transport.js';
import type { LinuxScratchWorkspace, ScratchFinish } from './workspace.js';

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
