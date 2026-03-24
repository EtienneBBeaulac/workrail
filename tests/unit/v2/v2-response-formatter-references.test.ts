import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { formatV2ExecutionResponse } from '../../../src/mcp/v2-response-formatter.js';
import { createV2ExecutionRenderEnvelope } from '../../../src/mcp/render-envelope.js';
import { buildStepContentEnvelope, type ResolvedReference } from '../../../src/mcp/step-content-envelope.js';
import type { StepMetadata } from '../../../src/v2/durable-core/domain/prompt-renderer.js';

const SAMPLE_META: StepMetadata = {
  stepId: 'investigate',
  title: 'Investigate the codebase',
  prompt: 'Look at the code.',
  agentRole: 'senior-engineer',
  requireConfirmation: false,
};

const RESOLVED_REF: ResolvedReference = {
  id: 'api-schema',
  title: 'API Schema v3',
  source: './spec/api.json',
  purpose: 'Authoritative API contract',
  authoritative: true,
  resolveFrom: 'workspace',
  status: 'resolved',
  resolvedPath: '/workspace/spec/api.json',
};

const PINNED_REF: ResolvedReference = {
  id: 'pinned-spec',
  title: 'Pinned Spec',
  source: './spec/pinned.md',
  purpose: 'Pinned from session start',
  authoritative: true,
  resolveFrom: 'workspace',
  status: 'pinned',
};

const PINNED_PACKAGE_REF: ResolvedReference = {
  id: 'pkg-spec',
  title: 'Package Spec',
  source: './spec/authoring-spec.json',
  purpose: 'Bundled authoring spec',
  authoritative: true,
  resolveFrom: 'package',
  status: 'pinned',
};

const UNRESOLVED_REF: ResolvedReference = {
  id: 'missing-doc',
  title: 'Missing Doc',
  source: './docs/missing.md',
  purpose: 'Supporting context',
  authoritative: false,
  resolveFrom: 'workspace',
  status: 'unresolved',
};

function makeEnvelope(lifecycle: 'start' | 'advance' | 'rehydrate', refs: readonly ResolvedReference[]) {
  const contentEnvelope = buildStepContentEnvelope({
    meta: SAMPLE_META,
    references: refs,
  });
  const response = {
    continueToken: 'ct_test',
    checkpointToken: 'cp_test',
    isComplete: false,
    pending: { stepId: 'investigate', title: 'Investigate', prompt: 'Look at the code.', agentRole: 'senior-engineer' },
    preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
    nextIntent: lifecycle === 'rehydrate' ? 'rehydrate_only' : 'await_input',
    nextCall: { tool: 'continue_workflow', params: { continueToken: 'ct_test' } },
  };
  return createV2ExecutionRenderEnvelope({ response, lifecycle, contentEnvelope });
}

describe('formatV2ExecutionResponse — reference delivery', () => {
  beforeEach(() => {
    vi.stubEnv('WORKRAIL_CLEAN_RESPONSE_FORMAT', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders references as a separate section on start lifecycle', () => {
    const envelope = makeEnvelope('start', [RESOLVED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references).toBeDefined();
    expect(result!.references!.kind).toBe('references');
    expect(result!.references!.text).toContain('API Schema v3');
    expect(result!.references!.text).toContain('/workspace/spec/api.json');
    expect(result!.references!.text).toContain('Authoritative API contract');
    expect(result!.references!.text).toContain('(authoritative)');
  });

  it('renders compact references on rehydrate lifecycle', () => {
    const envelope = makeEnvelope('rehydrate', [RESOLVED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references).toBeDefined();
    expect(result!.references!.text).toContain('reminder');
    expect(result!.references!.text).toContain('API Schema v3');
    expect(result!.references!.text).toContain('/workspace/spec/api.json');
    // Compact format should NOT include purpose
    expect(result!.references!.text).not.toContain('Authoritative API contract');
  });

  it('does not render references on advance lifecycle', () => {
    const envelope = makeEnvelope('advance', [RESOLVED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references).toBeUndefined();
  });

  it('renders pinned references with [pinned] tag on start lifecycle', () => {
    const envelope = makeEnvelope('start', [PINNED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references!.text).toContain('[pinned]');
    expect(result!.references!.text).toContain('Pinned Spec');
    // Pinned refs show source path (no resolvedPath available)
    expect(result!.references!.text).toContain('./spec/pinned.md');
  });

  it('renders pinned references with [pinned] tag on rehydrate lifecycle', () => {
    const envelope = makeEnvelope('rehydrate', [PINNED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references!.text).toContain('[pinned]');
    expect(result!.references!.text).toContain('Pinned Spec');
  });

  it('does not render references when envelope has no references', () => {
    const envelope = makeEnvelope('start', []);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references).toBeUndefined();
  });

  it('does not render references when no content envelope exists', () => {
    const response = {
      continueToken: 'ct_test',
      checkpointToken: 'cp_test',
      isComplete: false,
      pending: { stepId: 's1', title: 'S1', prompt: 'Do it.', agentRole: 'dev' },
      preferences: { autonomy: 'guided', riskPolicy: 'conservative' },
      nextIntent: 'await_input',
      nextCall: null,
    };
    const envelope = createV2ExecutionRenderEnvelope({ response, lifecycle: 'start' });
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references).toBeUndefined();
  });

  it('renders [package] tag for package-relative pinned refs on start', () => {
    const envelope = makeEnvelope('start', [PINNED_PACKAGE_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references!.text).toContain('[package]');
    expect(result!.references!.text).toContain('[pinned]');
    expect(result!.references!.text).toContain('Package Spec');
  });

  it('renders [package] tag for package-relative refs on rehydrate', () => {
    const envelope = makeEnvelope('rehydrate', [PINNED_PACKAGE_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references!.text).toContain('[package]');
    expect(result!.references!.text).toContain('[pinned]');
  });

  it('does not render [package] tag for workspace-relative refs', () => {
    const envelope = makeEnvelope('start', [RESOLVED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result!.references!.text).not.toContain('[package]');
  });

  it('marks unresolved references in the output', () => {
    const envelope = makeEnvelope('start', [UNRESOLVED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    expect(result!.references!.text).toContain('[unresolved]');
    expect(result!.references!.text).toContain('./docs/missing.md');
  });

  it('carries resolveFrom on resolved references', () => {
    const packageRef: ResolvedReference = {
      ...RESOLVED_REF,
      id: 'pkg-ref',
      resolveFrom: 'package',
    };
    const envelope = makeEnvelope('start', [packageRef]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    // Verify resolveFrom is accessible on the envelope's references
    expect(envelope.contentEnvelope!.references[0]!.resolveFrom).toBe('package');
  });

  it('renders multiple references in order', () => {
    const envelope = makeEnvelope('start', [RESOLVED_REF, UNRESOLVED_REF]);
    const result = formatV2ExecutionResponse(envelope);

    expect(result).not.toBeNull();
    const refText = result!.references!.text;
    const apiIdx = refText.indexOf('API Schema v3');
    const missingIdx = refText.indexOf('Missing Doc');
    expect(apiIdx).toBeLessThan(missingIdx);
  });
});
