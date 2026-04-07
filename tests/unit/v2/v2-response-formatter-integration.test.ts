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
import { createV2ExecutionRenderEnvelope } from '../../../src/mcp/render-envelope.js';

const EXECUTION_RESPONSE = {
  continueToken: 'ct_test123',
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
    params: { intent: 'advance' as const, continueToken: 'ct_test123' },
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
    expect(parsed).toHaveProperty('continueToken');
    expect(parsed).toHaveProperty('pending');
  });
});

describe('toMcpResult — clean response supplements', () => {
  // WORKRAIL_CLEAN_RESPONSE_FORMAT is evaluated at module load time (module-level
  // const). Tests that require clean-format behavior must set the env var before
  // the module is imported, using vi.resetModules() + dynamic import — the same
  // pattern used for WORKRAIL_JSON_RESPONSES above.

  it('start responses include authority context and notes guidance as separate content items', async () => {
    process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT = 'true';
    vi.resetModules();
    try {
      const { toMcpResult: freshToMcpResult } = await import('../../../src/mcp/handler-factory.js');
      const { createV2ExecutionRenderEnvelope: freshEnvelope } = await import('../../../src/mcp/render-envelope.js');
      const result = freshToMcpResult({
        type: 'success',
        data: freshEnvelope({
          response: EXECUTION_RESPONSE,
          lifecycle: 'start',
        }),
      });

      expect(result.content).toHaveLength(3);
      expect((result.content[0] as { text: string }).text).toContain('Execute the first task.');
      expect((result.content[1] as { text: string }).text).toContain('WorkRail is a separate live system');
      expect((result.content[2] as { text: string }).text).toContain('How to write good notes');
    } finally {
      delete process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT;
      vi.resetModules();
    }
  });

  it('rehydrate responses include authority context but not notes guidance', async () => {
    process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT = 'true';
    vi.resetModules();
    try {
      const { toMcpResult: freshToMcpResult } = await import('../../../src/mcp/handler-factory.js');
      const { createV2ExecutionRenderEnvelope: freshEnvelope } = await import('../../../src/mcp/render-envelope.js');
      const result = freshToMcpResult({
        type: 'success',
        data: freshEnvelope({
          response: {
            ...EXECUTION_RESPONSE,
            nextIntent: 'rehydrate_only' as const,
          },
          lifecycle: 'rehydrate',
        }),
      });

      expect(result.content).toHaveLength(2);
      expect((result.content[1] as { text: string }).text).toContain('WorkRail is a separate live system');
      expect((result.content[1] as { text: string }).text).not.toContain('How to write good notes');
    } finally {
      delete process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT;
      vi.resetModules();
    }
  });

  it('advance responses do not include supplemental content items', async () => {
    process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT = 'true';
    vi.resetModules();
    try {
      const { toMcpResult: freshToMcpResult } = await import('../../../src/mcp/handler-factory.js');
      const { createV2ExecutionRenderEnvelope: freshEnvelope } = await import('../../../src/mcp/render-envelope.js');
      const result = freshToMcpResult({
        type: 'success',
        data: freshEnvelope({
          response: EXECUTION_RESPONSE,
          lifecycle: 'advance',
        }),
      });

      expect(result.content).toHaveLength(1);
      expect((result.content[0] as { text: string }).text).not.toContain('# Step 1: Do Something');
    } finally {
      delete process.env.WORKRAIL_CLEAN_RESPONSE_FORMAT;
      vi.resetModules();
    }
  });
});
