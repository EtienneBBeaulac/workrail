/**
 * Authoring Layer End-to-End Integration Tests
 *
 * Proves the full compiler pipeline works: a workflow declaring features
 * with promptBlocks gets compiled through all passes (templates ->
 * features -> refs -> blocks -> validation) producing a correct compiled
 * output with resolved prompt strings.
 *
 * This is the capstone test for the V2 workflow authoring layer (PRs 1-5).
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { WorkflowCompiler } from '../../../src/application/services/workflow-compiler.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition, WorkflowStepDefinition } from '../../../src/types/workflow-definition.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkWorkflow(definition: WorkflowDefinition): Workflow {
  return {
    definition,
    source: createBundledSource(),
  };
}

// ---------------------------------------------------------------------------
// End-to-end: memory_context feature with promptBlocks
// ---------------------------------------------------------------------------

describe('Authoring Layer E2E: memory_context feature', () => {
  const compiler = new WorkflowCompiler();

  it('compiles a workflow with wr.features.memory_context and promptBlocks', () => {
    const workflow = mkWorkflow({
      id: 'test-memory-workflow',
      name: 'Test Memory Workflow',
      description: 'E2E test for memory context feature.',
      version: '1.0.0',
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 'phase-0',
          title: 'Investigate',
          promptBlocks: {
            goal: 'Find the root cause of the bug.',
            constraints: ['Follow the selected mode.'],
            procedure: ['Gather evidence.', 'Test hypotheses.'],
          },
        },
        {
          id: 'phase-1',
          title: 'Fix',
          promptBlocks: {
            goal: 'Implement the fix.',
            verify: ['All tests pass.'],
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const compiled = result._unsafeUnwrap();
    expect(compiled.steps.length).toBe(2);

    // Both steps should have prompt strings (rendered from promptBlocks)
    const step0 = compiled.steps[0] as WorkflowStepDefinition;
    const step1 = compiled.steps[1] as WorkflowStepDefinition;
    expect(step0.prompt).toBeDefined();
    expect(step1.prompt).toBeDefined();

    // The prompts should contain the original content
    expect(step0.prompt).toContain('Find the root cause of the bug.');
    expect(step0.prompt).toContain('Follow the selected mode.');
    expect(step0.prompt).toContain('Gather evidence.');
    expect(step1.prompt).toContain('Implement the fix.');
    expect(step1.prompt).toContain('All tests pass.');

    // The prompts should contain memory usage instructions (injected by feature)
    expect(step0.prompt).toContain('Memory MCP');
    expect(step1.prompt).toContain('Memory MCP');
  });

  it('memory instructions appear in the Constraints section', () => {
    const workflow = mkWorkflow({
      id: 'test-memory-constraints',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 'step-1',
          title: 'Step',
          promptBlocks: {
            goal: 'Do the thing.',
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const prompt = (result._unsafeUnwrap().steps[0] as WorkflowStepDefinition).prompt!;
    // Memory instructions should be in the Constraints section
    const constraintsIdx = prompt.indexOf('## Constraints');
    expect(constraintsIdx).toBeGreaterThanOrEqual(0);
    // Memory content appears after the Constraints header
    const memoryIdx = prompt.indexOf('Memory MCP');
    expect(memoryIdx).toBeGreaterThan(constraintsIdx);
  });

  it('section order is preserved: Goal -> Constraints -> Procedure', () => {
    const workflow = mkWorkflow({
      id: 'test-section-order',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 'step-1',
          title: 'Step',
          promptBlocks: {
            goal: 'The goal.',
            procedure: ['Step one.', 'Step two.'],
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const prompt = (result._unsafeUnwrap().steps[0] as WorkflowStepDefinition).prompt!;
    const goalIdx = prompt.indexOf('## Goal');
    const constraintsIdx = prompt.indexOf('## Constraints');
    const procedureIdx = prompt.indexOf('## Procedure');

    // Goal -> Constraints (from feature) -> Procedure
    expect(goalIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(procedureIdx);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: promptBlocks without features (backward compat)
// ---------------------------------------------------------------------------

describe('Authoring Layer E2E: promptBlocks without features', () => {
  const compiler = new WorkflowCompiler();

  it('compiles promptBlocks steps without any features', () => {
    const workflow = mkWorkflow({
      id: 'test-blocks-only',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          promptBlocks: {
            goal: 'Investigate.',
            constraints: ['Be thorough.'],
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const prompt = (result._unsafeUnwrap().steps[0] as WorkflowStepDefinition).prompt!;
    expect(prompt).toContain('## Goal');
    expect(prompt).toContain('Investigate.');
    expect(prompt).toContain('## Constraints');
    expect(prompt).toContain('Be thorough.');
    // No memory content (no feature declared)
    expect(prompt).not.toContain('Memory MCP');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: raw prompt steps with features (features don't modify raw prompts)
// ---------------------------------------------------------------------------

describe('Authoring Layer E2E: raw prompt steps with features', () => {
  const compiler = new WorkflowCompiler();

  it('raw prompt steps are not modified by features', () => {
    const workflow = mkWorkflow({
      id: 'test-raw-with-features',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Raw prompt text here.',
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const prompt = (result._unsafeUnwrap().steps[0] as WorkflowStepDefinition).prompt!;
    expect(prompt).toBe('Raw prompt text here.');
    // Features don't inject into raw prompt steps
    expect(prompt).not.toContain('Memory MCP');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: inline refs in promptBlocks
// ---------------------------------------------------------------------------

describe('Authoring Layer E2E: inline refs in promptBlocks', () => {
  const compiler = new WorkflowCompiler();

  it('resolves inline wr.refs.* in promptBlocks goal', () => {
    const workflow = mkWorkflow({
      id: 'test-inline-refs',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          promptBlocks: {
            goal: [
              { kind: 'text', text: 'Before checking memory: ' },
              { kind: 'ref', refId: 'wr.refs.memory_query' },
            ],
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const prompt = (result._unsafeUnwrap().steps[0] as WorkflowStepDefinition).prompt!;
    expect(prompt).toContain('Before checking memory:');
    expect(prompt).toContain('memory_briefing');
    // The ref should be fully resolved — no ref markers in output
    expect(prompt).not.toContain('wr.refs.');
  });

  it('fails fast on unknown ref', () => {
    const workflow = mkWorkflow({
      id: 'test-unknown-ref',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          promptBlocks: {
            goal: [{ kind: 'ref', refId: 'wr.refs.nonexistent' }],
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: error cases
// ---------------------------------------------------------------------------

describe('Authoring Layer E2E: error cases', () => {
  const compiler = new WorkflowCompiler();

  it('fails fast on unknown feature', () => {
    const workflow = mkWorkflow({
      id: 'test-unknown-feature',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      features: ['wr.features.nonexistent'],
      steps: [
        { id: 'step-1', title: 'Step', promptBlocks: { goal: 'Goal.' } },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
  });

  it('fails fast on unknown template', () => {
    const workflow = mkWorkflow({
      id: 'test-unknown-template',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Step',
          templateCall: { templateId: 'wr.templates.nonexistent' },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
  });

  it('fails fast on step with both prompt and promptBlocks', () => {
    const workflow = mkWorkflow({
      id: 'test-both',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Step',
          prompt: 'Raw.',
          promptBlocks: { goal: 'Structured.' },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
  });

  it('fails fast on empty promptBlocks', () => {
    const workflow = mkWorkflow({
      id: 'test-empty-blocks',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      steps: [
        { id: 'step-1', title: 'Step', promptBlocks: {} },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: mixed workflow (raw + promptBlocks + features)
// ---------------------------------------------------------------------------

describe('Authoring Layer E2E: mixed workflow', () => {
  const compiler = new WorkflowCompiler();

  it('compiles a workflow mixing raw prompts and promptBlocks with features', () => {
    const workflow = mkWorkflow({
      id: 'test-mixed',
      name: 'Mixed Workflow',
      description: 'Uses raw prompts and promptBlocks together.',
      version: '1.0.0',
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 'phase-0',
          title: 'Triage',
          prompt: 'Triage the issue. Check severity and priority.',
        },
        {
          id: 'phase-1',
          title: 'Investigate',
          promptBlocks: {
            goal: 'Investigate the root cause.',
            procedure: [
              'Reproduce the issue.',
              [
                { kind: 'text', text: 'Query prior knowledge: ' },
                { kind: 'ref', refId: 'wr.refs.memory_query' },
              ],
            ],
            outputRequired: { notesMarkdown: 'Root cause analysis.' },
          },
        },
        {
          id: 'phase-2',
          title: 'Fix',
          promptBlocks: {
            goal: 'Implement and verify the fix.',
            verify: ['All tests pass.', 'No regressions.'],
          },
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);

    const compiled = result._unsafeUnwrap();
    expect(compiled.steps.length).toBe(3);

    // Phase 0: raw prompt, unchanged (features don't touch it)
    const p0 = compiled.steps[0] as WorkflowStepDefinition;
    expect(p0.prompt).toBe('Triage the issue. Check severity and priority.');

    // Phase 1: promptBlocks with inline ref + feature injection
    const p1 = compiled.steps[1] as WorkflowStepDefinition;
    expect(p1.prompt).toContain('Investigate the root cause.');
    expect(p1.prompt).toContain('Reproduce the issue.');
    expect(p1.prompt).toContain('memory_briefing'); // from wr.refs.memory_query
    expect(p1.prompt).toContain('Memory MCP'); // from wr.features.memory_context
    expect(p1.prompt).toContain('Root cause analysis.'); // outputRequired
    expect(p1.prompt).not.toContain('wr.refs.'); // all refs resolved

    // Phase 2: promptBlocks with feature injection
    const p2 = compiled.steps[2] as WorkflowStepDefinition;
    expect(p2.prompt).toContain('Implement and verify the fix.');
    expect(p2.prompt).toContain('All tests pass.');
    expect(p2.prompt).toContain('Memory MCP'); // from wr.features.memory_context
  });

  it('compilation is deterministic', () => {
    const definition: WorkflowDefinition = {
      id: 'test-determinism',
      name: 'Test',
      description: 'Test.',
      version: '1.0.0',
      features: ['wr.features.memory_context'],
      steps: [
        {
          id: 'step-1',
          title: 'Step',
          promptBlocks: {
            goal: 'Goal.',
            constraints: ['C1.'],
            procedure: ['P1.'],
          },
        },
      ],
    };

    const a = compiler.compile(mkWorkflow(definition))._unsafeUnwrap();
    const b = compiler.compile(mkWorkflow(definition))._unsafeUnwrap();

    const promptA = (a.steps[0] as WorkflowStepDefinition).prompt;
    const promptB = (b.steps[0] as WorkflowStepDefinition).prompt;
    expect(promptA).toBe(promptB);
  });
});
