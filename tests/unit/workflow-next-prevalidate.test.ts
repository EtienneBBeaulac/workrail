import { describe, it, expect } from 'vitest';
import { preValidateWorkflowNextArgs } from '../../src/mcp/validation/workflow-next-prevalidate.js';

function byteLen(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

describe('workflow_next pre-validation (error UX only)', () => {
  it('returns a bounded correctTemplate when state is missing', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'w' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.correctTemplate).toBeTruthy();
    expect(byteLen(r.correctTemplate)).toBeLessThanOrEqual(512);
  });

  it('returns a bounded correctTemplate when state.kind is missing', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'w', state: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.correctTemplate).toEqual({ kind: 'init' });
    expect(byteLen(r.correctTemplate)).toBeLessThanOrEqual(512);
  });

  it('returns a bounded correctTemplate when running state is missing required arrays', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'w', state: { kind: 'running' } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(r.code).toBe('VALIDATION_ERROR');
    expect(r.correctTemplate).toEqual({ kind: 'running', completed: [], loopStack: [] });
    expect(byteLen(r.correctTemplate)).toBeLessThanOrEqual(512);
  });

  it('normalizes workflowId in templates to stay bounded', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'x'.repeat(1000) });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(byteLen(r.correctTemplate)).toBeLessThanOrEqual(512);
    expect((r.correctTemplate as any).workflowId).toBe('<workflowId>');
  });
});
