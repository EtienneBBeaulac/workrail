import { describe, it, expect } from 'vitest';
import { workflowDiagnoseEnvironmentFixture } from './fixtures/workflow-diagnose-environment.fixture.js';
import { executeWorkflowLifecycle, type LifecycleHarnessDeps } from './lifecycle-harness.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';

describe('Lifecycle: workflow-diagnose-environment', () => {
  const deps: LifecycleHarnessDeps = {
    compiler: new WorkflowCompiler(),
    interpreter: new WorkflowInterpreter(),
  };

  it('execution integrity: no domain errors at any step', () => {
    const result = executeWorkflowLifecycle(workflowDiagnoseEnvironmentFixture, deps);
    expect(result.kind).toBe('success');
  });

  it('completion: both steps visited with requireConfirmation handled', () => {
    const result = executeWorkflowLifecycle(workflowDiagnoseEnvironmentFixture, deps);
    if (result.kind !== 'success') {
      throw new Error(`Expected success, got ${result.kind}`);
    }
    expect(result.stepsVisited).toEqual(['step-0-probe-capabilities', 'step-1-configure-environment']);
  });
});
