import { describe, expect, it, afterEach, vi } from 'vitest';
import { buildExecutionResponse, validateExecutionResponse } from '../../../src/mcp/execution-response.js';
import { createV2ExecutionRenderEnvelope } from '../../../src/mcp/render-envelope.js';
import { buildStepContentEnvelope, type ResolvedReference } from '../../../src/mcp/step-content-envelope.js';
import { buildBlockerReport } from '../../../src/v2/durable-core/domain/reason-model.js';
import { V2StartWorkflowOutputSchema, V2ContinueWorkflowOutputSchema, type V2StartWorkflowOutput, type V2ContinueWorkflowOutput } from '../../../src/mcp/output-schemas.js';

const continueToken = `ct_${'a'.repeat(24)}`;
const retryContinueToken = `ct_${'b'.repeat(24)}`;
const checkpointToken = `ck_${'c'.repeat(24)}`;
const start: V2StartWorkflowOutput = {
  continueToken, checkpointToken, isComplete: false,
  pending: { stepId: 'first', title: 'First', prompt: 'Authoritative public prompt.', modelTier: 'heavy' },
  preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
  nextIntent: 'perform_pending_then_continue',
  nextCall: { tool: 'continue_workflow', params: { continueToken } },
  warnings: ['Workflow source unavailable.'], staleRoots: ['/missing'],
};
const references: readonly ResolvedReference[] = [
  { id: 'resolved', title: 'Resolved', source: './spec', purpose: 'Contract', authoritative: true,
    resolveFrom: 'workspace', status: 'resolved', resolvedPath: '/workspace/spec' },
  { id: 'missing', title: 'Missing', source: './missing', purpose: 'Optional', authoritative: false,
    resolveFrom: 'workspace', status: 'unresolved' },
  { id: 'pinned', title: 'Pinned', source: './guide', purpose: 'Guidance', authoritative: true,
    resolveFrom: 'package', status: 'pinned' },
];
const contentEnvelope = buildStepContentEnvelope({
  meta: { stepId: 'first', title: 'First', prompt: 'Parallel rendering metadata must not replace public pending.', requireConfirmation: false },
  references,
});
const drift = { code: 'BINDING_DRIFT' as const, slotId: 'checks', pinnedValue: 'old', currentValue: 'new' };
const blocked: V2ContinueWorkflowOutput = {
  kind: 'blocked', continueToken, checkpointToken, isComplete: false, pending: start.pending,
  preferences: start.preferences, nextIntent: 'await_user_confirmation',
  nextCall: { tool: 'continue_workflow', params: { continueToken: retryContinueToken } },
  retryable: true, retryContinueToken,
  blockers: { blockers: [{ code: 'MISSING_REQUIRED_OUTPUT', pointer: { kind: 'output_contract', contractRef: 'result' },
    message: 'Provide a result.', suggestedFix: 'Include accepted.' }] },
  validation: { issues: ['Missing result.'], suggestions: ['Include accepted.'] },
  assessmentFollowup: { title: 'Review risk', guidance: 'Check the identified risk.' }, warnings: [drift],
};
const complete: V2ContinueWorkflowOutput = {
  kind: 'ok', isComplete: true, pending: null, preferences: start.preferences,
  nextIntent: 'complete', nextCall: null,
  stepContext: { assessments: [{ assessmentId: 'risk', dimensions: [{ dimensionId: 'impact', level: 'low' }], normalizationNotes: [] }] },
};

afterEach(() => vi.unstubAllEnvs());

describe('canonical execution response', () => {
  it('preserves public state, warnings, model policy and all reference variants', () => {
    const result = buildExecutionResponse(createV2ExecutionRenderEnvelope({ response: start, lifecycle: 'start', contentEnvelope }), true);
    expect(result).toMatchObject(start);
    expect(result.references).toEqual(references);
    expect(result.supplements?.map(item => item.kind)).toEqual(['executor_directive', 'authority_context', 'notes_guidance', 'subagent_guidance']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(start).not.toHaveProperty('references');
    expect(V2StartWorkflowOutputSchema.safeParse(result).success).toBe(true);
  });

  it('applies lifecycle delivery policy without altering blocked retry authority', () => {
    const result = buildExecutionResponse(createV2ExecutionRenderEnvelope({ response: blocked, lifecycle: 'rehydrate', contentEnvelope }), true);
    expect(result).toMatchObject(blocked);
    expect(result.references).toEqual(references);
    expect(result.supplements?.map(item => item.kind)).toEqual(['executor_directive', 'authority_context', 'subagent_guidance']);
    expect(V2ContinueWorkflowOutputSchema.parse(result)).toEqual(result);
    const advance = buildExecutionResponse(createV2ExecutionRenderEnvelope({ response: complete, lifecycle: 'advance', contentEnvelope }), true);
    expect(advance).toEqual(complete);
  });

  it.each([false, true])('uses the complete payload for structured and JSON delivery (JSON override: %s)', async json => {
    vi.stubEnv('WORKRAIL_JSON_RESPONSES', String(json));
    vi.resetModules();
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const gate: V2ContinueWorkflowOutput = { kind: 'gate_checkpoint', gateToken: continueToken, stepId: 'approval', gateKind: 'human_approval' };
    const terminal: V2ContinueWorkflowOutput = { ...blocked, retryable: false, retryContinueToken: undefined, nextCall: null };
    for (const response of [start, blocked, terminal, complete, gate]) {
      const envelope = createV2ExecutionRenderEnvelope({ response, lifecycle: 'advance' });
      const result = toMcpResult({ type: 'success', data: envelope });
      expect(result.structuredContent).toEqual(response);
      if (json || response === gate) expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    }
  });

  it('keeps guidance and references identical in JSON and structured content', async () => {
    vi.stubEnv('WORKRAIL_JSON_RESPONSES', 'true');
    vi.resetModules();
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const result = toMcpResult({ type: 'success', data: createV2ExecutionRenderEnvelope({ response: start, lifecycle: 'start', contentEnvelope }) },
      { featureFlags: { isEnabled: () => true } } as any);
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
    expect(result.structuredContent?.supplements).toHaveLength(4);
  });

  it('accepts domain-produced blocker ordering for punctuation-bearing keys', () => {
    const report = buildBlockerReport([
      { kind: 'missing_context_key', key: 'a-b' },
      { kind: 'missing_context_key', key: 'a_b' },
    ]);
    expect(report.isOk()).toBe(true);
    if (report.isErr()) return;
    const response = { ...blocked, blockers: report.value };
    expect(validateExecutionResponse(response).isOk()).toBe(true);
    expect(validateExecutionResponse({ ...response, blockers: { blockers: [...report.value.blockers].reverse() } }).isErr()).toBe(true);
  });

  it('does not attach execution structured content to unrelated tools or errors', async () => {
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    expect(toMcpResult({ type: 'success', data: { pending: { stepId: 'unrelated' } } }).structuredContent).toBeUndefined();
    const error = toMcpResult({ type: 'error', code: 'VALIDATION_ERROR', message: 'Invalid input', retry: { kind: 'not_retryable' } });
    expect(error.isError).toBe(true);
    expect(error.structuredContent).toBeUndefined();
  });

  it('rejects an apparently complete pending response without continuation authority', async () => {
    const { toMcpResult } = await import('../../../src/mcp/handler-factory.js');
    const { continueToken: _token, checkpointToken: _checkpoint, ...rest } = start;
    const result = toMcpResult({ type: 'success', data: createV2ExecutionRenderEnvelope({
      response: { ...rest, nextCall: null }, lifecycle: 'start',
    }) });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).code).toBe('INTERNAL_ERROR');
  });
});
