import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { WorkflowCompiler } from '../../../src/application/services/workflow-compiler.js';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';

function mkWorkflow(overrides: Partial<WorkflowDefinition> = {}): Workflow {
  return {
    definition: {
      id: 'assessment-test-workflow',
      name: 'Assessment Test Workflow',
      description: 'Tests authoring-layer assessment declarations.',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
        },
      ],
      ...overrides,
    },
    source: createBundledSource(),
  };
}

describe('assessment declarations — validation engine', () => {
  it('accepts valid assessments and step assessmentRefs', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'readiness_gate',
          purpose: 'Assess readiness before continuing.',
          dimensions: [
            {
              id: 'confidence',
              purpose: 'How confident the agent is.',
              levels: ['low', 'medium', 'high'],
            },
          ],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['readiness_gate'],
        },
      ],
    });

    const result = new ValidationEngine(new EnhancedLoopValidator()).validateWorkflow(workflow);
    expect(result.valid).toBe(true);
  });

  it('rejects duplicate assessment ids', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'dup_gate',
          purpose: 'First copy.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
        {
          id: 'dup_gate',
          purpose: 'Second copy.',
          dimensions: [{ id: 'risk', purpose: 'Risk', levels: ['low', 'high'] }],
        },
      ],
    });

    const result = new ValidationEngine(new EnhancedLoopValidator()).validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining("duplicate id 'dup_gate'")]));
  });

  it('rejects undeclared step assessmentRefs', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'declared_gate',
          purpose: 'Declared assessment.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['missing_gate'],
        },
      ],
    });

    const result = new ValidationEngine(new EnhancedLoopValidator()).validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("assessmentRef 'missing_gate' references undeclared assessment")])
    );
  });

  it('rejects multiple assessmentRefs on a single step in v1', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'gate_one',
          purpose: 'First gate.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
        {
          id: 'gate_two',
          purpose: 'Second gate.',
          dimensions: [{ id: 'scope', purpose: 'Scope', levels: ['partial', 'complete'] }],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['gate_one', 'gate_two'],
        },
      ],
    });

    const result = new ValidationEngine(new EnhancedLoopValidator()).validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('exactly one assessmentRef per step')])
    );
  });

  it('accepts a valid step-level follow-up consequence', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'readiness_gate',
          purpose: 'Readiness gate.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['readiness_gate'],
          assessmentConsequences: [
            {
              when: { dimensionId: 'confidence', equalsLevel: 'low' },
              effect: { kind: 'require_followup', guidance: 'Gather more context before proceeding.' },
            },
          ],
        },
      ],
    });

    const result = new ValidationEngine(new EnhancedLoopValidator()).validateWorkflow(workflow);
    expect(result.valid).toBe(true);
  });

  it('rejects a consequence that references an unknown assessment dimension', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'readiness_gate',
          purpose: 'Readiness gate.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['readiness_gate'],
          assessmentConsequences: [
            {
              when: { dimensionId: 'scope', equalsLevel: 'low' },
              effect: { kind: 'require_followup', guidance: 'Gather more context before proceeding.' },
            },
          ],
        },
      ],
    });

    const result = new ValidationEngine(new EnhancedLoopValidator()).validateWorkflow(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("references unknown dimension 'scope'")])
    );
  });
});

describe('assessment declarations — workflow compiler', () => {
  const compiler = new WorkflowCompiler();

  it('compiles a workflow with declared assessments and known refs', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'readiness_gate',
          purpose: 'Assess readiness before continuing.',
          dimensions: [
            {
              id: 'confidence',
              purpose: 'How confident the agent is.',
              levels: ['low', 'medium', 'high'],
            },
          ],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['readiness_gate'],
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isOk()).toBe(true);
  });

  it('fails fast on unknown assessmentRef at compile time', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'declared_gate',
          purpose: 'Declared assessment.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['missing_gate'],
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("unknown assessmentRef 'missing_gate'");
  });

  it('fails fast on unknown assessmentRef in inline loop body steps', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'declared_gate',
          purpose: 'Declared assessment.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
      ],
      steps: [
        {
          id: 'loop-1',
          type: 'loop',
          title: 'Loop 1',
          loop: { type: 'for', count: 1, maxIterations: 1 },
          body: [
            {
              id: 'body-step',
              title: 'Body Step',
              prompt: 'Assess inside the loop.',
              assessmentRefs: ['missing_gate'],
            },
          ],
        } as any,
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("Loop body step 'body-step'");
    expect(result._unsafeUnwrapErr().message).toContain("unknown assessmentRef 'missing_gate'");
  });

  it('fails fast on invalid assessment consequence level at compile time', () => {
    const workflow = mkWorkflow({
      assessments: [
        {
          id: 'readiness_gate',
          purpose: 'Readiness gate.',
          dimensions: [{ id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] }],
        },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Assess the situation.',
          assessmentRefs: ['readiness_gate'],
          assessmentConsequences: [
            {
              when: { dimensionId: 'confidence', equalsLevel: 'medium' },
              effect: { kind: 'require_followup', guidance: 'Gather more context before proceeding.' },
            },
          ],
        },
      ],
    });

    const result = compiler.compile(workflow);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("unsupported level 'medium'");
  });
});
