import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { initializeContainer, resetContainer } from '../../src/di/container.js';

/**
 * Smoke tests for DI container health.
 *
 * These tests verify:
 * - All services can be constructed via DI
 * - No constructor injection failures
 * - No circular dependencies
 * - Singleton behavior works correctly
 *
 * Run time target: < 5 seconds total
 *
 * WHY THESE TESTS EXIST:
 * These tests would have caught 2 critical production bugs:
 * 1. EnvironmentFeatureFlagProvider injection failure (default param issue)
 * 2. HttpServer injection failure (default param issue)
 *
 * Regular integration tests missed these because they use useValue (pre-built mocks)
 * which bypasses TSyringe's constructor injection.
 */
describe('[SMOKE] DI Container Health', () => {
  beforeEach(() => resetContainer());
  afterEach(() => resetContainer());

  it('resolves ALL registered DI tokens without error', async () => {
    await initializeContainer();

    // Extract all tokens from DI namespace
    // Note: Can't use Object.entries() on Symbols
    const allTokens: Array<{ name: string; token: symbol }> = [];

    for (const namespaceKey of Object.keys(DI)) {
      const namespace = DI[namespaceKey as keyof typeof DI];
      for (const tokenKey of Object.keys(namespace)) {
        const token = namespace[tokenKey as keyof typeof namespace];
        allTokens.push({
          name: `${namespaceKey}.${tokenKey}`,
          token: token as symbol,
        });
      }
    }

    console.log(`[SMOKE] Testing ${allTokens.length} DI tokens...`);

    // Collect ALL errors instead of throwing on first failure
    // This provides better debugging - see all broken services at once
    const failures: Array<{ name: string; error: string }> = [];

    for (const { name, token } of allTokens) {
      try {
        const instance = container.resolve(token);

        // Verify instance is not null/undefined
        if (instance === null || instance === undefined) {
          failures.push({ name, error: 'Resolved to null/undefined' });
        }
      } catch (error: any) {
        failures.push({ name, error: error.message });
      }
    }

    // Report all failures at once for easier debugging
    if (failures.length > 0) {
      const errorReport = failures
        .map((f) => `  ❌ ${f.name}: ${f.error}`)
        .join('\n');

      throw new Error(
        `[SMOKE] Failed to resolve ${failures.length}/${allTokens.length} services:\n${errorReport}\n\n` +
          `Common causes:\n` +
          `  - Missing @singleton() decorator\n` +
          `  - Missing @inject() on constructor parameters\n` +
          `  - Default parameters with interface types\n` +
          `  - Circular dependencies\n`
      );
    }

    console.log(`[SMOKE] ✅ All ${allTokens.length} services resolved successfully`);
  });

  it('singleton services return same instance', async () => {
    await initializeContainer();

    // Test critical singletons
    const singletonTests = [
      { name: 'WorkflowService', token: DI.Services.Workflow },
      { name: 'FeatureFlags', token: DI.Infra.FeatureFlags },
      { name: 'ValidationEngine', token: DI.Infra.ValidationEngine },
      { name: 'Storage', token: DI.Storage.Primary },
      { name: 'LoopStackManager', token: DI.Infra.LoopStackManager },
    ];

    for (const { name, token } of singletonTests) {
      const instance1 = container.resolve(token);
      const instance2 = container.resolve(token);

      expect(instance1).toBe(
        instance2,
        `${name} should be singleton but got different instances`
      );
    }
  });

  it('container can be reset and re-initialized without errors', async () => {
    // First initialization
    await initializeContainer();
    const service1 = container.resolve(DI.Services.Workflow);
    expect(service1).toBeDefined();

    // Reset
    resetContainer();

    // Second initialization
    await initializeContainer();
    const service2 = container.resolve(DI.Services.Workflow);
    expect(service2).toBeDefined();

    // Both should work
  });

  it('no circular dependencies in dependency graph', async () => {
    await initializeContainer();

    // Proper timeout implementation with cleanup
    let timeoutId: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Resolution timeout (5s) - likely circular dependency'));
      }, 5000);
    });

    try {
      const resolution = Promise.all([
        container.resolve(DI.Services.Workflow),
        container.resolve(DI.Services.StepResolution),
        container.resolve(DI.Infra.LoopStackManager),
        container.resolve(DI.Infra.ValidationEngine),
        container.resolve(DI.Infra.FeatureFlags),
      ]);

      await Promise.race([resolution, timeout]);
      clearTimeout(timeoutId!);
    } catch (error: any) {
      clearTimeout(timeoutId!);
      throw error;
    }
  });

  it('services implement required interface methods', async () => {
    await initializeContainer();

    const workflowService = container.resolve<any>(DI.Services.Workflow);

    // Verify interface contract (runtime duck-typing check)
    const requiredMethods = [
      'listWorkflowSummaries',
      'getWorkflowById',
      'getNextStep',
      'validateStepOutput',
    ];

    for (const method of requiredMethods) {
      expect(
        typeof workflowService[method],
        `WorkflowService missing required method: ${method}`
      ).toBe('function');
    }
  });

  it('optional services handle missing dependencies gracefully', async () => {
    await initializeContainer();

    // LoopStackManager has optional contextOptimizer
    const stackManager = container.resolve<any>(DI.Infra.LoopStackManager);
    expect(stackManager).toBeDefined();

    // Should work even if contextOptimizer is undefined
  });

  it('configuration values are registered correctly', async () => {
    await initializeContainer();

    const cacheTTL = container.resolve<number>(DI.Config.CacheTTL);
    const workflowDir = container.resolve<string>(DI.Config.WorkflowDir);
    const projectPath = container.resolve<string>(DI.Config.ProjectPath);

    expect(typeof cacheTTL).toBe('number');
    expect(typeof workflowDir).toBe('string');
    expect(typeof projectPath).toBe('string');

    // Verify values are sensible
    expect(cacheTTL).toBeGreaterThanOrEqual(0);
    expect(workflowDir).toBeTruthy();
    expect(projectPath).toBeTruthy();
  });

  it('storage decorator chain is constructed correctly', async () => {
    await initializeContainer();

    const primary = container.resolve(DI.Storage.Primary);
    const base = container.resolve(DI.Storage.Base);
    const validated = container.resolve(DI.Storage.Validated);

    // All should be defined
    expect(primary).toBeDefined();
    expect(base).toBeDefined();
    expect(validated).toBeDefined();

    // Primary and base should be different (decorator wrapping)
    expect(primary).not.toBe(base);
  });
});
