import { describe, expect, it } from 'vitest';
import { ModelRoutingSchema, resolveModelRequest, resolveModelSelection, readRunModelConfig } from '../../../src/v2/durable-core/domain/model-selection.js';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/events.js';
import * as selectionBoundary from '../../../src/v2/durable-core/domain/model-selection.js';

describe('model selection boundary', () => {
  it('plans client launches against available targets and explicit switching capability', () => {
    const plan = Reflect.get(selectionBoundary, 'planClientModelLaunch');
    expect(plan).toBeTypeOf('function');
    const request = resolveModelRequest({}, 'lightweight');
    const selection = resolveModelSelection(request, { lightweight: { kind: 'model', modelId: 'client-fast' } });
    const catalog = { kind: 'model_overrides', modelIds: ['client-fast'] };
    expect(plan(selection, catalog, { kind: 'child' })).toEqual({ kind: 'ready', target: { kind: 'model', modelId: 'client-fast' } });
    expect(plan(selection, { kind: 'model_overrides', modelIds: ['other'] }, { kind: 'child' })).toMatchObject({ kind: 'unsupported', reason: 'target_unavailable' });
    expect(plan(selection, { kind: 'configured_executors', names: ['workrail-fast'] }, { kind: 'child' })).toMatchObject({ kind: 'unsupported', reason: 'model_override_unavailable' });
    expect(plan(selection, catalog, { kind: 'current_agent', switching: 'unavailable' })).toMatchObject({ kind: 'unsupported', reason: 'current_agent_switch_unavailable' });
    const executor = resolveModelSelection(request, { lightweight: { kind: 'executor', name: 'workrail-fast' } });
    expect(plan(executor, { kind: 'configured_executors', names: ['workrail-fast'] }, { kind: 'child' })).toEqual({ kind: 'ready', target: { kind: 'executor', name: 'workrail-fast' } });
    expect(plan(executor, { kind: 'configured_executors', names: [] }, { kind: 'child' })).toMatchObject({ kind: 'unsupported', reason: 'target_unavailable' });
  });
  it('has explicit precedence without provider defaults', () => {
    expect(resolveModelRequest({ modelTier: 'lightweight' }, 'heavy', 'mid')).toEqual({ kind: 'tier', tier: 'lightweight', source: 'session' });
    expect(resolveModelRequest({}, 'heavy', 'mid')).toEqual({ kind: 'tier', tier: 'heavy', source: 'step' });
    expect(resolveModelRequest({}, undefined, 'mid')).toEqual({ kind: 'tier', tier: 'mid', source: 'workflow' });
    expect(resolveModelRequest({})).toEqual({ kind: 'inherit' });
  });

  it('supports native override and configured-executor clients', () => {
    const request = resolveModelRequest({}, 'lightweight');
    expect(resolveModelSelection(request, { lightweight: { kind: 'model', modelId: 'client-fast-model' } })).toEqual({
      kind: 'resolved', request, target: { kind: 'model', modelId: 'client-fast-model' },
    });
    expect(resolveModelSelection(request, { lightweight: { kind: 'executor', name: 'workrail-fast' } })).toEqual({
      kind: 'resolved', request, target: { kind: 'executor', name: 'workrail-fast' },
    });
    expect(resolveModelSelection(request)).toEqual({ kind: 'unresolved', request, reason: 'binding_missing' });
  });

  it('accepts valid client routing maps and an optional empty map at the boundary', () => {
    expect(ModelRoutingSchema.safeParse({}).success).toBe(true);
    expect(ModelRoutingSchema.safeParse({ lightweight: { kind: 'model', modelId: 'client-fast' } }).success).toBe(true);
    expect(ModelRoutingSchema.safeParse({ heavy: { kind: 'executor', name: 'workrail-heavy' } }).success).toBe(true);
  });

  it.each([
    { lightweight: { kind: 'model', modelId: '', name: 'both' } },
    { lightweight: { kind: 'model', modelId: 'a', name: 'both' } },
    { fast: { kind: 'model', modelId: 'a' } },
    { lightweight: { kind: 'executor', name: 'contains spaces' } },
  ])('rejects an invalid route at the boundary: %j', value => {
    expect(ModelRoutingSchema.safeParse(value).success).toBe(false);
  });

  it('recovers run-start configuration and ignores agent context rewrites', () => {
    const config = { modelTier: 'lightweight' as const, modelRouting: { lightweight: { kind: 'model' as const, modelId: 'fast' } } };
    const started = DomainEventV1Schema.parse({ v: 1, timestampMs: 1, eventId: 'evt_1', eventIndex: 0, sessionId: 'sess_1',
      kind: 'run_started', dedupeKey: 'run_started:sess_1:run_1', scope: { runId: 'run_1' },
      data: { workflowId: 'example', workflowHash: `sha256:${'a'.repeat(64)}`, workflowSourceKind: 'bundled', workflowSourceRef: '(bundled)', modelConfig: config } });
    const delta = DomainEventV1Schema.parse({ v: 1, timestampMs: 2, eventId: 'evt_2', eventIndex: 1, sessionId: 'sess_1',
      kind: 'context_set', dedupeKey: 'context_set:sess_1:run_1:ctx_1', scope: { runId: 'run_1' },
      data: { contextId: 'ctx_1', source: 'agent_delta', context: { modelTier: 'heavy', modelRouting: { lightweight: { kind: 'model', modelId: 'wrong' } } } } });
    expect(readRunModelConfig([started, delta], 'run_1')).toEqual(config);
    expect(readRunModelConfig([started, delta], 'run_2')).toEqual({});
    expect(readRunModelConfig([], 'legacy')).toEqual({});
  });
});
