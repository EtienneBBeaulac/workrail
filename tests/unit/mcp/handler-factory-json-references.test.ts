/**
 * Tests that JSON response mode (WORKRAIL_JSON_RESPONSES=true) includes
 * references in the output payload.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { toMcpResult } from '../../../src/mcp/handler-factory.js';
import { createV2ExecutionRenderEnvelope } from '../../../src/mcp/render-envelope.js';
import { buildStepContentEnvelope, type ResolvedReference } from '../../../src/mcp/step-content-envelope.js';
import type { StepMetadata } from '../../../src/v2/durable-core/domain/prompt-renderer.js';

const SAMPLE_META: StepMetadata = {
  stepId: 'step1',
  title: 'Step 1',
  prompt: 'Do the thing.',
  agentRole: 'dev',
  requireConfirmation: false,
};

const RESOLVED_REF: ResolvedReference = {
  id: 'spec',
  title: 'Spec',
  source: './spec.md',
  purpose: 'Source of truth',
  authoritative: true,
  resolveFrom: 'package',
  status: 'resolved',
  resolvedPath: '/pkg/spec.md',
};

describe('toMcpResult — JSON mode with references', () => {
  beforeEach(() => {
    vi.stubEnv('WORKRAIL_JSON_RESPONSES', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('includes references array in JSON payload when present', () => {
    const contentEnvelope = buildStepContentEnvelope({
      meta: SAMPLE_META,
      references: [RESOLVED_REF],
    });
    const response = {
      continueToken: 'ct_test',
      isComplete: false,
      pending: { stepId: 'step1', title: 'Step 1', prompt: 'Do the thing.' },
    };
    const envelope = createV2ExecutionRenderEnvelope({
      response,
      lifecycle: 'start',
      contentEnvelope,
    });

    const result = toMcpResult({ type: 'success', data: envelope });
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text);

    expect(parsed.references).toBeDefined();
    expect(parsed.references).toHaveLength(1);
    expect(parsed.references[0].id).toBe('spec');
    expect(parsed.references[0].resolveFrom).toBe('package');
    expect(parsed.references[0].status).toBe('resolved');
    expect(parsed.references[0].resolvedPath).toBe('/pkg/spec.md');
  });

  it('omits references from JSON payload when none exist', () => {
    const contentEnvelope = buildStepContentEnvelope({ meta: SAMPLE_META });
    const response = {
      continueToken: 'ct_test',
      isComplete: false,
      pending: { stepId: 'step1', title: 'Step 1', prompt: 'Do the thing.' },
    };
    const envelope = createV2ExecutionRenderEnvelope({
      response,
      lifecycle: 'start',
      contentEnvelope,
    });

    const result = toMcpResult({ type: 'success', data: envelope });
    const text = result.content[0]!.text;
    const parsed = JSON.parse(text);

    expect(parsed.references).toBeUndefined();
  });
});
