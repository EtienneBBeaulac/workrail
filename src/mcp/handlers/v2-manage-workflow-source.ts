/**
 * v2 Manage Workflow Source Handler
 *
 * Handles manage_workflow_source tool calls.
 * Attaches or detaches a filesystem directory as a managed workflow source.
 *
 * Both operations are idempotent:
 * - attach: no-op if the path is already present
 * - detach: no-op if the path is absent
 *
 * @module mcp/handlers/v2-manage-workflow-source
 */

import path from 'path';
import { assertNever } from '../../runtime/assert-never.js';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable, errRetryAfterMs, requireV2Context } from '../types.js';
import type { V2ManageWorkflowSourceInput } from '../v2/tools.js';
import type { ManagedSourceStoreError } from '../../v2/ports/managed-source-store.port.js';

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ManageWorkflowSourceOutput {
  readonly action: 'attach' | 'detach';
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Error mapping (pure)
// ---------------------------------------------------------------------------

function mapManagedSourceErrorToToolError(
  error: ManagedSourceStoreError,
): ToolResult<never> {
  switch (error.code) {
    case 'MANAGED_SOURCE_BUSY':
      return errRetryAfterMs(
        'INTERNAL_ERROR',
        'WorkRail is temporarily busy updating managed workflow sources.',
        error.retry.afterMs,
        {
          suggestion: 'Wait a moment and retry. Another WorkRail process may be updating managed workflow sources.',
        },
      ) as ToolResult<never>;

    case 'MANAGED_SOURCE_IO_ERROR':
      return errNotRetryable(
        'INTERNAL_ERROR',
        'WorkRail could not update the managed workflow sources store.',
        {
          suggestion: 'Fix WorkRail local storage access and retry. Check that the ~/.workrail data directory exists and is writable.',
          details: { errorMessage: error.message },
        },
      ) as ToolResult<never>;

    case 'MANAGED_SOURCE_CORRUPTION':
      return errNotRetryable(
        'INTERNAL_ERROR',
        'WorkRail managed workflow sources store is corrupted.',
        {
          suggestion: 'The managed sources file may need to be deleted and re-created. Check the ~/.workrail/data/managed-sources directory.',
          details: { errorMessage: error.message },
        },
      ) as ToolResult<never>;

    default: {
      const _exhaustive: never = error;
      return assertNever(_exhaustive);
    }
  }
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function handleV2ManageWorkflowSource(
  input: V2ManageWorkflowSourceInput,
  ctx: ToolContext,
): Promise<ToolResult<ManageWorkflowSourceOutput>> {
  const guard = requireV2Context(ctx);
  if (!guard.ok) return guard.error;

  const { managedSourceStore } = guard.ctx.v2;
  if (!managedSourceStore) {
    return errNotRetryable(
      'PRECONDITION_FAILED',
      'Managed workflow source store is not available.',
      {
        suggestion: 'Ensure WorkRail v2 is fully initialized. The managedSourceStore dependency may not be wired in this environment.',
      },
    );
  }

  const operation = input.action === 'attach'
    ? managedSourceStore.attach(input.path)
    : managedSourceStore.detach(input.path);

  const result = await operation;
  if (result.isErr()) {
    return mapManagedSourceErrorToToolError(result.error);
  }

  return success({ action: input.action, path: path.resolve(input.path) });
}
