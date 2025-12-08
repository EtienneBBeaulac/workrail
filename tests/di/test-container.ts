import 'reflect-metadata';
import { container, DependencyContainer } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { InMemoryWorkflowProvider } from '../../src/infrastructure/storage/in-memory-storage.js';
import { StaticFeatureFlagProvider, IFeatureFlagProvider } from '../../src/config/feature-flags.js';

/**
 * Test container configuration.
 * Only specify what you want to override - everything else uses real implementations.
 */
export interface TestConfig {
  storage?: any;
  /** Feature flags - can be a provider instance or a plain object of flag values */
  featureFlags?: IFeatureFlagProvider | Record<string, boolean>;
  mocks?: Record<symbol, any>;
}

/**
 * Setup container for testing.
 *
 * IMPORTANT: This resets the container, which clears all @singleton() registrations.
 * Services must be re-imported after reset.
 *
 * USAGE:
 * ```typescript
 * beforeEach(async () => {
 *   await setupTest({ storage: new InMemoryWorkflowStorage() });
 * });
 * ```
 */
export async function setupTest(config: TestConfig = {}): Promise<DependencyContainer> {
  // Reset container AND the initialized flag
  const { resetContainer, initializeContainer } = await import('../../src/di/container.js');
  resetContainer();

  // Register storage FIRST (before init - repository factory needs it)
  const storage = config.storage ?? new InMemoryWorkflowProvider();
  container.register(DI.Storage.Primary, { useValue: storage });
  container.register(DI.Storage.Base, { useValue: storage });
  container.register(DI.Storage.Validated, { useValue: storage });

  // Register config values  
  container.register(DI.Config.CacheTTL, { useValue: 0 }); // No cache in tests
  container.register(DI.Config.WorkflowDir, { useValue: '/tmp/test-workflows' });
  container.register(DI.Config.ProjectPath, { useValue: process.cwd() });
  
  // Force repository to skip persisted snapshot in tests
  process.env['WORKRAIL_SNAPSHOT_PATH'] = '/tmp/nonexistent-' + Date.now() + '.json';

  // Initialize container (imports services which self-register)
  await initializeContainer();

  // CRITICAL: Tests use in-memory storage, so repository should use that
  // The repository was already registered in initializeContainer() with EnhancedMultiSource
  // But we registered InMemoryWorkflowProvider as DI.Storage.Primary above
  // The repository factory resolves DI.Storage.Primary, so it should pick up our test storage
  // No need to override - the factory will use our registered storage!

  // Register feature flags
  if (config.featureFlags !== undefined) {
    const flags = 'isEnabled' in config.featureFlags 
      ? config.featureFlags as IFeatureFlagProvider
      : new StaticFeatureFlagProvider(config.featureFlags);
    container.register(DI.Infra.FeatureFlags, { useValue: flags });
  }

  // Apply custom mocks
  if (config.mocks) {
    for (const [token, mock] of Object.entries(config.mocks)) {
      container.register(token as symbol, { useValue: mock });
    }
  }

  // Initialize async services (repository, HTTP server, etc.)
  const { startAsyncServices } = await import('../../src/di/container.js');
  await startAsyncServices();

  return container;
}

/**
 * Cleanup after test.
 */
export function teardownTest(): void {
  container.reset();
}

/**
 * Resolve a service in tests.
 */
export function resolve<T>(token: symbol | any): T {
  return container.resolve<T>(token);
}
