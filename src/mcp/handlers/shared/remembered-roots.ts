import path from 'path';
import { errNotRetryable, errRetryAfterMs, type ToolError } from '../../types.js';
import type {
  RememberedRootRecordV2,
  RememberedRootsStorePortV2,
} from '../../../v2/ports/remembered-roots-store.port.js';

export async function rememberExplicitWorkspaceRoot(
  workspacePath: string | undefined,
  rememberedRootsStore: RememberedRootsStorePortV2 | undefined,
): Promise<ToolError | null> {
  if (!workspacePath || !rememberedRootsStore) return null;
  if (!path.isAbsolute(workspacePath)) return null;

  const result = await rememberedRootsStore.rememberRoot(workspacePath);
  if (result.isErr()) {
    const error = result.error;
    if (error.code === 'REMEMBERED_ROOTS_BUSY') {
      return errRetryAfterMs(
        'INTERNAL_ERROR',
        'WorkRail is temporarily busy updating remembered workflow roots.',
        error.retry.afterMs,
        {
          suggestion: 'Wait a moment and retry this call. Another WorkRail process may be updating remembered workflow roots.',
        },
      ) as ToolError;
    }

    return errNotRetryable(
      'INTERNAL_ERROR',
      `WorkRail could not persist the workspace root for workflow-source setup.`,
      {
        suggestion:
          'Fix WorkRail local storage access and retry. Check that the ~/.workrail data directory exists and is writable.',
        details: {
          workspacePath,
          rememberedRootsErrorCode: error.code,
          rememberedRootsErrorMessage: error.message,
        },
      },
    ) as ToolError;
  }
  return null;
}

export async function listRememberedRootRecords(
  rememberedRootsStore: RememberedRootsStorePortV2 | undefined,
): Promise<readonly RememberedRootRecordV2[] | ToolError> {
  if (!rememberedRootsStore) return [];

  const result = await rememberedRootsStore.listRootRecords();
  if (result.isErr()) {
    const error = result.error;
    if (error.code === 'REMEMBERED_ROOTS_BUSY') {
      return errRetryAfterMs(
        'INTERNAL_ERROR',
        'WorkRail is temporarily busy reading remembered workflow roots.',
        error.retry.afterMs,
        {
          suggestion:
            'Wait a moment and retry this call. Another WorkRail process may be updating remembered workflow roots.',
        },
      ) as ToolError;
    }

    return errNotRetryable(
      'INTERNAL_ERROR',
      'WorkRail could not load remembered workflow roots for workflow-source visibility.',
      {
        suggestion:
          'Fix WorkRail local storage access and retry. Check that the ~/.workrail data directory exists and is writable.',
        details: {
          rememberedRootsErrorCode: error.code,
          rememberedRootsErrorMessage: error.message,
        },
      },
    ) as ToolError;
  }

  return result.value;
}
