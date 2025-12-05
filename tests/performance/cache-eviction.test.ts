import 'reflect-metadata';
import { describe, it, expect, beforeEach } from 'vitest';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { initializeContainer, resetContainer } from '../../src/di/container.js';

/**
 * Lightweight performance tests.
 *
 * Focus: Verify cache eviction policies work
 * Defer to v2: Comprehensive memory profiling, heap snapshots, GC analysis
 *
 * WHY THESE TESTS EXIST:
 * LoopStepResolver is a singleton with a cache. Before adding MAX_CACHE_SIZE,
 * this cache would grow unbounded, causing memory leaks in long-running
 * MCP servers.
 */
describe('[PERF] Cache Eviction (Lightweight)', () => {
  beforeEach(async () => {
    resetContainer();
    await initializeContainer();
  });

  it('LoopStepResolver cache respects MAX_CACHE_SIZE limit', async () => {
    const resolver = container.resolve<any>(DI.Infra.LoopStepResolver);
    const initialSize = resolver.getCacheSize();

    // Attempt to add 2000 entries (2× MAX_CACHE_SIZE of 1000)
    const workflows = [];
    for (let i = 0; i < 2000; i++) {
      workflows.push({
        id: `wf-${i}`,
        steps: [
          { id: 'step-a', title: 'A', prompt: 'Do A', agentRole: 'assistant' },
          { id: 'step-b', title: 'B', prompt: 'Do B', agentRole: 'assistant' },
        ],
      });
    }

    for (const wf of workflows) {
      try {
        // This caches the resolution
        resolver.resolveLoopBody(wf, 'step-a');
      } catch {
        // Expected to fail (step-a not a loop body), but cache still grows
      }
    }

    const finalSize = resolver.getCacheSize();
    const growth = finalSize - initialSize;

    console.log(`[PERF] Cache grew by ${growth} entries (max: 1000)`);

    // With FIFO eviction, cache should never exceed MAX_CACHE_SIZE
    expect(finalSize).toBeLessThanOrEqual(1000);
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

  it('cache grows predictably and stays bounded', async () => {
    const resolver = container.resolve<any>(DI.Infra.LoopStepResolver);

    // Clear cache to start fresh
    resolver.clearCache();
    expect(resolver.getCacheSize()).toBe(0);

    // Add exactly 500 entries
    for (let i = 0; i < 500; i++) {
      const wf = {
        id: `test-wf-${i}`,
        steps: [{ id: 'body', title: 'Body', prompt: 'Do it', agentRole: 'assistant' }],
      };
      try {
        resolver.resolveLoopBody(wf, 'body');
      } catch {
        // Expected
      }
    }

    const size500 = resolver.getCacheSize();
    expect(size500).toBeLessThanOrEqual(500);

    // Add 600 more (total 1100 attempted, should cap at 1000)
    for (let i = 500; i < 1100; i++) {
      const wf = {
        id: `test-wf-${i}`,
        steps: [{ id: 'body', title: 'Body', prompt: 'Do it', agentRole: 'assistant' }],
      };
      try {
        resolver.resolveLoopBody(wf, 'body');
      } catch {
        // Expected
      }
    }

    const sizeFinal = resolver.getCacheSize();
    console.log(`[PERF] Final cache size: ${sizeFinal} (attempted: 1100, max: 1000)`);

    // Should be capped at MAX_CACHE_SIZE
    expect(sizeFinal).toBeLessThanOrEqual(1000);

    // Eviction should have occurred
    expect(sizeFinal).toBeLessThan(1100);
  });
});
