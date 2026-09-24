import type { AnswerReadEngine } from './engine-composition.js';
import type { HostState } from './host-state.js';
import { derivePendingStep } from '../v2/durable-core/projections/snapshot-state.js';
import { hasWorkflowDefinitionShape, isStandardStepDefinition } from '../types/workflow-definition.js';

/** The pinned current step owns decoding; submitted fields cannot switch contracts. */
export async function outputObligation(engine: AnswerReadEngine, state: HostState): Promise<'notes' | 'review' | 'unavailable'> {
  const event = state.truth.events.find(e => e.kind === 'node_created' && e.scope.nodeId === state.node && e.scope.runId === state.run.scope.runId);
  if (event?.kind !== 'node_created') return 'unavailable';
  const snapshot = await engine.snapshotStore.getExecutionSnapshotV1(event.data.snapshotRef);
  const pinned = await engine.pinnedStore.get(state.run.data.workflowHash);
  if (snapshot.isErr() || !snapshot.value || pinned.isErr() || pinned.value?.sourceKind !== 'v1_pinned'
    || !hasWorkflowDefinitionShape(pinned.value.definition)) return 'unavailable';
  const pending = derivePendingStep(snapshot.value.enginePayload.engineState);
  const step = pending && pinned.value.definition.steps.find(s => s.id === pending.stepId);
  if (!step || !isStandardStepDefinition(step)) return 'unavailable';
  return !step.outputContract ? 'notes'
    : step.outputContract.contractRef === 'wr.contracts.review_verdict' ? 'review' : 'unavailable';
}
