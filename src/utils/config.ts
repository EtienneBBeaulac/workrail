// Configuration Management System
// Environment variable validation and type-safe configuration

import { z } from 'zod';
import { ServerConfig } from '../types/mcp-types';

// =============================================================================
// CONFIGURATION SCHEMAS
// =============================================================================

const configSchema = z.object({
  // Core configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).pipe(z.number().min(1).max(65535)).default('3000'),
  HOST: z.string().default('0.0.0.0'),

  // MCP server configuration
  MCP_SERVER_HOST: z.string().default('localhost'),
  MCP_SERVER_PORT: z.string().transform(Number).pipe(z.number().min(1).max(65535)).default('3000'),

  // Workflow storage
  WORKFLOW_STORAGE_PATH: z.string().optional(),
  WORKFLOW_STORAGE_TYPE: z.enum(['file', 'database']).default('file'),
  WORKFLOW_INCLUDE_BUNDLED: z.string().transform(val => val !== 'false').default('true'),
  WORKFLOW_INCLUDE_USER: z.string().transform(val => val !== 'false').default('true'),
  WORKFLOW_INCLUDE_PROJECT: z.string().transform(val => val !== 'false').default('true'),

  // Security settings
  JWT_SECRET: z.string().min(32, 'JWT secret must be at least 32 characters').default('your-super-secret-jwt-key-change-this-in-production'),
  MCP_API_KEY: z.string().optional(),
  MAX_INPUT_SIZE: z.string().transform(Number).pipe(z.number().positive()).default('1048576'),
  RATE_LIMIT_WINDOW: z.string().transform(Number).pipe(z.number().positive()).default('60000'),
  RATE_LIMIT_MAX: z.string().transform(Number).pipe(z.number().positive()).default('100'),

  // Performance settings
  CACHE_TTL: z.string().transform(Number).pipe(z.number().positive()).default('300000'),
  MAX_CONCURRENT_REQUESTS: z.string().transform(Number).pipe(z.number().positive()).default('1000'),
  MEMORY_LIMIT: z.string().default('100MB'),

  // Logging & monitoring
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  METRICS_ENABLED: z.string().transform(val => val === 'true').default('true'),
  HEALTH_CHECK_INTERVAL: z.string().transform(Number).pipe(z.number().positive()).default('30000'),

  // Database (optional)
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),

  // Development settings
  DEBUG: z.string().transform(val => val === 'true').default('false'),
  HOT_RELOAD: z.string().transform(val => val === 'true').default('true'),

  // Testing settings
  TEST_DATABASE_URL: z.string().default('sqlite::memory:'),
  TEST_WORKFLOW_STORAGE_PATH: z.string().default('./tests/fixtures/workflows'),

  // Deployment settings
  COMPRESSION_ENABLED: z.string().transform(val => val === 'true').default('true'),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  TRUST_PROXY: z.string().transform(val => val === 'true').default('false'),

  // Workflow specific settings
  MAX_WORKFLOW_SIZE: z.string().transform(Number).pipe(z.number().positive()).default('1048576'),
  MAX_WORKFLOW_STEPS: z.string().transform(Number).pipe(z.number().positive()).default('50'),
  WORKFLOW_VALIDATION_ENABLED: z.string().transform(val => val === 'true').default('true'),
  WORKFLOW_VALIDATION_STRICT: z.string().transform(val => val === 'true').default('true'),

  // MCP protocol settings
  MCP_PROTOCOL_VERSION: z.string().default('2024-11-05'),
  MCP_DEBUG: z.string().transform(val => val === 'true').default('false'),
  MCP_TIMEOUT: z.string().transform(Number).pipe(z.number().positive()).default('30000'),
});

// =============================================================================
// CONFIGURATION CLASS
// =============================================================================

export class Configuration {
  private static instance: Configuration;
  private config: z.infer<typeof configSchema>;

  private constructor() {
    this.config = this.loadConfiguration();
  }

  public static getInstance(): Configuration {
    if (!Configuration.instance) {
      Configuration.instance = new Configuration();
    }
    return Configuration.instance;
  }

