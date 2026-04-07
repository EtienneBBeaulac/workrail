import { describe, it, expect, beforeEach } from 'vitest';
import { getCachedWorkflow, clearWorkflowObjectCacheForTesting } from '../../../src/mcp/handlers/v2-execution/workflow-object-cache.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';
import type { WorkflowHash } from '../../../src/v2/durable-core/ids/index.js';

// Minimal workflow definition for tests -- only fields required by the type.
function makeDefinition(id: string): WorkflowDefinition {
  return {
    id,
    name: `Workflow ${id}`,
    description: 'Test workflow',
    version: '1.0.0',
    steps: [],
  } as unknown as WorkflowDefinition;
}

function makeHash(suffix: string): WorkflowHash {
  return `sha256:${'a'.repeat(63)}${suffix}` as WorkflowHash;
}

describe('getCachedWorkflow', () => {
  beforeEach(() => {
    // Reset cache between tests to avoid cross-test state pollution.
    clearWorkflowObjectCacheForTesting();
  });

  it('returns the same object identity for the same hash on second call', () => {
    const hash = makeHash('0');
    const def = makeDefinition('wf-cache-test');

    const first = getCachedWorkflow(hash, def);
    const second = getCachedWorkflow(hash, def);

    // Strict identity -- same cached object, not a new one.
    expect(first).toBe(second);
  });

  it('returns an object structurally equivalent to createWorkflow with bundled source', () => {
    const hash = makeHash('1');
    const def = makeDefinition('wf-equivalence');

    const cached = getCachedWorkflow(hash, def);
    const direct = createWorkflow(def, createBundledSource());

    // Structural equivalence.
    expect(cached.definition).toBe(direct.definition);
    expect(cached.source.kind).toBe(direct.source.kind);
  });

  it('returns different objects for different hashes', () => {
    const hashA = makeHash('a');
    const hashB = makeHash('b');
    const defA = makeDefinition('wf-a');
    const defB = makeDefinition('wf-b');

    const a = getCachedWorkflow(hashA, defA);
    const b = getCachedWorkflow(hashB, defB);

    expect(a).not.toBe(b);
  });

  it('uses the first definition associated with a hash (hash is the cache key)', () => {
    // In production the definition never changes for a given hash (content-addressed).
    // This test verifies the cache key is the hash, not the definition reference.
    const hash = makeHash('c');
    const def = makeDefinition('wf-first');

    const first = getCachedWorkflow(hash, def);
    // Second call with same hash but different definition object (same content would be fine,
    // testing that the cached value is returned regardless of def argument).
    const defAlso = makeDefinition('wf-also');
    const second = getCachedWorkflow(hash, defAlso);

    // Should return the first cached object -- the second def argument is ignored.
    expect(second).toBe(first);
  });

  it('clearWorkflowObjectCacheForTesting allows re-creation after clear', () => {
    const hash = makeHash('d');
    const def = makeDefinition('wf-clear');

    const before = getCachedWorkflow(hash, def);
    clearWorkflowObjectCacheForTesting();
    const after = getCachedWorkflow(hash, def);

    // After clearing, a new object is created -- identity differs.
    expect(after).not.toBe(before);
    // But the values are structurally equivalent.
    expect(after.definition).toBe(def);
  });
});
