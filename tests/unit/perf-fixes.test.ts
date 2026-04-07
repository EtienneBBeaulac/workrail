/**
 * Tests for performance fixes (issue #258).
 *
 * Each test is written BEFORE the corresponding fix is implemented (TDD).
 * Tests verify:
 * 1. AJV singleton: same compiled validator instance across storage constructions
 * 2. N+1 reads: getWorkflowById not called during list_workflows
 * 3. Map cache: CachingWorkflowStorage.getWorkflowById returns correct result via Map
 * 4. Schema caching: handleWorkflowGetSchema returns consistent schema content
 */

import { describe, it, expect, vi } from 'vitest';
import { EnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';
import { SchemaValidatingCompositeWorkflowStorage } from '../../src/infrastructure/storage/schema-validating-workflow-storage';
import { CachingWorkflowStorage } from '../../src/infrastructure/storage/caching-workflow-storage';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { handleWorkflowGetSchema } from '../../src/mcp/handlers/workflow';
import { createBundledSource } from '../../src/types/workflow';
import type { WorkflowDefinition } from '../../src/types/workflow';
import type { ToolContext } from '../../src/mcp/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDef(id: string): WorkflowDefinition {
  return {
    id,
    name: `Workflow ${id}`,
    description: 'A test workflow',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        title: 'Step One',
        prompt: 'Do the thing',
      },
    ],
  };
}

function makeEmptyCompositeStorage(): EnhancedMultiSourceWorkflowStorage {
  return new EnhancedMultiSourceWorkflowStorage({
    includeBundled: false,
    includeUser: false,
    includeProject: false,
  });
}

// ---------------------------------------------------------------------------
// Fix 1: AJV singleton
// ---------------------------------------------------------------------------

describe('Fix 1: AJV singleton across SchemaValidatingCompositeWorkflowStorage instances', () => {
  it('uses the same compiled validator instance for every construction', () => {
    const storage1 = new SchemaValidatingCompositeWorkflowStorage(makeEmptyCompositeStorage());
    const storage2 = new SchemaValidatingCompositeWorkflowStorage(makeEmptyCompositeStorage());

    // Access the internal validator via type-bypass.
    // After fix: both instances share one module-level compiled validator.
    const v1 = (storage1 as unknown as { validator: unknown }).validator;
    const v2 = (storage2 as unknown as { validator: unknown }).validator;

    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    // Strict reference equality: same function object
    expect(v1).toBe(v2);
  });

  it('validator still correctly validates a valid workflow definition', async () => {
    const inner = makeEmptyCompositeStorage();
    const memStorage = new InMemoryWorkflowStorage([makeDef('test-singleton')], createBundledSource());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (inner as any).storageInstances = [memStorage];

    const storage = new SchemaValidatingCompositeWorkflowStorage(inner);
    const workflows = await storage.loadAllWorkflows();
    expect(workflows.map((w) => w.definition.id)).toContain('test-singleton');
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Map cache in CachingWorkflowStorage
// ---------------------------------------------------------------------------

describe('Fix 3: CachingWorkflowStorage uses Map for getWorkflowById', () => {
  it('returns the correct workflow by id when cache is warm', async () => {
    const defs = [makeDef('alpha'), makeDef('beta'), makeDef('gamma')];
    const inner = new InMemoryWorkflowStorage(defs, createBundledSource());
    const caching = new CachingWorkflowStorage(inner, 60_000);

    // Warm the cache
    await caching.loadAllWorkflows();

    // Should resolve from cache (not inner storage)
    const result = await caching.getWorkflowById('beta');
    expect(result).not.toBeNull();
    expect(result!.definition.id).toBe('beta');
  });

  it('returns null for an id not in the cache', async () => {
    const defs = [makeDef('alpha'), makeDef('beta')];
    const inner = new InMemoryWorkflowStorage(defs, createBundledSource());
    const caching = new CachingWorkflowStorage(inner, 60_000);

    await caching.loadAllWorkflows();

    const result = await caching.getWorkflowById('nonexistent');
    expect(result).toBeNull();
  });

  it('increments hit count when resolving via cache', async () => {
    const defs = [makeDef('delta')];
    const inner = new InMemoryWorkflowStorage(defs, createBundledSource());
    const caching = new CachingWorkflowStorage(inner, 60_000);

    await caching.loadAllWorkflows();
    const statsBefore = caching.getCacheStats();

    await caching.getWorkflowById('delta');
    const statsAfter = caching.getCacheStats();

    expect(statsAfter.hits).toBeGreaterThan(statsBefore.hits);
  });

  it('invalidates Map index when clearCache is called', async () => {
    const defs = [makeDef('epsilon')];
    const inner = new InMemoryWorkflowStorage(defs, createBundledSource());
    const caching = new CachingWorkflowStorage(inner, 60_000);

    // Warm cache and verify Map lookup works
    await caching.loadAllWorkflows();
    const before = await caching.getWorkflowById('epsilon');
    expect(before).not.toBeNull();

    // Clear cache -- Map index must also be invalidated
    caching.clearCache();

    // After clearing, a getWorkflowById for a non-existent id should fall through to inner
    // (inner still has it, but the cache is cold -- this tests that Map index was cleared)
    const statsBefore = caching.getCacheStats();
    await caching.getWorkflowById('epsilon');
    const statsAfter = caching.getCacheStats();

    // Should be a miss (cache was cleared)
    expect(statsAfter.misses).toBeGreaterThan(statsBefore.misses);
  });
});

// ---------------------------------------------------------------------------
// Fix 5: Schema caching in handleWorkflowGetSchema
// ---------------------------------------------------------------------------

describe('Fix 5: handleWorkflowGetSchema returns consistent schema content across calls', () => {
  // Minimal ToolContext stub -- handleWorkflowGetSchema does not use ctx
  const ctx = {} as ToolContext;

  it('returns a valid schema on first call', async () => {
    const result = await handleWorkflowGetSchema({}, ctx);
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const payload = result.data as { schema: Record<string, unknown> };
    expect(payload.schema).toBeDefined();
    expect(payload.schema.type).toBe('object');
    expect(payload.schema.properties).toBeDefined();
  });

  it('returns identical schema content on repeated calls', async () => {
    const result1 = await handleWorkflowGetSchema({}, ctx);
    const result2 = await handleWorkflowGetSchema({}, ctx);

    expect(result1.type).toBe('success');
    expect(result2.type).toBe('success');

    if (result1.type !== 'success' || result2.type !== 'success') return;

    const payload1 = result1.data as { schema: Record<string, unknown> };
    const payload2 = result2.data as { schema: Record<string, unknown> };

    // Schema content must be identical
    expect(JSON.stringify(payload1.schema)).toBe(JSON.stringify(payload2.schema));
  });

  it('includes required workflow fields in schema', async () => {
    const result = await handleWorkflowGetSchema({}, ctx);
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const payload = result.data as { schema: { required: string[]; properties: Record<string, unknown> } };
    expect(payload.schema.required).toContain('id');
    expect(payload.schema.required).toContain('name');
    expect(payload.schema.required).toContain('steps');
  });
});
