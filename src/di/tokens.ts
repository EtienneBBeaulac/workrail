/**
 * Dependency Injection Token Registry
 *
 * Single source of truth for all DI tokens.
 * Organized hierarchically by domain, not by type.
 *
 * ADDING A NEW SERVICE:
 * 1. Add token here under appropriate namespace
 * 2. Add @singleton() to your class (this auto-registers it)
 * 3. Add token alias at bottom of service file
 * 4. Use @inject(DI.YourToken) in consumers
 */
export const DI = {
  // ═══════════════════════════════════════════════════════════════════
  // STORAGE LAYER
  // ═══════════════════════════════════════════════════════════════════
  Storage: {
    /** The primary storage interface - fully decorated chain */
    Primary: Symbol('Storage.Primary'),
    /** Base multi-source storage (before decorators) */
    Base: Symbol('Storage.Base'),
    /** Schema-validated storage (decorator layer 1) */
    Validated: Symbol('Storage.Validated'),
  },

  // ═══════════════════════════════════════════════════════════════════
  // CORE SERVICES
  // ═══════════════════════════════════════════════════════════════════
  Services: {
    /** Workflow loading and validation */
    WorkflowLoader: Symbol('Services.WorkflowLoader'),
    /** Step selection logic */
    StepSelector: Symbol('Services.StepSelector'),
    /** Loop state recovery */
    LoopRecovery: Symbol('Services.LoopRecovery'),
    /** Step resolution strategy */
    StepResolution: Symbol('Services.StepResolution'),
    /** Loop context optimization (progressive disclosure) */
    LoopContextOptimizer: Symbol('Services.LoopContextOptimizer'),
    /** Main workflow service (high-level orchestrator) */
    Workflow: Symbol('Services.Workflow'),
  },

  // ═══════════════════════════════════════════════════════════════════
  // INFRASTRUCTURE
  // ═══════════════════════════════════════════════════════════════════
  Infra: {
    /** Feature flag provider */
    FeatureFlags: Symbol('Infra.FeatureFlags'),
    /** Session watcher service (file watching) */
    SessionWatcher: Symbol('Infra.SessionWatcher'),
    /** Session manager (CRUD operations) */
    SessionManager: Symbol('Infra.SessionManager'),
    /** HTTP server for dashboard */
    HttpServer: Symbol('Infra.HttpServer'),
    /** Validation engine */
    ValidationEngine: Symbol('Infra.ValidationEngine'),
    /** Loop stack manager */
    LoopStackManager: Symbol('Infra.LoopStackManager'),
    /** Loop step resolver */
    LoopStepResolver: Symbol('Infra.LoopStepResolver'),
    /** Enhanced loop validator */
    EnhancedLoopValidator: Symbol('Infra.EnhancedLoopValidator'),
    /** Session data normalizer */
    SessionDataNormalizer: Symbol('Infra.SessionDataNormalizer'),
    /** Session data validator */
    SessionDataValidator: Symbol('Infra.SessionDataValidator'),
  },

  // ═══════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════
  Config: {
    /** Cache TTL in milliseconds */
    CacheTTL: Symbol('Config.CacheTTL'),
    /** Workflow directory path */
    WorkflowDir: Symbol('Config.WorkflowDir'),
    /** Project root path */
    ProjectPath: Symbol('Config.ProjectPath'),
  },

  // ═══════════════════════════════════════════════════════════════════
  // LOGGING
  // ═══════════════════════════════════════════════════════════════════
  Logging: {
    /** Logger factory - creates component loggers */
    Factory: Symbol('Logging.Factory'),
  },
} as const;

/** Type helper for token values */
export type DIToken = typeof DI[keyof typeof DI][keyof typeof DI[keyof typeof DI]];
