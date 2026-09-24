import { createAnswerWorkflowReader } from '../../answer-v1/workflow-reader.js';
import { isAbsolute } from 'node:path';
import type { ClientOptions } from '@anthropic-ai/sdk/client';
import type { SharedAuthorityConfig, HostWorkRequest, RuntimeCloseResult, ReleaseOwnershipResult, DurableJournalFaultSeam } from '../../answer-v1/contracts/host-composition.js';
import type { DeadlineClock } from '../../answer-v1/execution-deadline.js';
import { SessionJournal } from '../../answer-v1/journal.js';
import { completedAnswerOutput } from '../../answer-v1/completed-output.js';
import { owns, readHostState, inspectionView } from '../../answer-v1/host-state.js';
import { composeAnswerEngine } from '../../answer-v1/engine-composition.js';
import { prepareAdmissionDirectory } from '../../answer-v1/admission-directory.js';
import { admissionFileName } from '../../answer-v1/immutable-admission-file.js';
import { buildHostAdmissionCandidate, createFreshAdmissionAuthority, recoverHostAdmission } from '../../answer-v1/host-admission.js';
import { classifyAnswerWorkflow } from '../../answer-v1/workflow-support.js';
import { hasWorkflowDefinitionShape } from '../../types/workflow-definition.js';
import type { Workflow } from '../../types/workflow.js';
import { prepareStartWorkflow } from '../../v2/usecases/start-workflow.js';
import { AnswerHostRequestSchema } from '../../v2/durable-core/schemas/session/answer-host.js';
import { prepareLinuxScratchExecution } from './linux-scratch/execution.js';
import type { DockerCli } from './linux-scratch/docker-cli.js';
import type { AnswerTransportCredentials } from './answer-transport.js';

/** Privileged transport correlation, retained by the caller across uncertain replies.
 * It is separate from the agent request and never regenerated as a recovery attempt. */
export type SupervisedOperation = Readonly<{ operationId: string; request: HostWorkRequest }>;

/** Linux supervision owns provisioning, inference and cleanup together. No prompt-only
 * model alternative exists here, so unsupported policies cannot fall through to it. */
