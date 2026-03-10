/**
 * Pinned Snapshot Resolution — Tests
 *
 * Proves the boundary invariant: compileV1WorkflowToPinnedSnapshot resolves
 * promptBlocks into prompt strings before storing. This ensures
 * renderPendingPrompt (which reads step.prompt directly from the pinned
 * definition) always finds a compiled prompt, never undefined.
 */
import { describe, it, expect } from 'vitest';
import { compileV1WorkflowToPinnedSnapshot, compileV1WorkflowToV2PreviewSnapshot, normalizeV1WorkflowToPinnedSnapshot } from '../../../src/v2/read-only/v1-to-v2-shim';
import { WorkflowCompiler } from '../../../src/application/services/workflow-compiler';
import { createWorkflow, createBundledSource } from '../../../src/types/workflow';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition';

function mkWorkflow(overrides: Partial<WorkflowDefinition> & { steps: WorkflowDefinition['steps'] }): ReturnType<typeof createWorkflow> {
  return createWorkflow(
    {
      id: overrides.id ?? 'test-wf',
      name: overrides.name ?? 'Test',
      description: overrides.description ?? 'test',
      version: overrides.version ?? '1.0.0',
      steps: overrides.steps,
      features: overrides.features,
    } as WorkflowDefinition,
    createBundledSource(),
  );
}

describe('compileV1WorkflowToPinnedSnapshot', () => {
  it('preserves prompt for steps with raw prompt strings (backward compat)', () => {
    const wf = mkWorkflow({
      steps: [
        { id: 's1', title: 'Step 1', prompt: 'Do the thing.' },
      ] as any,
    });

    const pinned = compileV1WorkflowToPinnedSnapshot(wf);
    const def = pinned.definition as WorkflowDefinition;
    expect((def.steps[0] as any).prompt).toBe('Do the thing.');
  });

  it('resolves promptBlocks into prompt string and strips promptBlocks before pinning', () => {
    const wf = mkWorkflow({
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          promptBlocks: {
            goal: 'Investigate the bug.',
            constraints: ['Follow systematic methodology.'],
            procedure: ['Gather evidence.', 'Form hypotheses.'],
          },
        },
      ] as any,
    });

    const pinned = compileV1WorkflowToPinnedSnapshot(wf);
    const def = pinned.definition as WorkflowDefinition;
    const step = def.steps[0] as any;

    // prompt should be filled in from rendered blocks
    expect(step.prompt).toContain('Investigate the bug.');
    expect(step.prompt).toContain('Follow systematic methodology.');
    expect(step.prompt).toContain('Gather evidence.');
    expect(step.prompt).toContain('Form hypotheses.');
    expect(step.prompt).toContain('## Goal');
    expect(step.prompt).toContain('## Constraints');
    expect(step.prompt).toContain('## Procedure');

    // promptBlocks must be stripped — having both prompt and promptBlocks
    // causes the compiler's own XOR check to reject the step at advance time.
    expect(step.promptBlocks).toBeUndefined();
  });

  it('resolves features + refs in promptBlocks before pinning', () => {
    const wf = mkWorkflow({
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          promptBlocks: {
            goal: 'Do work.',
          },
        },
      ] as any,
    });

    const pinned = compileV1WorkflowToPinnedSnapshot(wf);
    const def = pinned.definition as WorkflowDefinition;
    const step = def.steps[0] as any;

    // memory_context feature injects wr.refs.memory_usage into constraints
    expect(step.prompt).toContain('Memory MCP');
    expect(step.prompt).toContain('## Constraints');
  });

  it('handles mixed steps (some prompt, some promptBlocks)', () => {
    const wf = mkWorkflow({
      steps: [
        { id: 's1', title: 'Step 1', prompt: 'Raw prompt.' },
        {
          id: 's2',
          title: 'Step 2',
          promptBlocks: {
            goal: 'Structured goal.',
            verify: ['Check it worked.'],
          },
        },
      ] as any,
    });

    const pinned = compileV1WorkflowToPinnedSnapshot(wf);
    const def = pinned.definition as WorkflowDefinition;

    expect((def.steps[0] as any).prompt).toBe('Raw prompt.');
    expect((def.steps[1] as any).prompt).toContain('Structured goal.');
    expect((def.steps[1] as any).prompt).toContain('Check it worked.');
  });

  it('strict normalization rejects workflow with both prompt and promptBlocks', () => {
    // Step with both prompt AND promptBlocks — the strict path must reject this
    // instead of falling back to the raw definition.
    const wf = mkWorkflow({
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          prompt: 'Raw.',
          promptBlocks: { goal: 'Also blocks.' },
        },
      ] as any,
    });

    const result = normalizeV1WorkflowToPinnedSnapshot(wf);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('prompt');
      expect(result.error.message).toContain('promptBlocks');
    }
  });

  it('strict normalization rejects invalid workflow that later causes advance failure', () => {
    // Prove the full chain: invalid workflow → strict normalization rejects it →
    // compiler would also reject the pinned result. This is the exact failure
    // we diagnosed: invalid authored workflow gets pinned, later fails at advance.
    const wf = mkWorkflow({
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          prompt: 'Raw.',
          promptBlocks: { goal: 'Also blocks.' },
        },
      ] as any,
    });

    // Strict path rejects before pinning
    const normalizeResult = normalizeV1WorkflowToPinnedSnapshot(wf);
    expect(normalizeResult.isErr()).toBe(true);

    // Legacy permissive path still pins (for backward compat of preview)
    const pinned = compileV1WorkflowToPinnedSnapshot(wf);
    expect(pinned.definition).toBeDefined();

    // Compiler also rejects the pinned snapshot (this is what continue_workflow hit)
    const compiler = new WorkflowCompiler();
    const pinnedWorkflow = createWorkflow(pinned.definition as WorkflowDefinition, createBundledSource());
    const compileResult = compiler.compile(pinnedWorkflow);
    expect(compileResult.isErr()).toBe(true);
  });
});

describe('compileV1WorkflowToV2PreviewSnapshot', () => {
  it('resolves promptBlocks for preview of first step', () => {
    const wf = mkWorkflow({
      steps: [
        {
          id: 's1',
          title: 'Step 1',
          promptBlocks: {
            goal: 'Preview this goal.',
          },
        },
      ] as any,
    });

    const preview = compileV1WorkflowToV2PreviewSnapshot(wf);
    expect(preview.preview.prompt).toContain('Preview this goal.');
    expect(preview.preview.prompt).toContain('## Goal');
  });

  it('uses raw prompt for preview of text-prompt step', () => {
    const wf = mkWorkflow({
      steps: [
        { id: 's1', title: 'Step 1', prompt: 'Raw preview.' },
      ] as any,
    });

    const preview = compileV1WorkflowToV2PreviewSnapshot(wf);
    expect(preview.preview.prompt).toBe('Raw preview.');
  });
});
