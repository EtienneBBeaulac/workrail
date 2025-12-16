import { describe, it, expect } from 'vitest';
import {
  JsonValueSchema,
  WorkflowGetOutputSchema,
  WorkflowNextOutputSchema,
  ReadSessionOutputSchema,
} from '../../src/mcp/output-schemas.js';
import { initialExecutionState } from '../../src/domain/execution/state.js';

describe('MCP output schemas (hard boundary)', () => {
  it('rejects undefined in JSON-safe payloads', () => {
    expect(() => JsonValueSchema.parse(undefined)).toThrow();
    expect(() => WorkflowGetOutputSchema.parse({ workflow: undefined })).toThrow();
    expect(() => ReadSessionOutputSchema.parse({ query: 'x' })).toThrow();
  });

  it('accepts JSON-safe workflow_next output shape', () => {
    const ok1 = WorkflowNextOutputSchema.parse({
      state: initialExecutionState(),
      next: null,
      isComplete: false,
    });
    expect(ok1.state.kind).toBe('init');

    const ok2 = WorkflowNextOutputSchema.parse({
      state: { kind: 'complete' as const },
      next: { stepId: 'x', nested: ['a', 1, true, null] },
      isComplete: true,
    });
    expect(ok2.isComplete).toBe(true);
  });
});
