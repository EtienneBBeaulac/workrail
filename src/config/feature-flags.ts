import { singleton } from 'tsyringe';

/**
 * Feature Flags System
 * 
 * Enables/disables features at runtime via environment variables or configuration.
 * Follows trunk-based development: features are merged with flags OFF by default,
 * then enabled when stable.
 * 
 * @module config/feature-flags
 */

/**
 * Feature flag definitions with metadata
 * 
 * Each flag includes:
 * - key: Unique identifier (used in code)
 * - envVar: Environment variable name
 * - defaultValue: Safe default (false for experimental features)
 * - description: What this flag controls
 * - since: Version when flag was introduced
 * - stable: Whether feature is production-ready
 */
export interface FeatureFlagDefinition {
  readonly key: string;
  readonly envVar: string;
  readonly defaultValue: boolean;
  readonly description: string;
  readonly since: string;
  readonly stable: boolean;
}

/**
 * Available feature flags
 * 
 * Following SOLID principles:
 * - Single Responsibility: Each flag controls ONE feature
 * - Open/Closed: Add new flags without modifying existing code
 */
export const FEATURE_FLAG_DEFINITIONS: ReadonlyArray<FeatureFlagDefinition> = [
  {
    key: 'sessionTools',
    envVar: 'WORKRAIL_ENABLE_SESSION_TOOLS',
    defaultValue: false,
    description: 'Enable session management tools (workrail_create_session, workrail_update_session, etc.) and HTTP dashboard server',
    since: '0.6.0',
    stable: false,
  },
  {
    key: 'experimentalWorkflows',
    envVar: 'WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS',
    defaultValue: false,
    description: 'Load workflows from experimental/ directory',
    since: '0.6.1',
    stable: false,
  },
  {
    key: 'verboseLogging',
    envVar: 'WORKRAIL_VERBOSE_LOGGING',
    defaultValue: false,
    description: 'Enable detailed debug logging',
    since: '0.6.0',
    stable: true,
  },
  {
    key: 'agenticRoutines',
    envVar: 'WORKRAIL_ENABLE_AGENTIC_ROUTINES',
    defaultValue: false,
    description: 'Enable Agentic Orchestration features (subagent delegation, .agentic.json overrides, routines)',
    since: '0.8.3',
    stable: false,
  },
  {
    key: 'authoritativeDescriptions',
    envVar: 'WORKRAIL_AUTHORITATIVE_DESCRIPTIONS',
    defaultValue: false,
    description: 'Use imperative/mandatory language in tool descriptions to improve agent workflow compliance',
    since: '0.9.0',
    stable: false,
  },
  {
    key: 'v2Tools',
    envVar: 'WORKRAIL_ENABLE_V2_TOOLS',
    defaultValue: false,
    description: 'Enable WorkRail v2 MCP tools (Slice 1: list_workflows, inspect_workflow) behind an explicit opt-in flag',
    since: '0.9.0',
    stable: false,
  },
] as const;

/**
 * Type-safe feature flag keys
 * Provides autocomplete and compile-time checking
 */
export type FeatureFlagKey = typeof FEATURE_FLAG_DEFINITIONS[number]['key'];

/**
 * Feature flag values (all flags as a typed object)
 */
export type FeatureFlags = {
  readonly [K in FeatureFlagKey]: boolean;
};

/**
 * Parse environment variable to boolean
 * 
 * Accepts common boolean representations:
 * - true: 'true', '1', 'yes', 'on'
 * - false: 'false', '0', 'no', 'off', undefined
 * 
 * @param value - Environment variable value
 * @param defaultValue - Fallback if undefined
 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  
  const normalized = value.toLowerCase().trim();
  const truthyValues = ['true', '1', 'yes', 'on'];
  const falsyValues = ['false', '0', 'no', 'off'];
  
  if (truthyValues.includes(normalized)) {
    return true;
  }
  
  if (falsyValues.includes(normalized)) {
    return false;
  }
  
  // Invalid value - warn and use default
  console.warn(
    `[FeatureFlags] Invalid boolean value "${value}" for flag. ` +
    `Expected one of: ${[...truthyValues, ...falsyValues].join(', ')}. ` +
    `Using default: ${defaultValue}`
  );
  
  return defaultValue;
}

/**
 * Feature Flag Provider
 * 
 * Implements:
 * - Single Responsibility: Only reads and provides feature flags
 * - Dependency Injection: Injected into services that need it
 * - Immutability: Flags are read-only after initialization
 * - Interface Segregation: Simple, focused interface
 */
export interface IFeatureFlagProvider {
  /**
   * Check if a feature is enabled
   * @param key - Feature flag key
   */
  isEnabled(key: FeatureFlagKey): boolean;
  
  /**
   * Get all feature flags as a snapshot
   */
  getAll(): FeatureFlags;
  
  /**
   * Get human-readable summary of all flags (for debugging)
   */
  getSummary(): string;
}

/**
 * Builds flags from an environment source
 */
