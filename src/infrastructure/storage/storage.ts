// Re-export new modular storage pieces and compose them to keep backward compatibility

import { FileWorkflowStorage, createDefaultFileWorkflowStorage } from './file-workflow-storage';
import { SchemaValidatingWorkflowStorage, SchemaValidatingCompositeWorkflowStorage } from './schema-validating-workflow-storage';
import { CachingWorkflowStorage, CachingCompositeWorkflowStorage } from './caching-workflow-storage';
import { createEnhancedMultiSourceWorkflowStorage, EnhancedMultiSourceWorkflowStorage } from './enhanced-multi-source-workflow-storage';
import { ICompositeWorkflowStorage } from '../../types/storage';

// -----------------------------------------------------------------------------
// Default composition helper – now exposed as a factory for DI friendliness
// -----------------------------------------------------------------------------

/**
 * Create the default, production-grade storage stack consisting of:
 *   1. Enhanced multi-source workflow storage (supports local dirs + Git repos + URLs)
 *   2. JSON-Schema validation decorator
 *   3. In-memory TTL cache decorator
 *
 * Supports environment variables:
 *   - WORKFLOW_GIT_REPOS: Comma-separated Git repo URLs
 *   - WORKFLOW_GIT_REPO_URL: Single Git repo URL
 *   - GITHUB_TOKEN: Auth token for private repos
 *   - WORKFLOW_INCLUDE_BUNDLED/USER/PROJECT: Enable/disable sources
 *
 * The function is intentionally side-effect-free – each invocation returns a
 * brand-new, fully-composed instance so that callers can choose whether to
 * share or isolate storage state.
 */
export function createDefaultWorkflowStorage(): CachingCompositeWorkflowStorage {
  const baseStorage = createEnhancedMultiSourceWorkflowStorage();
  const validatingStorage = new SchemaValidatingCompositeWorkflowStorage(baseStorage);
  const cacheTtlMs = Number(process.env['CACHE_TTL'] ?? 300_000); // 5 minutes default
  return new CachingCompositeWorkflowStorage(validatingStorage, cacheTtlMs);
}

/**
 * Create the legacy single-directory storage (for backward compatibility)
 */
export function createLegacyWorkflowStorage(): CachingWorkflowStorage {
  const baseStorage = createDefaultFileWorkflowStorage();
  const validatingStorage = new SchemaValidatingWorkflowStorage(baseStorage);
  const cacheTtlMs = Number(process.env['CACHE_TTL'] ?? 300_000); // 5 minutes default
  return new CachingWorkflowStorage(validatingStorage, cacheTtlMs);
}

// Re-export classes for external usage if needed
export {
  FileWorkflowStorage,
  SchemaValidatingWorkflowStorage,
  SchemaValidatingCompositeWorkflowStorage,
  CachingWorkflowStorage,
  CachingCompositeWorkflowStorage,
  EnhancedMultiSourceWorkflowStorage,
  createEnhancedMultiSourceWorkflowStorage
};

// Re-export types
export type { ICompositeWorkflowStorage };
