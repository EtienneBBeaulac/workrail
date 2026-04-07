/**
 * Process-level Workflow object cache.
 *
 * Why this exists:
 * createWorkflow() is called on every advance and rehydrate request for the same
 * pinned workflow. The definition is immutable (content-addressed by workflowHash),
 * so creating a new Workflow object each time is wasteful. This module memoizes the
 * Workflow object per workflowHash so the same frozen object is reused across requests.
 *
 * Safety:
 * - Pinned workflow definitions are immutable -- same hash always means same definition.
 * - The cache is unbounded by design. In practice the number of distinct pinned workflow
 *   hashes per process is small (one per unique workflow version used in an active session).
 * - clearWorkflowObjectCacheForTesting() is provided for test isolation only.
 */

import { createWorkflow } from '../../../types/workflow.js';
import { createBundledSource } from '../../../types/workflow-source.js';
import type { WorkflowDefinition } from '../../../types/workflow-definition.js';
import type { Workflow } from '../../../types/workflow.js';
import type { WorkflowHash } from '../../../v2/durable-core/ids/index.js';

// Module-level cache: workflowHash (string) -> frozen Workflow object.
// Mutation is confined to this module boundary.
const _cache = new Map<string, Workflow>();

/**
 * Return the cached Workflow for the given hash, or create and cache it on first access.
 *
 * The definition argument is only used on cache miss. On a cache hit the previously
 * created Workflow is returned regardless of the definition argument -- the invariant
 * is that same hash = same definition (content-addressed pinning).
 */
export function getCachedWorkflow(
  workflowHash: WorkflowHash,
  definition: WorkflowDefinition,
): Workflow {
  const key = String(workflowHash);
  const existing = _cache.get(key);
  if (existing !== undefined) return existing;

  const wf = createWorkflow(definition, createBundledSource());
  _cache.set(key, wf);
  return wf;
}

/**
 * Clear the cache. For test isolation only -- do not call in production code.
 */
export function clearWorkflowObjectCacheForTesting(): void {
  _cache.clear();
}
