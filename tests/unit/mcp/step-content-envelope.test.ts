import { describe, expect, it } from 'vitest';
import { buildStepContentEnvelope, type ResolvedReference } from '../../../src/mcp/step-content-envelope.js';
import {
  createV2ExecutionRenderEnvelope,
  isV2ExecutionRenderEnvelope,
} from '../../../src/mcp/render-envelope.js';
import type { StepMetadata } from '../../../src/v2/durable-core/domain/prompt-renderer.js';
import type { FormattedSupplement } from '../../../src/mcp/response-supplements.js';

const SAMPLE_META: StepMetadata = {
  stepId: 'investigate',
  title: 'Investigate the codebase',
  prompt: 'Look at the code and understand the architecture.',
  agentRole: 'senior-engineer',
  requireConfirmation: false,
};

describe('buildStepContentEnvelope', () => {
  it('builds envelope from StepMetadata with correct fields', () => {
    const envelope = buildStepContentEnvelope({ meta: SAMPLE_META });

    expect(envelope.stepId).toBe('investigate');
    expect(envelope.title).toBe('Investigate the codebase');
    expect(envelope.authoredPrompt).toBe('Look at the code and understand the architecture.');
    expect(envelope.agentRole).toBe('senior-engineer');
    expect(envelope.references).toEqual([]);
    expect(envelope.supplements).toEqual([]);
  });

  it('carries references when provided', () => {
    const refs: readonly ResolvedReference[] = [
      {
        id: 'api-schema',
        title: 'API Schema',
        source: './spec/api.json',
        purpose: 'Contract',
        authoritative: true,
        resolveFrom: 'workspace',
        status: 'resolved',
        resolvedPath: '/workspace/spec/api.json',
      },
    ];

    const envelope = buildStepContentEnvelope({ meta: SAMPLE_META, references: refs });

    expect(envelope.references).toHaveLength(1);
    expect(envelope.references[0]!.id).toBe('api-schema');
    expect(envelope.references[0]!.status).toBe('resolved');
  });

  it('carries supplements when provided', () => {
    const supplements: readonly FormattedSupplement[] = [
      { kind: 'authority_context', order: 10, text: 'WorkRail is...' },
    ];

    const envelope = buildStepContentEnvelope({ meta: SAMPLE_META, supplements });

    expect(envelope.supplements).toHaveLength(1);
    expect(envelope.supplements[0]!.kind).toBe('authority_context');
  });

  it('produces a frozen (immutable) envelope', () => {
    const envelope = buildStepContentEnvelope({ meta: SAMPLE_META });

    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.references)).toBe(true);
    expect(Object.isFrozen(envelope.supplements)).toBe(true);
  });

  it('preserves agentRole as undefined when meta has no agentRole', () => {
    const meta: StepMetadata = { ...SAMPLE_META, agentRole: undefined };
    const envelope = buildStepContentEnvelope({ meta });

    expect(envelope.agentRole).toBeUndefined();
  });
});

describe('V2ExecutionRenderEnvelope with contentEnvelope', () => {
  it('creates render envelope with contentEnvelope', () => {
    const contentEnvelope = buildStepContentEnvelope({ meta: SAMPLE_META });
    const renderEnvelope = createV2ExecutionRenderEnvelope({
      response: { some: 'data' },
      lifecycle: 'start',
      contentEnvelope,
    });

    expect(renderEnvelope.contentEnvelope).toBeDefined();
    expect(renderEnvelope.contentEnvelope!.stepId).toBe('investigate');
    expect(isV2ExecutionRenderEnvelope(renderEnvelope)).toBe(true);
  });

  it('creates render envelope without contentEnvelope (backward compat)', () => {
    const renderEnvelope = createV2ExecutionRenderEnvelope({
      response: { some: 'data' },
      lifecycle: 'advance',
    });

    expect(renderEnvelope.contentEnvelope).toBeUndefined();
    expect(isV2ExecutionRenderEnvelope(renderEnvelope)).toBe(true);
  });

  it('envelope travels through render envelope correctly', () => {
    const refs: readonly ResolvedReference[] = [
      {
        id: 'spec',
        title: 'Spec',
        source: './spec.md',
        purpose: 'Source of truth',
        authoritative: true,
        resolveFrom: 'workspace',
        status: 'resolved',
        resolvedPath: '/workspace/spec.md',
      },
    ];
    const contentEnvelope = buildStepContentEnvelope({
      meta: SAMPLE_META,
      references: refs,
    });
    const renderEnvelope = createV2ExecutionRenderEnvelope({
      response: { pending: { prompt: SAMPLE_META.prompt } },
      lifecycle: 'start',
      contentEnvelope,
    });

    // Verify the envelope's authoredPrompt matches what would be in pending.prompt
    expect(renderEnvelope.contentEnvelope!.authoredPrompt).toBe(
      (renderEnvelope.response as any).pending.prompt,
    );
    expect(renderEnvelope.contentEnvelope!.references).toHaveLength(1);
  });

  it('pinned references have no resolvedPath (rehydrate path)', () => {
    const pinnedRef: ResolvedReference = {
      id: 'api-spec',
      title: 'API Spec',
      source: './spec/api.json',
      purpose: 'API contract',
      authoritative: true,
      resolveFrom: 'workspace',
      status: 'pinned',
    };
    const envelope = buildStepContentEnvelope({
      meta: SAMPLE_META,
      references: [pinnedRef],
    });

    expect(envelope.references[0]!.status).toBe('pinned');
    expect('resolvedPath' in envelope.references[0]!).toBe(false);
  });
});
