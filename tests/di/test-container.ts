import 'reflect-metadata';
import { container, DependencyContainer } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import { StaticFeatureFlagProvider, IFeatureFlagProvider } from '../../src/config/feature-flags.js';
import type {
  AppConfig,
  CacheTtlMs,
  DashboardPort,
  ProjectPath,
  ValidatedConfig,
  WorkflowDir,
} from '../../src/config/app-config.js';
import { createValidatedConfig } from '../../src/config/app-config.js';

/**
 * Test container configuration.
 * Only specify what you want to override - everything else uses real implementations.
 */
export interface TestConfig {
  storage?: any;
  /** Feature flags - can be a provider instance or a plain object of flag values */
  featureFlags?: IFeatureFlagProvider | Record<string, boolean>;
  /** Application configuration override */
  appConfig?: AppConfig;
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

  // Register validated config FIRST so DI composition root won't overwrite it.
  // (Errors as data: config is "valid by construction" in tests.)
  const defaultAppConfig: AppConfig = {
    cache: { ttlMs: 0 as CacheTtlMs },
    paths: {
      workflowDir: '/tmp/test-workflows' as WorkflowDir,
      projectPath: process.cwd() as ProjectPath,
    },
    dashboard: {
      mode: { kind: 'legacy' },
      browserBehavior: { kind: 'manual' },
      port: 3456 as DashboardPort,
    },
  };

  const validated: ValidatedConfig = createValidatedConfig(config.appConfig ?? defaultAppConfig);
  container.register<ValidatedConfig>(DI.Config.App, { useValue: validated });

  // Backward compatibility tokens used by legacy services/tests
  container.register(DI.Config.CacheTTL, { useValue: validated.cache.ttlMs });
  container.register(DI.Config.WorkflowDir, { useValue: validated.paths.workflowDir });
  container.register(DI.Config.ProjectPath, { useValue: validated.paths.projectPath });
  container.register(DI.Config.DashboardMode, { useValue: validated.dashboard.mode });
  container.register(DI.Config.BrowserBehavior, { useValue: validated.dashboard.browserBehavior });

  // Initialize container (imports services which self-register)
  await initializeContainer({ runtimeMode: { kind: 'test' } });

  // NOW override with mocks AFTER services are registered
  // This ensures test mocks take precedence
  
  // Register storage (mock or real)
  const storage = config.storage ?? new InMemoryWorkflowStorage();
  container.register(DI.Storage.Primary, { useValue: storage });
  container.register(DI.Storage.Base, { useValue: storage });
  container.register(DI.Storage.Validated, { useValue: storage });

  // Register feature flags
  if (config.featureFlags !== undefined) {
    // If already a provider instance, use it directly; otherwise wrap in StaticFeatureFlagProvider
    const flags = 'isEnabled' in config.featureFlags 
      ? config.featureFlags as IFeatureFlagProvider
      : new StaticFeatureFlagProvider(config.featureFlags);
    // Override the symbol token (primary registration)
    container.register(DI.Infra.FeatureFlags, { useValue: flags });
  }

  // Apply custom mocks
  if (config.mocks) {
    for (const [token, mock] of Object.entries(config.mocks)) {
      container.register(token as symbol, { useValue: mock });
    }
  }

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
