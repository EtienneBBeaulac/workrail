import { describe, it, expect } from 'vitest';
import type { SessionSource, AllocatedSession, WorkflowTrigger } from '../../src/daemon/workflow-runner.js';

const BASE_TRIGGER: WorkflowTrigger = {
  workflowId: 'wr.coding-task',
  goal: 'test goal',
  workspacePath: '/workspace',
};

const ALLOCATED_SESSION: AllocatedSession = {
  continueToken: 'ct_abc',
  checkpointToken: 'ckpt_abc',
  firstStepPrompt: 'step 1',
  isComplete: false,
  triggerSource: 'daemon',
};

describe('SessionSource discriminated union', () => {
  it('allocate variant carries trigger', () => {
    const src: SessionSource = { kind: 'allocate', trigger: BASE_TRIGGER };
    expect(src.kind).toBe('allocate');
    expect(src.trigger).toBe(BASE_TRIGGER);
  });

  it('pre_allocated variant carries trigger and session', () => {
    const src: SessionSource = { kind: 'pre_allocated', trigger: BASE_TRIGGER, session: ALLOCATED_SESSION };
    expect(src.kind).toBe('pre_allocated');
    if (src.kind !== 'pre_allocated') return;
    expect(src.session.continueToken).toBe('ct_abc');
    expect(src.session.triggerSource).toBe('daemon');
  });

  it('TypeScript discriminant narrows correctly', () => {
    const src: SessionSource = { kind: 'pre_allocated', trigger: BASE_TRIGGER, session: ALLOCATED_SESSION };
    // This test documents that the union is exhaustive -- a switch on src.kind
    // with both arms compiles without a default case.
    let seen: string | undefined;
    switch (src.kind) {
      case 'allocate': seen = 'allocate'; break;
      case 'pre_allocated': seen = 'pre_allocated'; break;
    }
    expect(seen).toBe('pre_allocated');
  });

  it('AllocatedSession triggerSource distinguishes daemon from mcp', () => {
    const daemonSession: AllocatedSession = { ...ALLOCATED_SESSION, triggerSource: 'daemon' };
    const mcpSession: AllocatedSession = { ...ALLOCATED_SESSION, triggerSource: 'mcp' };
    expect(daemonSession.triggerSource).toBe('daemon');
    expect(mcpSession.triggerSource).toBe('mcp');
  });
});
