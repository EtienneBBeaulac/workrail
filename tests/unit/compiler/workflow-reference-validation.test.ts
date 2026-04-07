/**
 * Tests for workflow references structural validation in ValidationEngine.
 */
import { describe, it, expect } from 'vitest';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition, WorkflowReference } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(refs?: WorkflowReference[]): Workflow {
  const definition: WorkflowDefinition = {
    id: 'test-workflow',
    name: 'Test',
    description: 'Test workflow',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        title: 'Step 1',
        prompt: 'Do the thing.',
      },
    ],
    ...(refs !== undefined ? { references: refs } : {}),
  };
  return createWorkflow(definition, createBundledSource());
}

function makeEngine(): ValidationEngine {
  return new ValidationEngine(new EnhancedLoopValidator());
}

function validRef(overrides: Partial<WorkflowReference> = {}): WorkflowReference {
  return {
    id: 'api-schema',
    title: 'API Schema',
    source: './spec/api.json',
    purpose: 'Authoritative API contract',
    authoritative: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid references
// ---------------------------------------------------------------------------

describe('ValidationEngine.validateWorkflow — references valid', () => {
  it('accepts a workflow with well-formed references', () => {
    const wf = makeWorkflow([
      validRef(),
      validRef({ id: 'coding-guide', title: 'Coding Guide', source: './docs/guide.md', authoritative: false }),
    ]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(true);
  });

  it('accepts a workflow with no references field', () => {
    const wf = makeWorkflow();
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(true);
  });

  it('accepts a workflow with empty references array', () => {
    const wf = makeWorkflow([]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid references
// ---------------------------------------------------------------------------

describe('ValidationEngine.validateWorkflow — references invalid', () => {
  it('rejects duplicate reference IDs', () => {
    const wf = makeWorkflow([
      validRef({ id: 'dupe' }),
      validRef({ id: 'dupe', title: 'Another' }),
    ]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("duplicate id 'dupe'")]),
    );
  });

  it('rejects reference with empty id', () => {
    const wf = makeWorkflow([validRef({ id: '' } as any)]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('missing or empty id')]),
    );
  });

  it('rejects reference with empty source', () => {
    const wf = makeWorkflow([validRef({ source: '' } as any)]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('missing or empty source')]),
    );
  });

  it('rejects reference with empty title', () => {
    const wf = makeWorkflow([validRef({ title: '' } as any)]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('missing or empty title')]),
    );
  });

  it('rejects reference with empty purpose', () => {
    const wf = makeWorkflow([validRef({ purpose: '' } as any)]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('missing or empty purpose')]),
    );
  });

  it('rejects reference with non-boolean authoritative', () => {
    const wf = makeWorkflow([validRef({ authoritative: 'yes' } as any)]);
    const result = makeEngine().validateWorkflow(wf);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('non-boolean authoritative')]),
    );
  });
});
