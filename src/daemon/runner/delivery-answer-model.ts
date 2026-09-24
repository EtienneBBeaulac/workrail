import type { TrustedDeliveryModelFactory } from '../../answer-v1/contracts/trusted-model-factory.js';
import type { SessionJournal } from '../../answer-v1/journal.js';
import type { DeliveryRef, OwnerFence } from '../../answer-v1/contracts/invocation-contract.js';
import type { ModelInferenceBoundary } from '../../answer-v1/contracts/host-composition.js';
import type { DaemonExecutionPolicy } from '../../answer-v1/daemon-policy.js';
import { owns } from '../../answer-v1/host-state.js';
import { bindBudgetedProvider } from '../../answer-v1/model-call-budget.js';
import type { AgentTool } from '../agent-loop.js';
import type { ClientOptions } from '@anthropic-ai/sdk/client';
import { createAnswerTransport, type AnswerTransportCredentials } from './answer-transport.js';
import { createDaemonAnswerModel } from './answer-model.js';

type PolicyRead =
  | Readonly<{ kind: 'retained'; policy: DaemonExecutionPolicy }>
  | Readonly<{ kind: 'refused'; reason: 'storage_unavailable' | 'stale_owner' | 'missing_policy' }>;
export type CreateDeliveryAnswerModelResult =
  | Readonly<{ kind: 'created'; model: ModelInferenceBoundary }>
  | Exclude<PolicyRead, { kind: 'retained' }>
  | Readonly<{ kind: 'refused'; reason: 'unsupported_stall_timeout' }>
  | Extract<ReturnType<typeof createAnswerTransport>, { kind: 'refused' }>
  | Extract<ReturnType<typeof createDaemonAnswerModel>, { kind: 'refused' }>;

/** Trusted composition only: the returned model receives neither journal nor owner.
 * Each provider attempt is reserved against this delivery before network work. Retain
 * this model for its delivery: constructing another one does not reconcile uncertainty.
 * This does not enable policy execution, validate workspace effects or grant recovery. */
export async function createDeliveryAnswerModel(
  journal: SessionJournal, delivery: DeliveryRef, owner: OwnerFence,
  credentials: AnswerTransportCredentials, workspaceTools: readonly AgentTool[],
  fetch: NonNullable<ClientOptions['fetch']>, signal: AbortSignal,
): Promise<CreateDeliveryAnswerModelResult> {
  const retained = await journal.locked<PolicyRead>(signal, { kind: 'refused', reason: 'storage_unavailable' }, async state => {
    if (!owns(state, owner)) return { kind: 'refused', reason: 'stale_owner' };
    const enrollment = state.records.find(record => record.kind === 'enrolled');
    const policy = enrollment?.kind === 'enrolled' ? enrollment.request?.daemonPolicy : undefined;
    return policy ? { kind: 'retained', policy } : { kind: 'refused', reason: 'missing_policy' };
  });
  if (retained.kind !== 'retained') return retained;
  if (retained.policy.limits.stallTimeoutMs > 2147483647) return { kind: 'refused', reason: 'unsupported_stall_timeout' };
  const transport = createAnswerTransport(retained.policy, credentials, fetch);
  if (transport.kind !== 'created') return transport;
  const provider = bindBudgetedProvider(journal, delivery, owner, transport.send);
  return createDaemonAnswerModel({ provider, workspaceTools,
    modelId: retained.policy.model.modelId, systemPrompt: retained.policy.systemPrompt,
    maxTokens: retained.policy.limits.maxOutputTokens,
    stallTimeoutMs: retained.policy.limits.stallTimeoutMs,
    llmCallTimeoutMs: retained.policy.limits.callTimeoutMs,
  });
}


/** Explicit host injection. Installing this factory does not admit policy executions. */
export function createDaemonDeliveryModelFactory(
  credentials: AnswerTransportCredentials, workspaceTools: readonly AgentTool[],
  fetch: NonNullable<ClientOptions['fetch']>,
): TrustedDeliveryModelFactory {
  return { create: (context, signal) => createDeliveryAnswerModel(context.journal,
    context.delivery, context.owner, credentials, workspaceTools, fetch, signal) };
}
