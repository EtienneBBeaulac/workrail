import { describe, expect, it } from 'vitest';
import { ModelRoutingSchema, resolveModelRequest, resolveModelSelection, readRunModelConfig } from '../../../src/v2/durable-core/domain/model-selection.js';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/events.js';

describe('model selection boundary', () => {
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
