import { describe, it, expect } from 'vitest';
import { sessionSourceFromTrigger } from '../../src/daemon/workflow-runner.js';
import type { WorkflowTrigger } from '../../src/daemon/workflow-runner.js';

const BASE_TRIGGER: WorkflowTrigger = {
  workflowId: 'wr.coding-task',
  goal: 'test goal',
  workspacePath: '/workspace',
};

/**
 * Tests for sessionSourceFromTrigger().
 *
 * WHY this function still exists (A9 migration):
 * After WorkflowTrigger._preAllocatedStartResponse was removed, sessionSourceFromTrigger()
 * was retained for backward compat. It now always returns kind: 'allocate'. Callers
 * that need pre_allocated should construct SessionSource directly.
 */
describe('sessionSourceFromTrigger', () => {
  it('always returns allocate (field removed in A9 migration)', () => {
    const src = sessionSourceFromTrigger(BASE_TRIGGER);
    expect(src.kind).toBe('allocate');
    expect(src.trigger).toBe(BASE_TRIGGER);
  });

  it('accepts optional triggerSource parameter for backward compat (ignored)', () => {
    const src = sessionSourceFromTrigger(BASE_TRIGGER, 'mcp');
    // triggerSource parameter is accepted but ignored -- always returns allocate
    expect(src.kind).toBe('allocate');
    expect(src.trigger).toBe(BASE_TRIGGER);
  });

  it('always returns allocate regardless of trigger content', () => {
    const trigger: WorkflowTrigger = {
      ...BASE_TRIGGER,
      context: { someField: 'value' },
      branchStrategy: 'none',
    };
    const src = sessionSourceFromTrigger(trigger);
    expect(src.kind).toBe('allocate');
    expect(src.trigger).toBe(trigger);
  });
});
