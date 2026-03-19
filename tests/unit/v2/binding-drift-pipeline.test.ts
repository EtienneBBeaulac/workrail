/**
 * Integration tests for resolvedBindings flowing through the validation pipeline
 * into the pinned snapshot.
 *
 * Verifies that:
 * - validateWorkflowPhase1a injects resolvedBindings into the snapshot
 * - Workflows without extensionPoints produce no resolvedBindings field
 * - Workflows with extensionPoints capture the resolved manifest
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflowPhase1a } from '../../../src/application/services/workflow-validation-pipeline.js';
import { validateWorkflowSchema } from '../../../src/application/validation.js';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../../../src/application/services/workflow-compiler.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../../../src/v2/read-only/v1-to-v2-shim.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';

function makeDeps() {
  const loopValidator = new EnhancedLoopValidator();
  const validationEngine = new ValidationEngine(loopValidator);
  const compiler = new WorkflowCompiler();
  return {
    schemaValidate: validateWorkflowSchema,
    structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
    compiler,
    normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
  };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}) {
  const def: WorkflowDefinition = {
    id: 'test-wf',
    name: 'Test',
    description: 'A test workflow',
    version: '1.0.0',
    steps: [{ id: 'step-1', title: 'Step 1', prompt: 'Do the thing' }],
    ...overrides,
  };
  return createWorkflow(def, createBundledSource());
}

describe('validateWorkflowPhase1a — resolvedBindings enrichment', () => {
  it('snapshot has no resolvedBindings for a workflow without extensionPoints', () => {
    const workflow = makeWorkflow();
    const outcome = validateWorkflowPhase1a(workflow, makeDeps());

    expect(outcome.kind).toBe('phase1a_valid');
    if (outcome.kind !== 'phase1a_valid') return;

    // resolvedBindings should be absent (no extensionPoints declared)
    expect(outcome.snapshot.resolvedBindings).toBeUndefined();
  });

  it('snapshot has resolvedBindings when workflow declares extensionPoints', () => {
    const workflow = makeWorkflow({
      extensionPoints: [
        { slotId: 'design_review', purpose: 'Which design review routine to run', default: 'default-design-review' },
      ],
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Run {{wr.bindings.design_review}} now.',
        },
      ],
    });
    const outcome = validateWorkflowPhase1a(workflow, makeDeps());

    expect(outcome.kind).toBe('phase1a_valid');
    if (outcome.kind !== 'phase1a_valid') return;

    // resolvedBindings should capture the default value (no project override)
    expect(outcome.snapshot.resolvedBindings).toBeDefined();
    expect(outcome.snapshot.resolvedBindings?.['design_review']).toBe('default-design-review');
  });

  it('snapshot resolvedBindings is absent when extensionPoints declared but no tokens in prompts', () => {
    // extensionPoints declared but never referenced — manifest stays empty → not injected
    const workflow = makeWorkflow({
      extensionPoints: [
        { slotId: 'unused_slot', purpose: 'Not used in any step', default: 'some-routine' },
      ],
    });
    const outcome = validateWorkflowPhase1a(workflow, makeDeps());

    expect(outcome.kind).toBe('phase1a_valid');
    if (outcome.kind !== 'phase1a_valid') return;

    // No tokens were actually resolved — manifest is empty → field absent
    expect(outcome.snapshot.resolvedBindings).toBeUndefined();
  });
});
