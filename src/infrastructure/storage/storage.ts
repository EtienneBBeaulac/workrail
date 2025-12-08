/**
 * Storage Layer Exports
 * 
 * Note: This file will be replaced by repository pattern in Phase 2.
 * For now, exports enhanced multi-source storage as the primary implementation.
 */

import { EnhancedMultiSourceWorkflowStorage, createEnhancedMultiSourceWorkflowStorage } from './enhanced-multi-source-workflow-storage';

/**
 * Create default workflow storage.
 * Supports multiple sources: bundled, user, project, Git repos.
 */
export function createDefaultWorkflowStorage(): EnhancedMultiSourceWorkflowStorage {
  return createEnhancedMultiSourceWorkflowStorage();
}

export {
  EnhancedMultiSourceWorkflowStorage,
  createEnhancedMultiSourceWorkflowStorage
};
