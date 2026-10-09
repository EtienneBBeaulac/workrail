import type { ModelRouting, RunModelConfig, ModelSelection, ClientLaunchScope } from '../../../src/v2/durable-core/domain/model-selection.js';
declare const routing: ModelRouting;
declare const config: RunModelConfig;
declare const selection: ModelSelection;
if (routing.lightweight?.kind === 'model') {
  // @ts-expect-error nested bindings cannot mutate durable intent
  routing.lightweight.modelId = 'replacement';
}
// @ts-expect-error routing membership is immutable
routing.heavy = { kind: 'executor', name: 'replacement' };
// @ts-expect-error the run configuration cannot replace its routing map
config.modelRouting = {};
if (selection.kind === 'resolved') {
  // @ts-expect-error nested requests are immutable
  selection.request.tier = 'heavy';
  if (selection.target.kind === 'executor') {
    // @ts-expect-error nested targets are immutable
    selection.target.name = 'replacement';
  }
}

// @ts-expect-error current-agent planning must explicitly admit unknown execution state
const missingObservation: ClientLaunchScope = { kind: 'current_agent', switching: 'unavailable' };
// @ts-expect-error an observed execution must name a constrained model or executor target
const missingTarget: ClientLaunchScope = { kind: 'current_agent', switching: 'unavailable', currentExecution: { kind: 'observed' } };
// @ts-expect-error model and executor identities cannot be combined
const ambiguousTarget: ClientLaunchScope = { kind: 'current_agent', switching: 'unavailable', currentExecution: { kind: 'observed', target: { kind: 'model', modelId: 'fast', name: 'executor' } } };