  /**
   * Load and validate configuration from environment variables
   */
  private loadConfiguration(): z.infer<typeof configSchema> {
    try {
      // Load environment variables
      const envVars = process.env;
      
      // Parse and validate configuration
      const config = configSchema.parse(envVars);
      
      return config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Configuration validation failed:');
        error.issues.forEach((err: z.ZodIssue) => {
          console.error(`  ${err.path.join('.')}: ${err.message}`);
        });
        process.exit(1);
      }
      throw error;
    }
  }

  /**
   * Get the complete configuration object
   */
  public getConfig(): z.infer<typeof configSchema> {
    return this.config;
  }

  /**
   * Get server configuration
   */
  public getServerConfig(): ServerConfig {
    return {
      port: this.config.PORT,
      host: this.config.HOST,
      environment: this.config.NODE_ENV,
      logLevel: this.config.LOG_LEVEL,
      workflowStorage: {
        type: this.config.WORKFLOW_STORAGE_TYPE,
        path: this.config.WORKFLOW_STORAGE_PATH || './workflows',
      },
      security: {
        jwtSecret: this.config.JWT_SECRET,
        ...(this.config.MCP_API_KEY && { apiKey: this.config.MCP_API_KEY }),
        maxInputSize: this.config.MAX_INPUT_SIZE,
        rateLimit: {
          windowMs: this.config.RATE_LIMIT_WINDOW,
          max: this.config.RATE_LIMIT_MAX,
        },
      },
      performance: {
        cacheTTL: this.config.CACHE_TTL,
        maxConcurrentRequests: this.config.MAX_CONCURRENT_REQUESTS,
        memoryLimit: this.config.MEMORY_LIMIT,
      },
    };
  }

  /**
   * Get a specific configuration value
   */
  public get<K extends keyof z.infer<typeof configSchema>>(key: K): z.infer<typeof configSchema>[K] {
    return this.config[key];
  }

  /**
   * Check if running in development mode
   */
  public isDevelopment(): boolean {
    return this.config.NODE_ENV === 'development';
  }

  /**
   * Check if running in production mode
   */
  public isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  /**
   * Check if running in test mode
   */
  public isTest(): boolean {
    return this.config.NODE_ENV === 'test';
  }

  /**
   * Check if debug mode is enabled
   */
  public isDebugEnabled(): boolean {
    return this.config.DEBUG;
  }

  /**
   * Check if metrics are enabled
   */
  public isMetricsEnabled(): boolean {
    return this.config.METRICS_ENABLED;
  }

  /**
   * Get CORS origins as array
   */
  public getCorsOrigins(): string[] {
    return this.config.CORS_ORIGINS.split(',').map(origin => origin.trim());
  }

  /**
   * Get memory limit in bytes
   */
  public getMemoryLimitBytes(): number {
    const memoryLimit = this.config.MEMORY_LIMIT;
    const units: Record<string, number> = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024,
    };

    const match = memoryLimit.match(/^(\d+)([A-Z]*)$/);
    if (!match) {
      throw new Error(`Invalid memory limit format: ${memoryLimit}`);
    }

    const [, value, unit] = match;
    const unitUpper = unit?.toUpperCase() || 'MB';
    const multiplier = units[unitUpper] ?? units['MB'];
    
    return parseInt(value || '0') * (multiplier || 1);
  }

  /**
   * Validate configuration for specific features
   */
  public validateFeatureConfig(feature: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    switch (feature) {
      case 'database':
        if (this.config.WORKFLOW_STORAGE_TYPE === 'database' && !this.config.DATABASE_URL) {
          errors.push('DATABASE_URL is required when using database storage');
        }
        break;

      case 'redis':
        if (!this.config.REDIS_URL) {
          errors.push('REDIS_URL is required for caching features');
        }
        break;

      case 'security':
        if (this.config.JWT_SECRET === 'your-super-secret-jwt-key-change-this-in-production') {
          errors.push('JWT_SECRET must be changed from default value in production');
        }
        break;

      case 'workflow-validation':
        if (this.config.WORKFLOW_VALIDATION_ENABLED && !this.config.WORKFLOW_VALIDATION_STRICT) {
          errors.push('Strict validation is recommended when validation is enabled');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get configuration summary for logging
   */
  public getConfigSummary(): Record<string, any> {
    return {
      environment: this.config.NODE_ENV,
      port: this.config.PORT,
      host: this.config.HOST,
      logLevel: this.config.LOG_LEVEL,
      workflowStorage: {
        type: this.config.WORKFLOW_STORAGE_TYPE,
        path: this.config.WORKFLOW_STORAGE_PATH || './workflows',
      },
      security: {
        hasApiKey: !!this.config.MCP_API_KEY,
        maxInputSize: this.config.MAX_INPUT_SIZE,
        rateLimit: {
          windowMs: this.config.RATE_LIMIT_WINDOW,
          max: this.config.RATE_LIMIT_MAX,
        },
      },
      performance: {
        cacheTTL: this.config.CACHE_TTL,
        maxConcurrentRequests: this.config.MAX_CONCURRENT_REQUESTS,
        memoryLimit: this.config.MEMORY_LIMIT,
      },
      features: {
        debug: this.config.DEBUG,
        metrics: this.config.METRICS_ENABLED,
        compression: this.config.COMPRESSION_ENABLED,
        workflowValidation: this.config.WORKFLOW_VALIDATION_ENABLED,
      },
    };
  }

  /**
   * Reload configuration (useful for testing)
   */
  public reload(): void {
    this.config = this.loadConfiguration();
  }
}

// =============================================================================
// CONFIGURATION UTILITIES
// =============================================================================

export const config = Configuration.getInstance();

/**
 * Get configuration value with type safety
 */
export function getConfig<K extends keyof z.infer<typeof configSchema>>(key: K): z.infer<typeof configSchema>[K] {
  return config.get(key);
}

/**
 * Check if feature is enabled
 */
export function isFeatureEnabled(feature: string): boolean {
  switch (feature) {
    case 'debug':
      return config.isDebugEnabled();
    case 'metrics':
      return config.isMetricsEnabled();
    case 'compression':
      return config.get('COMPRESSION_ENABLED');
    case 'workflow-validation':
      return config.get('WORKFLOW_VALIDATION_ENABLED');
    default:
      return false;
  }
}

/**
 * Validate all configuration
 */
export function validateConfiguration(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate core features
  const features = ['database', 'redis', 'security', 'workflow-validation'];
  for (const feature of features) {
    const validation = config.validateFeatureConfig(feature);
    if (!validation.valid) {
      errors.push(...validation.errors);
    }
  }

  // Validate environment-specific requirements
  if (config.isProduction()) {
    if (config.get('JWT_SECRET') === 'your-super-secret-jwt-key-change-this-in-production') {
      errors.push('JWT_SECRET must be changed in production');
    }
    if (config.get('DEBUG')) {
      errors.push('DEBUG should be disabled in production');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Print configuration summary
 */
export function printConfigSummary(): void {
  const summary = config.getConfigSummary();
  console.log('Configuration Summary:');
  console.log(JSON.stringify(summary, null, 2));
} 