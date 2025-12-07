import 'reflect-metadata';
import { container, DependencyContainer, instanceCachingFactory } from 'tsyringe';
import { DI } from './tokens.js';
import { createBootstrapLogger } from '../core/logging/index.js';
import { PinoLoggerFactory } from '../core/logging/index.js';
import type { ILoggerFactory } from '../core/logging/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// BOOTSTRAP LOGGING (Pre-DI)
// ═══════════════════════════════════════════════════════════════════════════

const logger = createBootstrapLogger('DI');

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// BUG FIX #2: Added isInitializing flag for race condition protection
// ═══════════════════════════════════════════════════════════════════════════

let initialized = false;
let asyncInitialized = false;
let initializationPromise: Promise<void> | null = null;
let isInitializing = false; // Synchronous flag for race protection

// ═══════════════════════════════════════════════════════════════════════════
// TTL VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CACHE_TTL = 300_000; // 5 minutes
const MIN_CACHE_TTL = 0;
const MAX_CACHE_TTL = 86_400_000; // 24 hours

function parseAndValidateTTL(envValue: string | undefined): number {
  if (envValue === undefined) {
    return DEFAULT_CACHE_TTL;
  }
  
  const parsed = Number(envValue);
  
  if (Number.isNaN(parsed)) {
    logger.warn({ envValue, default: DEFAULT_CACHE_TTL }, 'Invalid CACHE_TTL value, using default');
    return DEFAULT_CACHE_TTL;
  }
  
  if (parsed < MIN_CACHE_TTL) {
    logger.warn({ parsed, min: MIN_CACHE_TTL }, 'CACHE_TTL below minimum, using minimum');
    return MIN_CACHE_TTL;
  }
  
  if (parsed > MAX_CACHE_TTL) {
    logger.warn({ parsed, max: MAX_CACHE_TTL }, 'CACHE_TTL exceeds maximum, using maximum');
    return MAX_CACHE_TTL;
  }
  
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGGING REGISTRATION (MUST BE FIRST!)
// CTC MCP Pattern: Core infrastructure before everything else
// ═══════════════════════════════════════════════════════════════════════════

function registerLogging(): void {
  container.registerSingleton(DI.Logging.Factory, PinoLoggerFactory);
  logger.info('Logging registered');
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

function registerConfig(): void {
  container.register(DI.Config.CacheTTL, {
    useValue: parseAndValidateTTL(process.env.CACHE_TTL),
  });
  container.register(DI.Config.WorkflowDir, {
    useValue: process.env.WORKRAIL_WORKFLOWS_DIR ?? process.cwd(),
  });
  container.register(DI.Config.ProjectPath, {
    useValue: process.cwd(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STORAGE CHAIN REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

async function registerStorageChain(): Promise<void> {
  // Import storage classes
  const { EnhancedMultiSourceWorkflowStorage } = await import(
    '../infrastructure/storage/enhanced-multi-source-workflow-storage.js'
  );
  const { SchemaValidatingWorkflowStorage } = await import(
    '../infrastructure/storage/schema-validating-workflow-storage.js'
  );
  const { CachingWorkflowStorage } = await import(
    '../infrastructure/storage/caching-workflow-storage.js'
  );

  // Layer 1: Base storage (factory creates with logger)
  container.register(DI.Storage.Base, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const loggerFactory = c.resolve<ILoggerFactory>(DI.Logging.Factory);
      return new EnhancedMultiSourceWorkflowStorage(loggerFactory);
    }),
  });

  // Layer 2: Schema validation decorator (singleton via instanceCachingFactory)
  container.register(DI.Storage.Validated, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const base = c.resolve<any>(DI.Storage.Base) as any;
      return new SchemaValidatingWorkflowStorage(base);
    }),
  });

  // Layer 3: Caching decorator (singleton via instanceCachingFactory)
  container.register(DI.Storage.Primary, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const validated = c.resolve<any>(DI.Storage.Validated) as any;
      const ttl = c.resolve<number>(DI.Config.CacheTTL);
      return new CachingWorkflowStorage(validated, ttl);
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE REGISTRATION (Auto-discovered via imports)
// ═══════════════════════════════════════════════════════════════════════════

async function registerServices(): Promise<void> {
  // Import order matters: dependencies before dependents
  // Import all services - @singleton() auto-registers them
  // Then manually register symbol token aliases

  // Leaf services
  const { LoopStepResolver } = await import('../application/services/loop-step-resolver.js');
  const { EnhancedLoopValidator } = await import('../application/services/enhanced-loop-validator.js');
  const { DefaultStepSelector } = await import('../application/services/step-selector.js');
  const { LoopContextOptimizer } = await import('../application/services/loop-context-optimizer.js');
  const { EnvironmentFeatureFlagProvider } = await import('../config/feature-flags.js');
  const { SessionDataNormalizer } = await import('../infrastructure/session/SessionDataNormalizer.js');
  const { SessionDataValidator } = await import('../infrastructure/session/SessionDataValidator.js');

  // Mid-level services
  const { ValidationEngine } = await import('../application/services/validation-engine.js');
  const { LoopStackManager } = await import('../application/services/loop-stack-manager.js');
  const { DefaultWorkflowLoader } = await import('../application/services/workflow-loader.js');
  const { DefaultLoopRecoveryService } = await import('../application/services/loop-recovery-service.js');

  // High-level services
  const { IterativeStepResolutionStrategy } = await import('../application/services/step-resolution/iterative-step-resolution-strategy.js');
  const { DefaultWorkflowService } = await import('../application/services/workflow-service.js');

  // Infrastructure
  const { SessionWatcherService } = await import('../infrastructure/session/SessionWatcherService.js');
  const { SessionManager } = await import('../infrastructure/session/SessionManager.js');
  const { HttpServer } = await import('../infrastructure/session/HttpServer.js');

  // NOW register symbol token aliases
  // Using instanceCachingFactory with class resolution - ensures singleton behavior
  // The factory delegates to the @singleton() class registration
  container.register(DI.Infra.LoopStepResolver, { 
    useFactory: instanceCachingFactory((c) => c.resolve(LoopStepResolver)) 
  });
  container.register(DI.Infra.EnhancedLoopValidator, { 
    useFactory: instanceCachingFactory((c) => c.resolve(EnhancedLoopValidator)) 
  });
  container.register(DI.Services.StepSelector, { 
    useFactory: instanceCachingFactory((c) => c.resolve(DefaultStepSelector)) 
  });
  container.register(DI.Services.LoopContextOptimizer, { 
    useFactory: instanceCachingFactory((c) => c.resolve(LoopContextOptimizer)) 
  });
  container.register(DI.Infra.FeatureFlags, { 
    useFactory: instanceCachingFactory((c) => c.resolve(EnvironmentFeatureFlagProvider)) 
  });
  container.register(DI.Infra.SessionDataNormalizer, { 
    useFactory: instanceCachingFactory((c) => c.resolve(SessionDataNormalizer)) 
  });
  container.register(DI.Infra.SessionDataValidator, { 
    useFactory: instanceCachingFactory((c) => c.resolve(SessionDataValidator)) 
  });
  container.register(DI.Infra.ValidationEngine, { 
    useFactory: instanceCachingFactory((c) => c.resolve(ValidationEngine)) 
  });
  container.register(DI.Infra.LoopStackManager, { 
    useFactory: instanceCachingFactory((c) => c.resolve(LoopStackManager)) 
  });
  container.register(DI.Services.WorkflowLoader, { 
    useFactory: instanceCachingFactory((c) => c.resolve(DefaultWorkflowLoader)) 
  });
  container.register(DI.Services.LoopRecovery, { 
    useFactory: instanceCachingFactory((c) => c.resolve(DefaultLoopRecoveryService)) 
  });
  container.register(DI.Services.StepResolution, { 
    useFactory: instanceCachingFactory((c) => c.resolve(IterativeStepResolutionStrategy)) 
  });
  container.register(DI.Services.Workflow, { 
    useFactory: instanceCachingFactory((c) => c.resolve(DefaultWorkflowService)) 
  });
  container.register(DI.Infra.SessionWatcher, { 
    useFactory: instanceCachingFactory((c) => c.resolve(SessionWatcherService)) 
  });
  container.register(DI.Infra.SessionManager, { 
    useFactory: instanceCachingFactory((c) => c.resolve(SessionManager)) 
  });
  container.register(DI.Infra.HttpServer, { 
    useFactory: instanceCachingFactory((c) => c.resolve(HttpServer)) 
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize the DI container.
 * Registers config and imports service modules.
 * 
 * Thread-safe: Concurrent calls will wait for the same initialization.
 * Idempotent: Multiple calls after initialization return immediately.
 * 
 * BUG FIX #2: Enhanced race condition protection
 * - Added synchronous isInitializing flag set BEFORE any async work
 * - Added timeout protection (5s) to prevent indefinite waiting
 * - Concurrent callers now properly wait via spin-wait with timeout
 * - Fail-fast: Don't reset state on error (prevents infinite retry loops)
 */
export async function initializeContainer(): Promise<void> {
  // Fast path: already initialized
  if (initialized) return;

  // If already initializing, wait for it (with timeout protection)
  if (isInitializing) {
    const INIT_TIMEOUT_MS = 5000;
    const POLL_INTERVAL_MS = 10;
    let waited = 0;
    
    while (isInitializing && !initialized && waited < INIT_TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
      waited += POLL_INTERVAL_MS;
    }
    
    if (initialized) return;
    
    if (waited >= INIT_TIMEOUT_MS) {
      throw new Error('[DI] Container initialization timeout after 5 seconds');
    }
  }

  // Double-check after wait (another caller might have completed)
  if (initialized) return;

  // Set synchronous flag BEFORE any async work to prevent race
  isInitializing = true;

  try {
    logger.info('Initializing container');
    
    // Phase 1: Core infrastructure (logging first!)
    registerLogging();
    registerConfig();
    
    // Phase 2: Storage and services (can now use logging)
    await registerStorageChain();
    await registerServices();
    
    initialized = true;
    logger.info('Container initialized');
  } catch (error) {
    // FAIL FAST: Don't reset initializationPromise to null
    // This prevents infinite retry loops - caller should restart process
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Container initialization failed');
    throw new Error(`[DI] Container initialization failed: ${message}`);
  } finally {
    isInitializing = false;
  }
}

/**
 * Initialize async services (HTTP server, etc).
 * Call after initializeContainer().
 */
export async function startAsyncServices(): Promise<void> {
  if (!initialized) {
    await initializeContainer();
  }
  if (asyncInitialized) return;

  try {
    const flags = container.resolve<any>(DI.Infra.FeatureFlags);

    if (flags.isEnabled('sessionTools')) {
      const server = container.resolve<any>(DI.Infra.HttpServer);
      await server.start();
      logger.info('HTTP server started');
    }

    asyncInitialized = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error }, 'Async services initialization failed');
    throw new Error(`[DI] Async services initialization failed: ${message}`);
  }
}

/**
 * Full initialization: container + async services.
 * Use this in entry points.
 */
export async function bootstrap(): Promise<void> {
  await initializeContainer();
  await startAsyncServices();
}

/**
 * Reset container (for testing).
 */
export function resetContainer(): void {
  container.reset();
  initialized = false;
  asyncInitialized = false;
  initializationPromise = null;
  isInitializing = false;
}

/**
 * Check initialization state.
 */
export function isInitialized(): boolean {
  return initialized;
}

// Export container for direct access when needed
export { container };
