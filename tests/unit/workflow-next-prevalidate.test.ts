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

    expect(r.error.code).toBe('VALIDATION_ERROR');
    const correctTemplate = (r.error.details as any)?.correctTemplate;
    expect(correctTemplate).toBeTruthy();
    expect(byteLen(correctTemplate)).toBeLessThanOrEqual(512);
  });

  it('returns a bounded correctTemplate when state.kind is missing', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'w', state: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(r.error.code).toBe('VALIDATION_ERROR');
    const correctTemplate = (r.error.details as any)?.correctTemplate;
    expect(correctTemplate).toEqual({ kind: 'init' });
    expect(byteLen(correctTemplate)).toBeLessThanOrEqual(512);
  });

  it('returns a bounded correctTemplate when running state is missing required arrays', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'w', state: { kind: 'running' } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(r.error.code).toBe('VALIDATION_ERROR');
    const correctTemplate = (r.error.details as any)?.correctTemplate;
    expect(correctTemplate).toEqual({ kind: 'running', completed: [], loopStack: [] });
    expect(byteLen(correctTemplate)).toBeLessThanOrEqual(512);
  });

  it('normalizes workflowId in templates to stay bounded', () => {
    const r = preValidateWorkflowNextArgs({ workflowId: 'x'.repeat(1000) });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    const correctTemplate = (r.error.details as any)?.correctTemplate;
    expect(byteLen(correctTemplate)).toBeLessThanOrEqual(512);
    expect((correctTemplate as any)?.workflowId).toBe('<workflowId>');
  });

  it('detects variables used instead of context and suggests context', () => {
    const r = preValidateWorkflowNextArgs({
      workflowId: 'w',
      state: { kind: 'init' },
      variables: { foo: 'bar' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');

    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(r.error.message).toContain('variables');
    const correctTemplate = (r.error.details as any)?.correctTemplate;
    expect(correctTemplate).toBeTruthy();
    expect((correctTemplate as any)?.context).toEqual({ foo: 'bar' });
    expect(byteLen(correctTemplate)).toBeLessThanOrEqual(512);
  });
});
