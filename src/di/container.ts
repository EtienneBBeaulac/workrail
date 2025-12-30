import 'reflect-metadata';
import { container, DependencyContainer, instanceCachingFactory } from 'tsyringe';
import { DI } from './tokens.js';
import { assertNever } from '../runtime/assert-never.js';
import type { RuntimeMode } from '../runtime/runtime-mode.js';
import type { ProcessLifecyclePolicy } from '../runtime/process-lifecycle-policy.js';
import type { ProcessSignals } from '../runtime/ports/process-signals.js';
import { NodeProcessSignals } from '../runtime/adapters/node-process-signals.js';
import { NoopProcessSignals } from '../runtime/adapters/noop-process-signals.js';
import type { ShutdownEvents } from '../runtime/ports/shutdown-events.js';
import { InMemoryShutdownEvents } from '../runtime/adapters/in-memory-shutdown-events.js';
import type { ProcessTerminator } from '../runtime/ports/process-terminator.js';
import { NodeProcessTerminator } from '../runtime/adapters/node-process-terminator.js';
import { ThrowingProcessTerminator } from '../runtime/adapters/throwing-process-terminator.js';
import type { ValidatedConfig } from '../config/app-config.js';
import { loadConfig } from '../config/app-config.js';
import { formatAppError } from '../errors/formatter.js';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// BUG FIX #2: Added isInitializing flag for race condition protection
// ═══════════════════════════════════════════════════════════════════════════

let initialized = false;
let asyncInitialized = false;
let initializationPromise: Promise<void> | null = null;
let isInitializing = false; // Synchronous flag for race protection

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