function buildFlags(envSource: Record<string, string | undefined>): FeatureFlags {
  const flags: Partial<Record<FeatureFlagKey, boolean>> = {};
  
  for (const definition of FEATURE_FLAG_DEFINITIONS) {
    const envValue = envSource[definition.envVar];
    flags[definition.key as FeatureFlagKey] = parseBoolean(envValue, definition.defaultValue);
  }
  
  return flags as FeatureFlags;
}

/**
 * Environment-based Feature Flag Provider
 * 
 * Reads flags from environment variables at initialization.
 * Immutable after construction (follows functional programming principles).
 * 
 * Note: For testing with custom environment, use createFeatureFlagProviderWithEnv()
 */
@singleton()
export class EnvironmentFeatureFlagProvider implements IFeatureFlagProvider {
  private readonly flags: FeatureFlags;
  
  /**
   * Constructor reads from process.env.
   * TSyringe will construct with zero args.
   */
  constructor() {
    this.flags = buildFlags(process.env);
    
    // Log enabled experimental features (helps with debugging)
    const enabledExperimental = FEATURE_FLAG_DEFINITIONS
      .filter(def => !def.stable && this.flags[def.key as FeatureFlagKey])
      .map(def => def.key);
    
    if (enabledExperimental.length > 0) {
      console.error(
        `[FeatureFlags] Experimental features enabled: ${enabledExperimental.join(', ')}`
      );
    }
  }
  
  /**
   * Create an instance with a custom environment (for testing)
   */
  static withEnv(env: Record<string, string | undefined>): IFeatureFlagProvider {
    return new CustomEnvFeatureFlagProvider(env);
  }
  
  isEnabled(key: FeatureFlagKey): boolean {
    return this.flags[key] ?? false;
  }
  
  getAll(): FeatureFlags {
    // Return shallow copy to maintain immutability
    return { ...this.flags };
  }
  
  getSummary(): string {
    const lines = ['Feature Flags:'];
    
    for (const definition of FEATURE_FLAG_DEFINITIONS) {
      const enabled = this.flags[definition.key as FeatureFlagKey];
      const status = enabled ? '✓ ENABLED' : '✗ DISABLED';
      const stability = definition.stable ? '[STABLE]' : '[EXPERIMENTAL]';
      
      lines.push(`  ${status} ${stability} ${definition.key}`);
      lines.push(`    ${definition.description}`);
      lines.push(`    env: ${definition.envVar}`);
    }
    
    return lines.join('\n');
  }
}

/**
 * Custom environment-based Feature Flag Provider (for testing)
 * 
 * Allows tests to provide a custom environment instead of using process.env.
 */
export class CustomEnvFeatureFlagProvider implements IFeatureFlagProvider {
  private readonly flags: FeatureFlags;
  
  constructor(env: Record<string, string | undefined>) {
    this.flags = buildFlags(env);
  }
  
  isEnabled(key: FeatureFlagKey): boolean {
    return this.flags[key] ?? false;
  }
  
  getAll(): FeatureFlags {
    return { ...this.flags };
  }
  
  getSummary(): string {
    const lines = ['Feature Flags:'];
    
    for (const definition of FEATURE_FLAG_DEFINITIONS) {
      const enabled = this.flags[definition.key as FeatureFlagKey];
      const status = enabled ? '✓ ENABLED' : '✗ DISABLED';
      const stability = definition.stable ? '[STABLE]' : '[EXPERIMENTAL]';
      
      lines.push(`  ${status} ${stability} ${definition.key}`);
      lines.push(`    ${definition.description}`);
      lines.push(`    env: ${definition.envVar}`);
    }
    
    return lines.join('\n');
  }
}

/**
 * Static Feature Flag Provider (for testing)
 * 
 * Allows tests to inject specific flag values without environment variables.
 */
export class StaticFeatureFlagProvider implements IFeatureFlagProvider {
  constructor(private readonly flags: Partial<FeatureFlags> = {}) {}
  
  isEnabled(key: FeatureFlagKey): boolean {
    return this.flags[key] ?? false;
  }
  
  getAll(): FeatureFlags {
    const allFlags: Partial<Record<FeatureFlagKey, boolean>> = {};
    
    for (const definition of FEATURE_FLAG_DEFINITIONS) {
      allFlags[definition.key as FeatureFlagKey] = 
        this.flags[definition.key as FeatureFlagKey] ?? definition.defaultValue;
    }
    
    return allFlags as FeatureFlags;
  }
  
  getSummary(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }
}

/**
 * @deprecated Removed. Use container.resolve(DI.Infra.FeatureFlags) instead.
 * For tests with custom env, use: EnvironmentFeatureFlagProvider.withEnv(env)
 */
export function createFeatureFlagProvider(): never {
  throw new Error(
    'createFeatureFlagProvider() is removed. ' +
    'Use DI: container.resolve(DI.Infra.FeatureFlags). ' +
    'For tests: EnvironmentFeatureFlagProvider.withEnv(customEnv)'
  );
}
