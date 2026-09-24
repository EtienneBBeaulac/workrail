import { FileWorkflowStorage } from '../infrastructure/storage/file-workflow-storage.js';
import { StaticFeatureFlagProvider } from '../config/feature-flags.js';
import { createUserDirectorySource } from '../types/workflow-source.js';

/** Enrollment resolves declared identity using the existing variant policy. The
 * supplied directory is the whole authority; ambient workflow sources and feature
 * flags cannot change the pinned definition. Recovery never calls this reader. */
export function createAnswerWorkflowReader(directory: string) {
  return new FileWorkflowStorage(directory, createUserDirectorySource(directory),
    new StaticFeatureFlagProvider({ v2Tools: true }), { cacheTTLms: 0, indexCacheTTLms: 0 });
}