async function registerConfig(): Promise<void> {
  // Allow tests to inject config explicitly before container initialization.
  // This prevents the composition root from overwriting test-provided values.
  if (!container.isRegistered(DI.Config.App)) {
    const configResult = loadConfig({ env: process.env, projectPath: process.cwd() });

    if (configResult.kind === 'err') {
      console.error(formatAppError(configResult.error));
      process.exit(1);
    }

    const config = configResult.value;
    container.register<ValidatedConfig>(DI.Config.App, { useValue: config });

    // Backward compatibility: keep individual tokens during migration.
    container.register(DI.Config.CacheTTL, { useValue: config.cache.ttlMs });
    container.register(DI.Config.WorkflowDir, { useValue: config.paths.workflowDir });
    container.register(DI.Config.ProjectPath, { useValue: config.paths.projectPath });
    container.register(DI.Config.DashboardMode, { useValue: config.dashboard.mode });
    container.register(DI.Config.BrowserBehavior, { useValue: config.dashboard.browserBehavior });
  }

  // Register FeatureFlags early - needed by storage layer
  // (Tests may have already registered this, so check first)
  if (!container.isRegistered(DI.Infra.FeatureFlags)) {
    const { EnvironmentFeatureFlagProvider } = await import('../config/feature-flags.js');
    container.register(DI.Infra.FeatureFlags, {
      useFactory: instanceCachingFactory((c) => c.resolve(EnvironmentFeatureFlagProvider))
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

function detectRuntimeMode(): RuntimeMode {
  // Single source of truth for runtime inference.
  // Env access is allowed here (composition root), but should not leak into services.
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    return { kind: 'test' };
  }
  return { kind: 'production' };
}

function toProcessLifecyclePolicy(mode: RuntimeMode): ProcessLifecyclePolicy {
  switch (mode.kind) {
    case 'test':
      return { kind: 'no_signal_handlers' };
    case 'cli':
    case 'rpc':
    case 'production':
      return { kind: 'install_signal_handlers' };
    default:
      return assertNever(mode);
  }
}

export interface ContainerInitOptions {
  readonly runtimeMode?: RuntimeMode;
}

function registerRuntime(options: ContainerInitOptions = {}): void {
  const mode = options.runtimeMode ?? detectRuntimeMode();
  const policy = toProcessLifecyclePolicy(mode);

  container.register<RuntimeMode>(DI.Runtime.Mode, { useValue: mode });
  container.register<ProcessLifecyclePolicy>(DI.Runtime.ProcessLifecyclePolicy, { useValue: policy });

  const signals: ProcessSignals =
    policy.kind === 'no_signal_handlers' ? new NoopProcessSignals() : new NodeProcessSignals();
  container.register<ProcessSignals>(DI.Runtime.ProcessSignals, { useValue: signals });

  // Shutdown event bus is always available (even in tests) but only used when something emits.
  container.register<ShutdownEvents>(DI.Runtime.ShutdownEvents, { useValue: new InMemoryShutdownEvents() });

  const terminator: ProcessTerminator =
    mode.kind === 'test' ? new ThrowingProcessTerminator() : new NodeProcessTerminator();
  container.register<ProcessTerminator>(DI.Runtime.ProcessTerminator, { useValue: terminator });
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

  // Layer 1: Base storage (singleton with feature flags injection)
  container.register(DI.Storage.Base, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const featureFlags = c.resolve<any>(DI.Infra.FeatureFlags);
      return new EnhancedMultiSourceWorkflowStorage({}, featureFlags);
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

  const { EnhancedLoopValidator } = await import('../application/services/enhanced-loop-validator.js');
  const { SessionDataNormalizer } = await import('../infrastructure/session/SessionDataNormalizer.js');
  const { SessionDataValidator } = await import('../infrastructure/session/SessionDataValidator.js');
  const { ValidationEngine } = await import('../application/services/validation-engine.js');
  const { WorkflowCompiler } = await import('../application/services/workflow-compiler.js');
  const { WorkflowInterpreter } = await import('../application/services/workflow-interpreter.js');
  const { ToolDescriptionProvider } = await import('../mcp/tool-description-provider.js');

  const { DefaultWorkflowService } = await import('../application/services/workflow-service.js');

  // Infrastructure
  const { SessionManager } = await import('../infrastructure/session/SessionManager.js');
  const { HttpServer } = await import('../infrastructure/session/HttpServer.js');

  // NOW register symbol token aliases
  // Using instanceCachingFactory with class resolution - ensures singleton behavior
  // The factory delegates to the @singleton() class registration
  container.register(DI.Infra.EnhancedLoopValidator, { 
    useFactory: instanceCachingFactory((c) => c.resolve(EnhancedLoopValidator)) 
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
  container.register(DI.Services.WorkflowCompiler, {
    useFactory: instanceCachingFactory((c) => c.resolve(WorkflowCompiler)),
  });
  container.register(DI.Services.WorkflowInterpreter, {
    useFactory: instanceCachingFactory((c) => c.resolve(WorkflowInterpreter)),
  });
  container.register(DI.Services.Workflow, { 
    useFactory: instanceCachingFactory((c) => c.resolve(DefaultWorkflowService)) 
  });
  container.register(DI.Infra.SessionManager, { 
    useFactory: instanceCachingFactory((c) => c.resolve(SessionManager)) 
  });
  container.register(DI.Infra.HttpServer, { 
    useFactory: instanceCachingFactory((c) => c.resolve(HttpServer)) 
  });

  // MCP layer
  // Explicit wiring: do not rely on decorator side-effects to register this dependency.
  // Tests may override this token, so only register when missing.
  if (!container.isRegistered(DI.Mcp.DescriptionProvider)) {
    container.registerSingleton(DI.Mcp.DescriptionProvider, ToolDescriptionProvider);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 BOUNDED CONTEXT REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register v2 bounded context services (append-only truth + token execution).
 * 
 * v2 represents a rewrite to make workflows deterministic and rewind-safe via:
 * - Append-only event logs (immutable truth)
 * - Token-based execution (opaque handles, no agent-owned state)
 * - Pinned workflow snapshots (content-addressed determinism)
 * 
 * Dependency levels:
 * - Level 1: Primitives (DataDir, FS, Sha256, Crypto, Hmac) - no deps
 * - Level 2: Stores (Keyring, SessionStore, SnapshotStore, PinnedStore, SessionLock) - depend on Level 1
 * - Level 3: Orchestration (ExecutionGate) - depends on Level 2
 */
async function registerV2Services(): Promise<void> {
  // Level 1: Primitives (no dependencies)
  const { LocalDataDirV2 } = await import('../v2/infra/local/data-dir/index.js');
  const { NodeFileSystemV2 } = await import('../v2/infra/local/fs/index.js');
  const { NodeSha256V2 } = await import('../v2/infra/local/sha256/index.js');
  const { NodeCryptoV2 } = await import('../v2/infra/local/crypto/index.js');
  const { NodeHmacSha256V2 } = await import('../v2/infra/local/hmac-sha256/index.js');
  const { NodeBase64UrlV2 } = await import('../v2/infra/local/base64url/index.js');
  const { NodeRandomEntropyV2 } = await import('../v2/infra/local/random-entropy/index.js');
  const { NodeTimeClockV2 } = await import('../v2/infra/local/time-clock/index.js');

  container.register(DI.V2.DataDir, {
    useFactory: instanceCachingFactory(() => new LocalDataDirV2(process.env)),
  });
  container.register(DI.V2.FileSystem, {
    useFactory: instanceCachingFactory(() => new NodeFileSystemV2()),
  });
  container.register(DI.V2.Sha256, {
    useFactory: instanceCachingFactory(() => new NodeSha256V2()),
  });
  container.register(DI.V2.Crypto, {
    useFactory: instanceCachingFactory(() => new NodeCryptoV2()),
  });
  container.register(DI.V2.HmacSha256, {
    useFactory: instanceCachingFactory(() => new NodeHmacSha256V2()),
  });
  container.register(DI.V2.Base64Url, {
    useFactory: instanceCachingFactory(() => new NodeBase64UrlV2()),
  });
  container.register(DI.V2.RandomEntropy, {
    useFactory: instanceCachingFactory(() => new NodeRandomEntropyV2()),
  });
  container.register(DI.V2.TimeClock, {
    useFactory: instanceCachingFactory(() => new NodeTimeClockV2()),
  });

  // Level 2: Stores (depend on Level 1 primitives)
  const { LocalKeyringV2 } = await import('../v2/infra/local/keyring/index.js');
  const { LocalSessionEventLogStoreV2 } = await import('../v2/infra/local/session-store/index.js');
  const { LocalSnapshotStoreV2 } = await import('../v2/infra/local/snapshot-store/index.js');
  const { LocalPinnedWorkflowStoreV2 } = await import('../v2/infra/local/pinned-workflow-store/index.js');
  const { LocalSessionLockV2 } = await import('../v2/infra/local/session-lock/index.js');

  container.register(DI.V2.Keyring, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const dataDir = c.resolve<any>(DI.V2.DataDir);
      const fs = c.resolve<any>(DI.V2.FileSystem);
      const base64url = c.resolve<any>(DI.V2.Base64Url);
      const entropy = c.resolve<any>(DI.V2.RandomEntropy);
      return new LocalKeyringV2(dataDir, fs, base64url, entropy);
    }),
  });
  container.register(DI.V2.SessionStore, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const dataDir = c.resolve<any>(DI.V2.DataDir);
      const fs = c.resolve<any>(DI.V2.FileSystem);
      const sha256 = c.resolve<any>(DI.V2.Sha256);
      return new LocalSessionEventLogStoreV2(dataDir, fs, sha256);
    }),
  });
  container.register(DI.V2.SnapshotStore, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const dataDir = c.resolve<any>(DI.V2.DataDir);
      const fs = c.resolve<any>(DI.V2.FileSystem);
      const crypto = c.resolve<any>(DI.V2.Crypto);
      return new LocalSnapshotStoreV2(dataDir, fs, crypto);
    }),
  });
  container.register(DI.V2.PinnedWorkflowStore, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const dataDir = c.resolve<any>(DI.V2.DataDir);
      const fs = c.resolve<any>(DI.V2.FileSystem);
      return new LocalPinnedWorkflowStoreV2(dataDir, fs);
    }),
  });
  container.register(DI.V2.SessionLock, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const dataDir = c.resolve<any>(DI.V2.DataDir);
      const fs = c.resolve<any>(DI.V2.FileSystem);
      const clock = c.resolve<any>(DI.V2.TimeClock);
      return new LocalSessionLockV2(dataDir, fs, clock);
    }),
  });

  // Level 3: Orchestration (depends on Level 2 stores)
  const { ExecutionSessionGateV2 } = await import('../v2/usecases/execution-session-gate.js');

  container.register(DI.V2.ExecutionGate, {
    useFactory: instanceCachingFactory((c: DependencyContainer) => {
      const lock = c.resolve<any>(DI.V2.SessionLock);
      const store = c.resolve<any>(DI.V2.SessionStore);
      return new ExecutionSessionGateV2(lock, store);
    }),
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
export async function initializeContainer(options: ContainerInitOptions = {}): Promise<void> {
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
    registerRuntime(options);
    await registerConfig();
    await registerStorageChain();
    await registerV2Services();
    await registerServices();
    initialized = true;
    console.error('[DI] Container initialized');
  } catch (error) {
    // FAIL FAST: Don't reset initializationPromise to null
    // This prevents infinite retry loops - caller should restart process
    const message = error instanceof Error ? error.message : String(error);
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
      console.error('[DI] HTTP server started');
    }

    asyncInitialized = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[DI] Async services initialization failed: ${message}`);
  }
}

/**
 * Full initialization: container + async services.
 * Use this in entry points.
 */
export async function bootstrap(options: ContainerInitOptions = {}): Promise<void> {
  await initializeContainer(options);
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
