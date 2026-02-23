/**
 * V2 Response Formatter Integration Tests
 *
 * Tests the integration of formatV2ExecutionResponse with toMcpResult,
 * including the WORKRAIL_JSON_RESPONSES env flag bypass.
 *
 * @module tests/unit/v2/v2-response-formatter-integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { toMcpResult } from '../../../src/mcp/handler-factory.js';

const EXECUTION_RESPONSE = {
  stateToken: 'st1testtoken',
  ackToken: 'ack1testtoken',
  checkpointToken: 'chk1testtoken',
  isComplete: false,
  pending: {
    stepId: 'step-1',
    title: 'Step 1: Do Something',
    prompt: 'Execute the first task.',
  },
  preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
  nextIntent: 'perform_pending_then_continue',
  nextCall: {
    tool: 'continue_workflow' as const,
    params: { intent: 'advance' as const, stateToken: 'st1testtoken', ackToken: 'ack1testtoken' },
  },
};

const NON_EXECUTION_RESPONSE = {
  workflows: [{ workflowId: 'test', name: 'Test', description: 'Test workflow', version: '1.0.0', kind: 'workflow', workflowHash: null }],
};

describe('toMcpResult — NL formatting integration', () => {
  it('formats v2 execution success as natural language', () => {
    const result = toMcpResult({ type: 'success', data: EXECUTION_RESPONSE });
    const text = result.content[0]!;
    expect(text.type).toBe('text');
    expect((text as { text: string }).text).toContain('# Step 1: Do Something');
    expect((text as { text: string }).text).toContain('Execute the first task.');
    expect((text as { text: string }).text).not.toMatch(/^\{/);
  });

  it('still returns JSON for non-execution tool outputs', () => {
    const result = toMcpResult({ type: 'success', data: NON_EXECUTION_RESPONSE });
    const text = (result.content[0] as { text: string }).text;
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toHaveProperty('workflows');
  });

  it('still returns JSON for error results', () => {
    const result = toMcpResult({
      type: 'error',
      code: 'VALIDATION_ERROR' as const,
      message: 'Invalid input',
      retry: { kind: 'not_retryable' as const },
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text)).toHaveProperty('code', 'VALIDATION_ERROR');
  });
});

describe('toMcpResult — WORKRAIL_JSON_RESPONSES env flag', () => {
  const originalEnv = process.env.WORKRAIL_JSON_RESPONSES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.WORKRAIL_JSON_RESPONSES;
    } else {
      process.env.WORKRAIL_JSON_RESPONSES = originalEnv;
    }
  });

  it('returns JSON when WORKRAIL_JSON_RESPONSES=true (verified via module reload)', async () => {
    process.env.WORKRAIL_JSON_RESPONSES = 'true';

    // The env flag is read at module load time, so we need to re-import.
    // Clear the module cache and re-import.
    vi.resetModules();
    const { toMcpResult: freshToMcpResult } = await import('../../../src/mcp/handler-factory.js');

    const result = freshToMcpResult({ type: 'success', data: EXECUTION_RESPONSE });
    const text = (result.content[0] as { text: string }).text;
    expect(() => JSON.parse(text)).not.toThrow();
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('stateToken');
    expect(parsed).toHaveProperty('pending');
  });
});
