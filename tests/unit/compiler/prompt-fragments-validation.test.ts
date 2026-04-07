/**
 * Tests for promptFragments structural validation in ValidationEngine.
 */
import { describe, it, expect } from 'vitest';
import { container } from 'tsyringe';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(stepOverrides: Partial<WorkflowDefinition['steps'][number]> = {}): Workflow {
  const definition: WorkflowDefinition = {
    id: 'test-workflow',
    name: 'Test',
    description: 'Test workflow',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        title: 'Step 1',
        prompt: 'Base prompt.',
        ...stepOverrides,
      } as WorkflowDefinition['steps'][number],
    ],
  };
  return createWorkflow(definition, createBundledSource());
}

function makeEngine(): ValidationEngine {
  return new ValidationEngine(new EnhancedLoopValidator());
}

// ---------------------------------------------------------------------------
// Valid promptFragments
// ---------------------------------------------------------------------------

describe('ValidationEngine.validateWorkflow — promptFragments valid', () => {
  it('accepts a step with well-formed promptFragments', () => {
    const wf = makeWorkflow({
      promptFragments: [
        { id: 'quick-fragment', when: { var: 'rigorMode', equals: 'QUICK' }, text: 'Keep it light.' },
        { id: 'deep-fragment', when: { var: 'rigorMode', in: ['STANDARD', 'THOROUGH'] }, text: 'Go deeper.' },
      ],
    } as any);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('accepts a fragment without a when condition (always-include)', () => {
    const wf = makeWorkflow({
      promptFragments: [{ id: 'always', text: 'Always appended.' }],
    } as any);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate fragment IDs
// ---------------------------------------------------------------------------

describe('ValidationEngine.validateWorkflow — duplicate fragment IDs', () => {
  it('rejects duplicate fragment ids within the same step', () => {
    const wf = makeWorkflow({
      promptFragments: [
        { id: 'frag-a', text: 'First.' },
        { id: 'frag-a', text: 'Second.' },
      ],
    } as any);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes("duplicate id 'frag-a'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Empty fragment text
// ---------------------------------------------------------------------------

describe('ValidationEngine.validateWorkflow — empty fragment text', () => {
  it('rejects a fragment with empty text', () => {
    const wf = makeWorkflow({
      promptFragments: [{ id: 'frag', text: '' }],
    } as any);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes("empty text"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// {{wr.*}} tokens in fragment text
// ---------------------------------------------------------------------------

describe('ValidationEngine.validateWorkflow — wr token rejection', () => {
  it('rejects a fragment text containing a {{wr.*}} token', () => {
    const wf = makeWorkflow({
      promptFragments: [
        { id: 'bad-fragment', text: 'Delegate to {{wr.bindings.design_review}}.' },
      ],
    } as any);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.includes("{{wr.*}}"))).toBe(true);
  });

  it('rejects any {{wr.X}} variant', () => {
    const wf = makeWorkflow({
      promptFragments: [
        { id: 'bad', text: 'Use {{wr.refs.philosophy_preamble}} here.' },
      ],
    } as any);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
  });
});
