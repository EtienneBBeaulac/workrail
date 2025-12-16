import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { initializeContainer, resetContainer } from '../../src/di/container.js';

/**
 * Lightweight performance tests.
 *
 * Focus: verify *bounded* caches stay bounded under churn.
 * Defer to v2: comprehensive memory profiling, heap snapshots, GC analysis.
 *
 * WHY THIS EXISTS:
 * We previously had an unbounded cache in loop runtime code. The new architecture
 * keeps compilation artifacts in a bounded cache to avoid memory growth in long-running
 * MCP servers.
 */
describe('[PERF] Cache Eviction (Lightweight)', () => {
  beforeEach(async () => {
    resetContainer();
    await initializeContainer();
  });

  it('WorkflowService compilation cache stays bounded under churn', async () => {
    const workflowService = container.resolve<any>(DI.Services.Workflow);

    // Best-effort introspection (explicit debug hook)
    expect(typeof workflowService.__debugCompiledCacheSize).toBe('function');

    const MAX = 1000;
    const state = { kind: 'init' };

    // Drive compilation of many unique workflow IDs (these will be misses and should evict)
    for (let i = 0; i < 2000; i++) {
      const id = `perf-wf-${i}`;
      // We expect "workflow_not_found" errors for unknown IDs; cache should not grow from failures.
      // So we also compile a tiny in-memory workflow by poking the internal cache via a debug hook.
      workflowService.__debugPrimeCompiledWorkflow?.(id);
      await workflowService.getNextStep(id, state).catch(() => {});
    }

    const size = workflowService.__debugCompiledCacheSize();
    console.log(`[PERF] Compiled workflow cache size: ${size} (max: ${MAX})`);
    expect(size).toBeLessThanOrEqual(MAX);
  });

  it('singleton services do not proliferate under repeated resolution', async () => {
    const instances = new Set();

    // Resolve 1000 times
    for (let i = 0; i < 1000; i++) {
      const service = container.resolve(DI.Services.Workflow);
      instances.add(service);
    }

    // Should only ever have ONE unique instance
    expect(instances.size).toBe(1);
  });

  it('singleton services do not proliferate under repeated resolution', async () => {
    const instances = new Set();

    // Resolve 1000 times
    for (let i = 0; i < 1000; i++) {
      const service = container.resolve(DI.Services.Workflow);
      instances.add(service);
    }

    // Should only ever have ONE unique instance
    expect(instances.size).toBe(1);
  });
});
