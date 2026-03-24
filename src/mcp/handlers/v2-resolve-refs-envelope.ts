/**
 * Shared helper: resolve workflow references and build a content envelope.
 *
 * Extracted to eliminate duplication between start.ts and continue-rehydrate.ts.
 * Both call sites need the same sequence: resolve refs → log warnings → build envelope.
 *
 * @module mcp/handlers/v2-resolve-refs-envelope
 */

import { ResultAsync as RA, okAsync } from 'neverthrow';
import type { WorkflowReference } from '../../types/workflow-definition.js';
import type { StepMetadata } from '../../v2/durable-core/domain/prompt-renderer.js';
import { resolveWorkflowReferences } from './v2-reference-resolver.js';
import { buildStepContentEnvelope, type StepContentEnvelope } from '../step-content-envelope.js';

/**
 * Resolve workflow-declared references and build a StepContentEnvelope.
 *
 * - Always succeeds (reference resolution is non-blocking)
 * - Logs warnings for missing paths
 * - Returns a ready-to-use content envelope
 *
 * The generic error type E allows callers to specify their own error union
 * for the unreachable rejection case.
 */
export function resolveRefsAndBuildEnvelope<E>(
  meta: StepMetadata,
  workflowRefs: readonly WorkflowReference[],
  workspacePath: string,
  toError: () => E,
): RA<StepContentEnvelope, E> {
  return RA.fromPromise(
    resolveWorkflowReferences(workflowRefs, workspacePath),
    toError,
  ).andThen((refResult) => {
    for (const warning of refResult.warnings) {
      console.warn(`[workrail:reference-resolution] ${warning.message}`);
    }

    return okAsync(buildStepContentEnvelope({
      meta,
      references: refResult.resolved,
    }));
  });
}
