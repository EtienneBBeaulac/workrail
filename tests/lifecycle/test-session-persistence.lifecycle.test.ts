import { describe, it, expect } from 'vitest';
import { testSessionPersistenceFixture } from './fixtures/test-session-persistence.fixture.js';
import { executeWorkflowLifecycle, type LifecycleHarnessDeps } from './lifecycle-harness.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';

describe('Lifecycle: test-session-persistence', () => {
  const deps: LifecycleHarnessDeps = {
    compiler: new WorkflowCompiler(),
    interpreter: new WorkflowInterpreter(),
  };

  it('execution integrity: no domain errors at any step', () => {
    const result = executeWorkflowLifecycle(testSessionPersistenceFixture, deps);
    expect(result.kind).toBe('success');
  });

  it('completion: all expected steps visited in order', () => {
    const result = executeWorkflowLifecycle(testSessionPersistenceFixture, deps);
    if (result.kind !== 'success') {
      throw new Error(`Expected success, got ${result.kind}`);
    }
    expect(result.stepsVisited).toEqual([
      'step-1-alpha',
      'step-2-beta',
      'step-3-gamma',
      'step-4-delta',
      'step-5-final',
    ]);
  });
});
