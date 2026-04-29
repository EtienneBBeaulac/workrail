import { describe, it, expect } from 'vitest';
import { sessionSourceFromTrigger } from '../../src/daemon/workflow-runner.js';
import type { WorkflowTrigger } from '../../src/daemon/workflow-runner.js';

const BASE_TRIGGER: WorkflowTrigger = {
  workflowId: 'wr.coding-task',
  goal: 'test goal',
  workspacePath: '/workspace',
};

describe('sessionSourceFromTrigger', () => {
  it('returns allocate when _preAllocatedStartResponse is absent', () => {
    const src = sessionSourceFromTrigger(BASE_TRIGGER);
    expect(src.kind).toBe('allocate');
    expect(src.trigger).toBe(BASE_TRIGGER);
  });

  it('returns pre_allocated when _preAllocatedStartResponse is set', () => {
    const trigger: WorkflowTrigger = {
      ...BASE_TRIGGER,
      _preAllocatedStartResponse: {
        continueToken: 'ct_abc',
        checkpointToken: 'ckpt_abc',
        isComplete: false,
        pending: { prompt: 'step 1 prompt', stepId: 's1' },
        preferences: undefined,
        nextIntent: undefined,
        nextCall: undefined,
      },
    };
    const src = sessionSourceFromTrigger(trigger);
    expect(src.kind).toBe('pre_allocated');
    if (src.kind !== 'pre_allocated') return;
    expect(src.session.continueToken).toBe('ct_abc');
    expect(src.session.checkpointToken).toBe('ckpt_abc');
    expect(src.session.firstStepPrompt).toBe('step 1 prompt');
    expect(src.session.isComplete).toBe(false);
    expect(src.session.triggerSource).toBe('daemon');
  });

  it('defaults triggerSource to daemon', () => {
    const trigger: WorkflowTrigger = {
      ...BASE_TRIGGER,
      _preAllocatedStartResponse: {
        continueToken: 'ct_x',
        isComplete: false,
        pending: { prompt: 'p', stepId: 's' },
        preferences: undefined,
        nextIntent: undefined,
        nextCall: undefined,
      },
    };
    const src = sessionSourceFromTrigger(trigger);
    if (src.kind !== 'pre_allocated') throw new Error('expected pre_allocated');
    expect(src.session.triggerSource).toBe('daemon');
  });

  it('respects explicit triggerSource mcp', () => {
    const trigger: WorkflowTrigger = {
      ...BASE_TRIGGER,
      _preAllocatedStartResponse: {
        continueToken: 'ct_y',
        isComplete: false,
        pending: { prompt: 'p', stepId: 's' },
        preferences: undefined,
        nextIntent: undefined,
        nextCall: undefined,
      },
    };
    const src = sessionSourceFromTrigger(trigger, 'mcp');
    if (src.kind !== 'pre_allocated') throw new Error('expected pre_allocated');
    expect(src.session.triggerSource).toBe('mcp');
  });

  it('handles absent continueToken with empty string fallback', () => {
    const trigger: WorkflowTrigger = {
      ...BASE_TRIGGER,
      _preAllocatedStartResponse: {
        continueToken: undefined,
        isComplete: true,
        pending: undefined,
        preferences: undefined,
        nextIntent: undefined,
        nextCall: undefined,
      },
    };
    const src = sessionSourceFromTrigger(trigger);
    if (src.kind !== 'pre_allocated') throw new Error('expected pre_allocated');
    expect(src.session.continueToken).toBe('');
    expect(src.session.firstStepPrompt).toBe('');
    expect(src.session.isComplete).toBe(true);
  });
});