export async function createSupervisedAnswerHost(config: SharedAuthorityConfig & Readonly<{
  faultSeam?: DurableJournalFaultSeam;
  clock: DeadlineClock;
  docker: Pick<DockerCli, 'run' | 'stream'>;
  artifactDirectory: string;
  credentials: AnswerTransportCredentials;
  fetch: NonNullable<ClientOptions['fetch']>;
}>, lifetime: AbortSignal) {
  if (![config.storage.journalRootDir, config.storage.hostIndexRootDir, config.keyringPath,
    config.workflowStoragePath, config.artifactDirectory].every(isAbsolute)) {
    return { kind: 'refused', reason: 'invalid_configuration' } as const;
  }
  if (lifetime.aborted) return { kind: 'refused', reason: 'cancelled' } as const;
  const composition = await composeAnswerEngine(config);
  if (composition.kind !== 'ready') return composition;
  const directory = await prepareAdmissionDirectory(config.storage.journalRootDir, lifetime);
  if (directory.kind !== 'ready') return directory;
  const engine = composition;
  const shutdown = new AbortController();
  const parent = AbortSignal.any([lifetime, shutdown.signal]);
  const admission = createFreshAdmissionAuthority(engine, config.clock, parent);
  const active = new Set<Promise<unknown>>();
  const reconciliationRequired = new Set<string>();
  const resources = new Set<Extract<Awaited<ReturnType<typeof prepareLinuxScratchExecution>>, { kind: 'ready' }>['execution']>();
  const track = async <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation);
    try { return await operation; } finally { active.delete(operation); }
  };
  const requestSchema = AnswerHostRequestSchema.refine(request => isAbsolute(request.workspacePath));
  function validate(operation: SupervisedOperation) {
    const request = requestSchema.safeParse(operation.request);
    if (!admissionFileName(operation.operationId) || !request.success) return { kind: 'invalid' } as const;
    return { kind: 'valid', operationId: operation.operationId, request: request.data } as const;
  }
  return {
    kind: 'created' as const,
    scheduler: {
      /** Existing immutable reservations are reconciliation only, never fresh provisioning. */
      enroll(operation: SupervisedOperation, signal: AbortSignal) {
        return track((async () => {
          const checked = validate(operation);
          if (checked.kind !== 'valid') return { kind: 'refused', reason: 'invalid_request' } as const;
          const expected = { operationId: checked.operationId, request: checked.request };
          if (parent.aborted || signal.aborted) return { kind: 'refused', reason: 'cancelled', operation: expected } as const;
          if (checked.request.daemonPolicy?.workspace.kind !== 'linux_scratch')
            return { kind: 'refused', reason: 'unsupported_execution_policy', operation: expected } as const;
          const combined = AbortSignal.any([parent, signal]);
          let workflow: Workflow | null;
          try { workflow = await createAnswerWorkflowReader(config.workflowStoragePath).getWorkflowById(checked.request.workflowId); }
          catch { return { kind: 'refused', reason: 'unsupported_workflow', operation: expected } as const; }
          try {
            const raw = workflow?.definition;
            if (!workflow || !hasWorkflowDefinitionShape(raw) || raw.id !== checked.request.workflowId || classifyAnswerWorkflow(raw) === 'unsupported')
              return { kind: 'refused', reason: 'unsupported_workflow', operation: expected } as const;
            const prepared = await prepareStartWorkflow({ ...engine, fallbackWorkflowReader: {
              getWorkflowById: async id => id === workflow.definition.id ? workflow : null,
            } }, { ...checked.request, injectOnboarding: false }, { triggerSource: 'daemon' });
            if (prepared.isErr()) return { kind: 'refused', reason: 'initialization_failed', operation: expected } as const;
            const reading = config.clock.read();
            if (reading.kind !== 'reading') return { kind: 'refused', reason: 'clock_continuity_unavailable', operation: expected } as const;
            const candidate = buildHostAdmissionCandidate(prepared.value, checked.request, checked.operationId, engine, () => reading.wallMs);
            if (candidate.kind !== 'candidate') return { kind: 'refused', reason: 'invalid_candidate', operation: expected } as const;
            const admitted = await admission.admit(directory.root, expected, candidate.bytes, combined);
            if (admitted.kind === 'unconfirmed') reconciliationRequired.add(expected.operationId);
            if (admitted.kind !== 'fresh') return { kind: 'admission_result', operation: expected, result: admitted } as const;
            const preparedExecution = await prepareLinuxScratchExecution({ engine, config, admission, handoff: admitted.handoff,
              docker: config.docker, artifactDirectory: config.artifactDirectory, credentials: config.credentials,
              fetch: config.fetch, lifetime: parent, track }, combined);
            if (preparedExecution.kind === 'ready') {
              const execution = preparedExecution.execution;
              resources.add(execution);
              const journal = new SessionJournal(engine, preparedExecution.enrollment, config, s => !s.aborted);
              const verifyOwner = (s: AbortSignal) => journal.locked<ReleaseOwnershipResult | Readonly<{ kind: 'current' }>>(s,
                { kind: 'refused', reason: 'storage_unavailable' },
                async state => owns(state, preparedExecution.owner) ? { kind: 'current' } : { kind: 'stale_owner' });
              return { kind: 'preparation_result', operation: expected, result: { ...preparedExecution,
                execution: { ...execution,
                  async output(outputSignal: AbortSignal): Promise<ReturnType<typeof completedAnswerOutput>> {
                    if (outputSignal.aborted) return { kind: 'unavailable' };
                    const loaded = await readHostState(engine, preparedExecution.enrollment);
                    if (loaded.kind !== 'loaded' || outputSignal.aborted) return { kind: 'unavailable' };
                    const view = await inspectionView(engine, loaded.state);
                    return view.kind === 'finished' && view.execution.kind === 'completed'
                      ? completedAnswerOutput(loaded.state.records) : { kind: 'unavailable' };
                  },
                  async release(releaseSignal: AbortSignal): Promise<ReleaseOwnershipResult | RuntimeCloseResult> {
                  const ownership = await verifyOwner(releaseSignal);
                  if (ownership.kind !== 'current') return ownership;
                  const closed = await execution.close();
                  if (closed.lifecycle.kind !== 'closed') return closed.lifecycle;
                  return journal.locked<ReleaseOwnershipResult>(releaseSignal, { kind: 'refused', reason: 'storage_unavailable' }, async (state, lock) => {
                    if (!owns(state, preparedExecution.owner)) return { kind: 'stale_owner' };
                    return await journal.append(state, lock, { kind: 'owner_released', epoch: preparedExecution.owner.epoch.toString() }, releaseSignal)
                      ? { kind: 'released' } : { kind: 'unconfirmed', reason: 'commit_uncertain' };
                  });
                } },
              } } as const;
            }
            reconciliationRequired.add(expected.operationId);
            return { kind: 'preparation_result', operation: expected, result: preparedExecution } as const;
          } catch {
            // Publication or allocation may have happened. Preserve correlation and
            // prohibit implicit retry; discovery can inspect the retained reservation.
            reconciliationRequired.add(expected.operationId);
            return { kind: 'unconfirmed', reason: 'storage_unavailable', operation: expected } as const;
          }
        })());
      },
      reconcileAdmission(operation: SupervisedOperation, signal: AbortSignal) {
        return track((async () => {
          const checked = validate(operation);
          if (checked.kind !== 'valid') return { kind: 'refused', reason: 'invalid_request' } as const;
          return recoverHostAdmission(engine, directory.root, checked, AbortSignal.any([signal, parent]));
        })());
      },
      async close(signal: AbortSignal): Promise<RuntimeCloseResult> {
        shutdown.abort();
        admission.close();
        // Preparation remains tracked until its resource is adopted or its uncertainty
        // returned. Do not claim closed merely because no handle exists yet.
        if (signal.aborted) return { kind: 'incomplete', reason: 'cancelled', detail: 'Close caller cancelled' };
        const outcomes = await Promise.all([...resources].map(resource => track(resource.close())));
        const incomplete = outcomes.find(outcome => outcome.lifecycle.kind !== 'closed');
        if (incomplete) return incomplete.lifecycle;
        if (reconciliationRequired.size) return { kind: 'incomplete', reason: 'cleanup_failed', detail: 'Admission or preparation requires reconciliation' };
        return active.size ? { kind: 'incomplete', reason: 'work_in_flight', detail: 'Preparation or execution is settling' }
          : { kind: 'closed' };
      },
    },
  };
}
