/**
 * End-to-End Routine Injection Test
 *
 * Validates success criterion #5: "At least one workflow uses an injected
 * routine to validate the end-to-end path."
 *
 * Loads the real routine-injection-example.json workflow, compiles it
 * through the full pipeline (template expansion → features → refs → blocks),
 * and verifies the routine steps appear correctly in the compiled output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { resolveDefinitionSteps } from '../../../src/application/services/workflow-compiler.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadWorkflowJson(filename: string, subdir = 'examples') {
  const filePath = path.resolve(__dirname, '..', '..', '..', 'workflows', subdir, filename);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function loadTopLevelWorkflowJson(filename: string) {
  const filePath = path.resolve(__dirname, '..', '..', '..', 'workflows', filename);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function loadRoutineJson(filename: string) {
  const filePath = path.resolve(__dirname, '..', '..', '..', 'workflows', 'routines', filename);
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('End-to-end routine injection through the compiler', () => {
  it('compiles the routine-injection-example workflow with tension-driven-design routine', () => {
    const workflow = loadWorkflowJson('routine-injection-example.json');
    const routine = loadRoutineJson('tension-driven-design.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;

    // First step is the regular gather context step
    expect(steps[0]!.id).toBe('phase-0-gather');

    // The routine has 5 steps, so indices 1-5 should be the expanded routine steps
    const routineStepCount = routine.steps.length;
    expect(routineStepCount).toBe(5);

    // Verify routine steps are expanded with correct ID prefixing
    for (let i = 0; i < routineStepCount; i++) {
      const expandedStep = steps[i + 1] as WorkflowStepDefinition;
      const routineStep = routine.steps[i];
      expect(expandedStep.id).toBe(`phase-1-design.${routineStep.id}`);
      // Prompt should be present (arg substitution applied)
      expect(expandedStep.prompt).toBeDefined();
      expect(expandedStep.prompt!.length).toBeGreaterThan(0);
    }

    // Last step is the regular implement step
    const lastStep = steps[steps.length - 1]!;
    expect(lastStep.id).toBe('phase-2-implement');

    // Total step count: 1 (gather) + 5 (routine) + 1 (implement) = 7
    expect(steps.length).toBe(7);
  });

  it('routine metaGuidance is injected as step-level guidance', () => {
    const workflow = loadWorkflowJson('routine-injection-example.json');
    const routine = loadRoutineJson('tension-driven-design.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;

    // Every expanded routine step should have guidance from the routine's metaGuidance
    for (let i = 1; i <= routine.steps.length; i++) {
      const step = steps[i] as WorkflowStepDefinition;
      expect(step.guidance).toBeDefined();
      expect(step.guidance!.length).toBeGreaterThanOrEqual(routine.metaGuidance.length);
      // Every metaGuidance entry should be present
      for (const guidance of routine.metaGuidance) {
        expect(step.guidance).toContain(guidance);
      }
    }
  });

  it('arg substitution works on real routine (deliverableName)', () => {
    const workflow = loadWorkflowJson('routine-injection-example.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;

    // The last routine step (step-deliver) references {deliverableName} in its prompt
    const deliverStep = steps.find(s => s.id === 'phase-1-design.step-deliver') as WorkflowStepDefinition;
    expect(deliverStep).toBeDefined();
    expect(deliverStep.prompt).toContain('design-candidates.md');
    // Should NOT contain the unsubstituted placeholder
    expect(deliverStep.prompt).not.toContain('{deliverableName}');
  });

  it('regular steps are not affected by routine injection', () => {
    const workflow = loadWorkflowJson('routine-injection-example.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;
    const gatherStep = steps[0] as WorkflowStepDefinition;
    const implementStep = steps[steps.length - 1] as WorkflowStepDefinition;

    expect(gatherStep.prompt).toBe('Gather context about the problem space.');
    expect(implementStep.prompt).toBe('Implement the selected design.');
  });
});

describe('Lean workflow — Phase 1 orchestration with injected routine', () => {
  it('compiles with the three-part Phase 1 structure (hypothesis, design, select)', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;
    const stepIds = steps.map(s => s.id);

    // Phase 1a: hypothesis step
    expect(stepIds).toContain('phase-1a-hypothesis');

    // Phase 1b-quick: lightweight inline design
    expect(stepIds).toContain('phase-1b-design-quick');

    // Phase 1b-deep: expanded routine steps (5 from tension-driven-design)
    const routine = loadRoutineJson('tension-driven-design.json');
    for (const routineStep of routine.steps) {
      const expandedId = `phase-1b-design-deep.${routineStep.id}`;
      expect(stepIds, `Expected '${expandedId}' in compiled steps`).toContain(expandedId);
    }

    // Phase 1c: challenge and select
    expect(stepIds).toContain('phase-1c-challenge-and-select');
  });

  it('hypothesis step references initialHypothesis context variable', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;

    const hypothesis = steps.find(s => s.id === 'phase-1a-hypothesis') as WorkflowStepDefinition;
    expect(hypothesis.prompt).toContain('initialHypothesis');
  });

  it('QUICK design step has rigorMode=QUICK runCondition', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;

    const quickStep = steps.find(s => s.id === 'phase-1b-design-quick') as WorkflowStepDefinition;
    expect(quickStep.runCondition).toEqual({
      and: [
        { var: 'taskComplexity', not_equals: 'Small' },
        { var: 'rigorMode', equals: 'QUICK' },
        { var: 'solutionFixed', not_equals: true },
      ],
    });
  });

  it('deep design routine steps inherit compound runCondition (not Small AND not QUICK)', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');
    const routine = loadRoutineJson('tension-driven-design.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;

    const expectedRunCondition = {
      and: [
        { var: 'taskComplexity', not_equals: 'Small' },
        { var: 'rigorMode', not_equals: 'QUICK' },
        { var: 'solutionFixed', not_equals: true },
      ],
    };

    for (const routineStep of routine.steps) {
      const expandedId = `phase-1b-design-deep.${routineStep.id}`;
      const step = steps.find(s => s.id === expandedId) as WorkflowStepDefinition;
      expect(step, `Expected '${expandedId}' to exist`).toBeDefined();
      expect(step.runCondition).toEqual(expectedRunCondition);
    }
  });

  it('both design paths produce design-candidates.md as unified output contract', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;

    // QUICK path writes to design-candidates.md
    const quickStep = steps.find(s => s.id === 'phase-1b-design-quick') as WorkflowStepDefinition;
    expect(quickStep.prompt).toContain('design-candidates.md');

    // Deep path's final step also writes to design-candidates.md (via routine arg)
    const deliverStep = steps.find(s => s.id === 'phase-1b-design-deep.step-deliver') as WorkflowStepDefinition;
    expect(deliverStep.prompt).toContain('design-candidates.md');

    // Challenge step reads from design-candidates.md
    const selectStep = steps.find(s => s.id === 'phase-1c-challenge-and-select') as WorkflowStepDefinition;
    expect(selectStep.prompt).toContain('design-candidates.md');
  });

  it('challenge-and-select step captures selectedApproach and references comparison', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;

    const selectStep = steps.find(s => s.id === 'phase-1c-challenge-and-select') as WorkflowStepDefinition;
    expect(selectStep.prompt).toContain('selectedApproach');
    expect(selectStep.prompt).toContain('changed your mind');
    expect(selectStep.prompt).toContain('original guess');
  });

  it('preserves all other phases after restructured Phase 1', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;
    const stepIds = steps.map(s => s.id);

    expect(stepIds).toContain('phase-0-understand-and-classify');
    expect(stepIds).toContain('phase-2-design-review');
    expect(stepIds).toContain('phase-3-plan-and-test-design');
    expect(stepIds).toContain('phase-4-plan-audit');
    expect(stepIds).toContain('phase-5-small-task-fast-path');
    expect(stepIds).toContain('phase-6-implement-slices');
    expect(stepIds).toContain('phase-7-final-verification');
  });

  it('arg substitution works in the deep design path (deliverableName)', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    const steps = result._unsafeUnwrap().steps;

    const deliverStep = steps.find(
      s => s.id === 'phase-1b-design-deep.step-deliver',
    ) as WorkflowStepDefinition;

    expect(deliverStep).toBeDefined();
    expect(deliverStep.prompt).toContain('design-candidates.md');
    expect(deliverStep.prompt).not.toContain('{deliverableName}');
  });
});

describe('Lean workflow — injected review routines inside loops', () => {
  it('expands the design review routine inside Phase 2 while keeping workflow-owned wrapper steps', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');
    const routine = loadRoutineJson('design-review.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;
    const phase2Loop = steps.find(
      s => s.id === 'phase-2-design-review',
    ) as LoopStepDefinition;
    expect(phase2Loop).toBeDefined();

    const body = phase2Loop.body as WorkflowStepDefinition[];
    const bodyIds = body.map(step => step.id);

    expect(bodyIds).toContain('phase-2a-pre-assess-design-review');
    expect(bodyIds).toContain('phase-2c-synthesize-design-review');
    expect(bodyIds).toContain('phase-2d-loop-decision');

    for (const routineStep of routine.steps) {
      const expandedId = `phase-2b-design-review-core.${routineStep.id}`;
      expect(bodyIds, `Expected '${expandedId}' in Phase 2 body`).toContain(expandedId);
    }
  });

  it('expands the final verification routine inside Phase 7 while keeping fix-and-loop-control in workflow', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');
    const routine = loadRoutineJson('final-verification.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;
    const phase7Loop = steps.find(
      s => s.id === 'phase-7-final-verification',
    ) as LoopStepDefinition;
    expect(phase7Loop).toBeDefined();

    const body = phase7Loop.body as WorkflowStepDefinition[];
    const bodyIds = body.map(step => step.id);

    expect(bodyIds).toContain('phase-7b-fix-and-summarize');
    expect(bodyIds).toContain('phase-7c-loop-decision');

    for (const routineStep of routine.steps) {
      const expandedId = `phase-7a-final-verification-core.${routineStep.id}`;
      expect(bodyIds, `Expected '${expandedId}' in Phase 7 body`).toContain(expandedId);
    }
  });

  it('review routines inherit their parent loop-step run conditions when expanded', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap().steps;
    const phase2Loop = steps.find(s => s.id === 'phase-2-design-review') as LoopStepDefinition;
    const phase7Loop = steps.find(s => s.id === 'phase-7-final-verification') as LoopStepDefinition;

    const phase2Body = phase2Loop.body as WorkflowStepDefinition[];
    const phase7Body = phase7Loop.body as WorkflowStepDefinition[];

    const phase2CoreStep = phase2Body.find(
      step => step.id === 'phase-2b-design-review-core.step-deliver',
    ) as WorkflowStepDefinition;
    const phase7CoreStep = phase7Body.find(
      step => step.id === 'phase-7a-final-verification-core.step-deliver',
    ) as WorkflowStepDefinition;

    expect(phase2CoreStep).toBeDefined();
    expect(phase7CoreStep).toBeDefined();
    expect(phase2CoreStep.runCondition).toBeUndefined();
    expect(phase7CoreStep.runCondition).toBeUndefined();
  });
});
