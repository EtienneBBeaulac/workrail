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

    const steps = result._unsafeUnwrap();

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

    const steps = result._unsafeUnwrap();

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

    const steps = result._unsafeUnwrap();

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

    const steps = result._unsafeUnwrap();
    const gatherStep = steps[0] as WorkflowStepDefinition;
    const implementStep = steps[steps.length - 1] as WorkflowStepDefinition;

    expect(gatherStep.prompt).toBe('Gather context about the problem space.');
    expect(implementStep.prompt).toBe('Implement the selected design.');
  });
});

describe('Lean workflow with injected routine-tension-driven-design', () => {
  it('compiles the lean workflow with routine injection expanding Phase 1', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.lean.v2.json');
    const routine = loadRoutineJson('tension-driven-design.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap();

    // Phase 0 is still the first step (regular, not injected)
    expect(steps[0]!.id).toBe('phase-0-understand-and-classify');

    // Phase 1 templateCall should be expanded into the routine's 5 steps
    const routineStepIds = routine.steps.map(
      (s: { id: string }) => `phase-1-design-generation.${s.id}`,
    );
    for (const expectedId of routineStepIds) {
      const found = steps.find(s => s.id === expectedId);
      expect(found, `Expected expanded step '${expectedId}' to exist`).toBeDefined();
    }

    // The challenge-and-select step should follow the routine steps
    const selectStep = steps.find(s => s.id === 'phase-1f-challenge-and-select') as WorkflowStepDefinition;
    expect(selectStep).toBeDefined();
    expect(selectStep.prompt).toContain('selectedApproach');
  });

  it('preserves all other phases after injection', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.lean.v2.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap();
    const stepIds = steps.map(s => s.id);

    // Key phases that should survive compilation
    expect(stepIds).toContain('phase-0-understand-and-classify');
    expect(stepIds).toContain('phase-1f-challenge-and-select');
    expect(stepIds).toContain('phase-2-design-review');
    expect(stepIds).toContain('phase-3-plan-and-test-design');
    expect(stepIds).toContain('phase-4-plan-audit');
    expect(stepIds).toContain('phase-5-small-task-fast-path');
    expect(stepIds).toContain('phase-6-implement-slices');
    expect(stepIds).toContain('phase-7-final-verification');
  });

  it('expanded routine steps inherit runCondition from the templateCall step', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.lean.v2.json');
    const routine = loadRoutineJson('tension-driven-design.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap();
    const expectedRunCondition = { var: 'taskComplexity', not_equals: 'Small' };

    // Every expanded routine step should inherit the parent's runCondition
    for (const routineStep of routine.steps) {
      const expandedId = `phase-1-design-generation.${routineStep.id}`;
      const step = steps.find(s => s.id === expandedId) as WorkflowStepDefinition;
      expect(step, `Expected '${expandedId}' to exist`).toBeDefined();
      expect(step.runCondition).toEqual(expectedRunCondition);
    }
  });

  it('arg substitution works in the lean workflow (deliverableName)', () => {
    const workflow = loadTopLevelWorkflowJson('coding-task-workflow-agentic.lean.v2.json');

    const result = resolveDefinitionSteps(workflow.steps, workflow.features ?? []);
    expect(result.isOk()).toBe(true);

    const steps = result._unsafeUnwrap();
    const deliverStep = steps.find(
      s => s.id === 'phase-1-design-generation.step-deliver',
    ) as WorkflowStepDefinition;

    expect(deliverStep).toBeDefined();
    expect(deliverStep.prompt).toContain('design-candidates.md');
    expect(deliverStep.prompt).not.toContain('{deliverableName}');
  });
});
