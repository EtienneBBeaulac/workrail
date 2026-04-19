/**
 * Application configuration - parse, don't validate.
 *
 * - Single source of truth for config surface
 * - Zod validates at boundary and returns typed data
 * - Errors are data (Result), never thrown
 */

import { z } from 'zod';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import type { Brand } from '../runtime/brand.js';
import { Err } from '../errors/factories.js';
import type { ConfigIssue } from '../errors/app-error.js';
import type { ValidatedAppConfig } from '../errors/app-error.js';

// =============================================================================
// Branded primitives (prove parsing/validation happened)
// =============================================================================

export type CacheTtlMs = Brand<number, 'CacheTtlMs'>;
export type ProjectPath = Brand<string, 'ProjectPath'>;
export type WorkflowDir = Brand<string, 'WorkflowDir'>;

export interface AppConfig {
  readonly cache: { readonly ttlMs: CacheTtlMs };
  readonly paths: {
    readonly projectPath: ProjectPath;
    readonly workflowDir: WorkflowDir;
  };
}

export type ValidatedConfig = ValidatedAppConfig<AppConfig>;

export interface LoadConfigOptions {
  readonly env: Record<string, string | undefined>;
  readonly projectPath: string;
}

// =============================================================================
// Schema (single source of truth for validation + types)
// =============================================================================

const EnvSchema = z.object({
  CACHE_TTL: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(
      z
        .number()
        .min(0, 'CACHE_TTL cannot be negative')
        .max(86_400_000, 'CACHE_TTL cannot exceed 24 hours (86400000ms)')
        .default(300_000)
    ),

  WORKRAIL_WORKFLOWS_DIR: z.string().optional(),
});

type ParsedEnv = z.infer<typeof EnvSchema>;

// =============================================================================
// Public API
// =============================================================================

export type LoadConfigResult = Result<ValidatedConfig, ReturnType<typeof Err.configInvalid>>;

export function loadConfig(options: LoadConfigOptions): LoadConfigResult {
  const parsed = EnvSchema.safeParse(options.env);

  if (!parsed.success) {
    return err(Err.configInvalid(toConfigIssues(parsed.error)));
  }

  return ok(buildConfig(parsed.data, options.projectPath) as ValidatedConfig);
}

/**
 * Tests and local construction only: creates a validated config without env parsing.
 * (Still branded as validated to prevent accidentally passing raw objects.)
 */
export function createValidatedConfig(value: AppConfig): ValidatedConfig {
  return value as ValidatedConfig;
}

// =============================================================================
// Internal
// =============================================================================

function buildConfig(env: ParsedEnv, projectPath: string): AppConfig {
  return {
    cache: { ttlMs: env.CACHE_TTL as CacheTtlMs },
    paths: {
      projectPath: projectPath as ProjectPath,
      workflowDir: (env.WORKRAIL_WORKFLOWS_DIR ?? projectPath) as WorkflowDir,
    },
  };
}

function toConfigIssues(error: z.ZodError): readonly ConfigIssue[] {
  return error.errors.map((issue) => ({
    path: issue.path.length ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}
