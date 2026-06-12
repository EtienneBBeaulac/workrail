/**
 * Process-level Workflow object cache.
 * Delegating to the v2 use-case layer.
 */

export {
  getCachedWorkflow,
  clearWorkflowObjectCacheForTesting,
} from '../../../v2/usecases/workflow-object-cache.js';
