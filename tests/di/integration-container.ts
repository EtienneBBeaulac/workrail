import 'reflect-metadata';
import { container } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { initializeContainer, resetContainer } from '../../src/di/container.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import { StaticFeatureFlagProvider } from '../../src/config/feature-flags.js';

/**
 * Integration test container setup.
 *
 * PHILOSOPHY:
 * - Mock INFRASTRUCTURE (storage, HTTP, external APIs)
 * - Use REAL business logic services
 * - Verify production DI construction path
 *
 * WHY:
 * - Catches constructor injection bugs
 * - Tests real service collaboration
 * - Closer to production behavior
 *
 * WHEN TO USE:
 * - Testing workflows across multiple services
 * - Verifying service integration points
 * - Testing real ValidationEngine, LoopStackManager, etc.
 *
 * WHEN NOT TO USE:
 * - Testing a single function (use unit tests)
 * - Need very fast feedback (use unit tests)
 * - Testing error conditions requiring specific mocks
 */

export interface IntegrationTestConfig {
  /** Storage implementation (defaults to InMemoryWorkflowStorage) */
  storage?: any;

  /** Feature flags as plain object of boolean values */
  featureFlags?: Record<string, boolean>;

  /** Disable all session tools by default (HTTP server, etc.) */
  disableSessionTools?: boolean;
}

// Mutex to prevent race conditions from concurrent test setup
let initMutex: Promise<void> | null = null;

/**
 * Setup container for integration testing.
 *
 * Steps:
 * 1. Reset container (with mutex to prevent races)
 * 2. Initialize with REAL DI (all services constructed via TSyringe)
 * 3. Override ONLY infrastructure (storage, feature flags)
 *
 * Business logic services are NOT mocked:
 * - ValidationEngine
 * - LoopStackManager
 * - DefaultStepSelector
 * - IterativeStepResolutionStrategy
 * - DefaultWorkflowLoader
 */
export async function setupIntegrationTest(
  config: IntegrationTestConfig = {}
): Promise<void> {
  // Wait for any in-flight initialization to complete
  if (initMutex) {
    await initMutex;
  }

  // Acquire mutex for this initialization
  initMutex = (async () => {
    // Reset to clean state
    resetContainer();

    // Initialize container - imports and constructs ALL services
    await initializeContainer();

    // Override infrastructure AFTER initialization

    // 1. Storage (in-memory for speed, but behaves like real storage)
    const storage = config.storage ?? new InMemoryWorkflowStorage();
    container.register(DI.Storage.Primary, { useValue: storage });
    container.register(DI.Storage.Base, { useValue: storage });
    container.register(DI.Storage.Validated, { useValue: storage });

    // 2. Feature flags (predictable values for testing)
    const defaultFlags = {
      sessionTools: config.disableSessionTools !== false ? false : true,
      experimentalWorkflows: false,
      verboseLogging: false,
      agenticRoutines: false,
      ...(config.featureFlags || {}),
    };

    container.register(DI.Infra.FeatureFlags, {
      useValue: new StaticFeatureFlagProvider(defaultFlags),
    });

    // DO NOT override:
    // - DI.Infra.ValidationEngine (real business logic)
    // - DI.Services.StepSelector (real business logic)
    // - DI.Infra.LoopStackManager (real business logic)
    // - DI.Services.StepResolution (real business logic)
    // - DI.Services.WorkflowLoader (real business logic)
  })();

  await initMutex;
  initMutex = null;
}

/**
 * Cleanup after integration test.
 */
export function teardownIntegrationTest(): void {
  resetContainer();
}

/**
 * Resolve a service in integration tests.
 * Type-safe wrapper around container.resolve.
 */
export function resolveService<T>(token: symbol): T {
  const instance = container.resolve<T>(token);

  // Validate instance is not null (catches configuration errors)
  if (instance === null || instance === undefined) {
    throw new Error(`Resolved service is null/undefined for token ${String(token)}`);
  }

  return instance;
}
