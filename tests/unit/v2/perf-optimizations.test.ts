/**
 * Tests for inline performance optimizations in v2 execution handlers.
 *
 * Why these tests exist:
 * - deriveWorkflowHashRef deduplication: ensures the pure function is deterministic
 *   so computing once and reusing the result is safe.
 * - pinnedStore.get deduplication: ensures loadAndPinWorkflow calls get() only once
 *   when a pin already exists, avoiding a redundant disk read.
 */
import { describe, it, expect, vi } from 'vitest';
import { okAsync } from 'neverthrow';
import { deriveWorkflowHashRef } from '../../../src/v2/durable-core/ids/workflow-hash-ref.js';
import type { WorkflowHash } from '../../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// deriveWorkflowHashRef determinism
// ---------------------------------------------------------------------------

describe('deriveWorkflowHashRef determinism (dedup safety)', () => {
  it('returns the same value for the same hash on multiple calls', () => {
    const hash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11' as WorkflowHash;

    const r1 = deriveWorkflowHashRef(hash);
    const r2 = deriveWorkflowHashRef(hash);
    const r3 = deriveWorkflowHashRef(hash);

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    expect(r3.isOk()).toBe(true);

    // Same input always produces the same output -- safe to compute once and reuse.
    expect(String(r1._unsafeUnwrap())).toBe(String(r2._unsafeUnwrap()));
    expect(String(r1._unsafeUnwrap())).toBe(String(r3._unsafeUnwrap()));
  });

  it('returns different values for different hashes', () => {
    const hashA = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11' as WorkflowHash;
    const hashB = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as WorkflowHash;

    const rA = deriveWorkflowHashRef(hashA);
    const rB = deriveWorkflowHashRef(hashB);

    expect(rA.isOk()).toBe(true);
    expect(rB.isOk()).toBe(true);
    expect(String(rA._unsafeUnwrap())).not.toBe(String(rB._unsafeUnwrap()));
  });

  it('returns an error for an invalid hash format', () => {
    const bad = 'not-a-hash' as WorkflowHash;
    const r = deriveWorkflowHashRef(bad);
    expect(r.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pinnedStore.get call count (double-get elimination)
// ---------------------------------------------------------------------------

describe('loadAndPinWorkflow -- pinnedStore.get call count', () => {
  it('calls pinnedStore.get only once when the pin already exists', async () => {
    // This test uses a spy on a minimal fake pinnedStore to verify that
    // when existingPinned is returned from the first get(), the implementation
    // does not perform a second get() call.

    const { loadAndPinWorkflow } = await import(
      '../../../src/mcp/handlers/v2-execution/start.js'
    );
    const { createTestValidationPipelineDeps } = await import(
      '../../helpers/v2-test-helpers.js'
    );
    const { workflowHashForCompiledSnapshot } = await import(
      '../../../src/v2/durable-core/canonical/hashing.js'
    );
    const { NodeSha256V2 } = await import(
      '../../../src/v2/infra/local/sha256/index.js'
    );

    const sha256Port = new NodeSha256V2();

    // Use real validation pipeline deps so schema/structural validation passes.
    const validationPipelineDeps = createTestValidationPipelineDeps();

    // A real workflow definition that passes Phase 1a validation.
    const fakeWorkflow = {
      definition: {
        id: 'perf-test-wf',
        name: 'Perf Test',
        description: 'Performance optimization test workflow',
        version: '1.0.0',
        steps: [
          {
            id: 'step-1',
            title: 'Step 1',
            prompt: 'Do the thing',
          },
        ],
      },
      source: { kind: 'bundled' as const },
    };

    const fakeWorkflowReader = {
      getWorkflowById: vi.fn().mockResolvedValue(fakeWorkflow),
    };

    // The spy tracks how many times get() is called.
    let getCallCount = 0;
    const pinnedSnapshot = {
      v: 1 as const,
      sourceKind: 'v1_pinned' as const,
      workflowId: 'perf-test-wf',
      definition: fakeWorkflow.definition,
      resolvedBindings: {},
      pinnedOverrides: {},
      compiledWorkflow: { v: 1, workflowId: 'perf-test-wf', nodes: {}, edges: [], metadata: {} },
      resolvedReferences: [],
    };
    const fakePinnedStore = {
      // get() returns a ResultAsync -- the port contract requires it.
      get: vi.fn().mockImplementation((_hash: unknown) => {
        getCallCount++;
        // Always simulate a pre-existing pin so the short-circuit path is taken.
        return okAsync(pinnedSnapshot);
      }),
      put: vi.fn().mockImplementation(() => okAsync(undefined)),
    };

    const result = await loadAndPinWorkflow({
      workflowId: 'perf-test-wf',
      workflowReader: fakeWorkflowReader,
      crypto: sha256Port,
      pinnedStore: fakePinnedStore as never,
      validationPipelineDeps,
      workspacePath: '/tmp',
      resolvedRootUris: [],
    });

    // Primary assertion: get() must be called exactly once when the pin exists.
    // Before the fix, get() was called twice (once to check, once unconditionally after put).
    expect(getCallCount).toBe(1);
    void result; // result shape is not under test here
  });

  it('calls pinnedStore.get twice and put once on the cold path (no pre-existing pin)', async () => {
    // Cold path: the first get() returns null, so the implementation must call put()
    // to persist the new pin, then call get() a second time to retrieve it.

    const { loadAndPinWorkflow } = await import(
      '../../../src/mcp/handlers/v2-execution/start.js'
    );
    const { createTestValidationPipelineDeps } = await import(
      '../../helpers/v2-test-helpers.js'
    );
    const { workflowHashForCompiledSnapshot } = await import(
      '../../../src/v2/durable-core/canonical/hashing.js'
    );
    const { NodeSha256V2 } = await import(
      '../../../src/v2/infra/local/sha256/index.js'
    );

    const sha256Port = new NodeSha256V2();
    const validationPipelineDeps = createTestValidationPipelineDeps();

    const fakeWorkflow = {
      definition: {
        id: 'perf-test-wf-cold',
        name: 'Perf Test Cold',
        description: 'Performance optimization cold-path test workflow',
        version: '1.0.0',
        steps: [
          {
            id: 'step-1',
            title: 'Step 1',
            prompt: 'Do the thing',
          },
        ],
      },
      source: { kind: 'bundled' as const },
    };

    const fakeWorkflowReader = {
      getWorkflowById: vi.fn().mockResolvedValue(fakeWorkflow),
    };

    const pinnedSnapshot = {
      v: 1 as const,
      sourceKind: 'v1_pinned' as const,
      workflowId: 'perf-test-wf-cold',
      definition: fakeWorkflow.definition,
      resolvedBindings: {},
      pinnedOverrides: {},
      compiledWorkflow: { v: 1, workflowId: 'perf-test-wf-cold', nodes: {}, edges: [], metadata: {} },
      resolvedReferences: [],
    };

    let getCallCount = 0;
    let putCallCount = 0;
    const fakePinnedStore = {
      get: vi.fn().mockImplementation((_hash: unknown) => {
        getCallCount++;
        // First call returns null (cold path); subsequent calls return the snapshot.
        return okAsync(getCallCount === 1 ? null : pinnedSnapshot);
      }),
      put: vi.fn().mockImplementation(() => {
        putCallCount++;
        return okAsync(undefined);
      }),
    };

    const result = await loadAndPinWorkflow({
      workflowId: 'perf-test-wf-cold',
      workflowReader: fakeWorkflowReader,
      crypto: sha256Port,
      pinnedStore: fakePinnedStore as never,
      validationPipelineDeps,
      workspacePath: '/tmp',
      resolvedRootUris: [],
    });

    // On the cold path: get() called once to check (returns null), put() called once
    // to persist, then get() called again to retrieve -- total 2 gets and 1 put.
    expect(getCallCount).toBe(2);
    expect(putCallCount).toBe(1);

    // Verify the returned workflow has the expected shape so we know the cold path
    // actually yields a usable object, not just the right call counts.
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.workflow.definition.id).toBe('perf-test-wf-cold');
    }
  });
});
