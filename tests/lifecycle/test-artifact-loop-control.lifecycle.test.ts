import { describe, it, expect } from 'vitest';
import { testArtifactLoopControlFixture } from './fixtures/test-artifact-loop-control.fixture.js';
import { executeWorkflowLifecycle, type LifecycleHarnessDeps } from './lifecycle-harness.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';

describe('Lifecycle: test-artifact-loop-control', () => {
  const deps: LifecycleHarnessDeps = {
    compiler: new WorkflowCompiler(),
    interpreter: new WorkflowInterpreter(),
  };

  it('execution integrity: no domain errors during loop execution', () => {
    const result = executeWorkflowLifecycle(testArtifactLoopControlFixture, deps);
    expect(result.kind).toBe('success');
  });

  it('completion: loop iterates twice then exits correctly', () => {
    const result = executeWorkflowLifecycle(testArtifactLoopControlFixture, deps);
    if (result.kind !== 'success') {
      throw new Error(`Expected success, got ${result.kind}`);
    }
    // Expected: init-loop → do-work (iter 0) → decide-continue (continue) →
    //           do-work (iter 1) → decide-continue (stop) → complete
    expect(result.stepsVisited).toEqual([
      'init-loop',
      'do-work',
      'decide-continue',
      'do-work',
      'decide-continue',
      'complete',
    ]);
  });
});
