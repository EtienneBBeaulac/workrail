/**
 * v2 Internal Error Mapping
 *
 * Maps domain-level errors to tool-level errors for the v2 execution handlers.
 * These are the "last-mile" error mappers used inside advanceAndRecord / handleRetryAdvance.
 *
 * Distinct from v2-execution-helpers.ts which maps handler-level errors (StartWorkflowError, etc.).
 * This module maps lower-level store/gate errors that occur during the advance inner loop.
 */

import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { errNotRetryable, errRetryAfterMs, detailsSessionHealth } from '../types.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SnapshotStoreError } from '../../v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStoreError } from '../../v2/ports/pinned-workflow-store.port.js';
import { type ToolFailure, internalSuggestion } from './v2-execution-helpers.js';

/**
 * Closed-set internal error union for advance operations.
 * Every variant is handled exhaustively in the advance core.
 */
export type InternalError =
  | { readonly kind: 'invariant_violation'; readonly message: string }
  | { readonly kind: 'advance_apply_failed'; readonly message: string }
  | { readonly kind: 'advance_next_failed'; readonly message: string }
  | { readonly kind: 'missing_node_or_run' }
  | { readonly kind: 'workflow_hash_mismatch' }
  | { readonly kind: 'missing_snapshot' }
  | { readonly kind: 'no_pending_step' }
  | { readonly kind: 'token_scope_mismatch'; readonly message: string };

/** Type guard for InternalError. */
export function isInternalError(e: unknown): e is InternalError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'kind' in e &&
    typeof (e as Record<string, unknown>).kind === 'string'
  );
}

import * as os from 'os';

/** 
 * Normalize token error messages (strip sensitive internal details).
 * 
 * NOTE: The os.homedir() call here is intentional I/O for error formatting, not domain logic.
 * This is error presentation code that sanitizes file paths in error messages for security/consistency.
 */
export function normalizeTokenErrorMessage(message: string): string {
  // Keep errors deterministic and compact; avoid leaking environment-specific file paths.
  return message.split(os.homedir()).join('~');
}

/** Create a generic internal error ToolFailure. */
export function internalError(message: string, suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR', normalizeTokenErrorMessage(message), suggestion ? { suggestion } : undefined) as ToolFailure;
}

/** Map SessionEventLogStoreError to ToolFailure. Exhaustive switch. */
export function sessionStoreErrorToToolError(e: SessionEventLogStoreError): ToolFailure {
  switch (e.code) {
    case 'SESSION_STORE_LOCK_BUSY':
      return errRetryAfterMs('INTERNAL_ERROR',
        'The session is temporarily busy (another operation is in progress).',
        e.retry.afterMs,
        { suggestion: internalSuggestion('Wait a moment and retry this call.', 'Another WorkRail process may be accessing this session.') },
      ) as ToolFailure;
    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return errNotRetryable('SESSION_NOT_HEALTHY',
        'This session\'s data is corrupted and cannot be used.',
        {
          suggestion: internalSuggestion('This session cannot be recovered. Call start_workflow to create a new session.', 'The session data was corrupted.'),
          details: detailsSessionHealth({ kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail', reason: e.reason }) as unknown as JsonValue,
        },
      ) as ToolFailure;
    case 'SESSION_STORE_IO_ERROR':
      return internalError(
        'WorkRail could not read or write session data to disk.',
        internalSuggestion('Retry the call.', 'WorkRail cannot access its data files. Check that the ~/.workrail directory exists and is writable.'),
      );
    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return internalError(
        'WorkRail encountered an unexpected error with session storage. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail has an internal storage error.'),
      );
    default:
      const _exhaustive: never = e;
      return internalError(
        'WorkRail encountered an unexpected session storage error. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail has an internal error.'),
      );
  }
}

/** Map ExecutionSessionGateErrorV2 to ToolFailure. Exhaustive switch. */
export function gateErrorToToolError(e: ExecutionSessionGateErrorV2): ToolFailure {
  switch (e.code) {
    case 'SESSION_LOCKED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED',
        'This session is currently being modified by another operation.',
        e.retry.afterMs,
        { suggestion: internalSuggestion('Wait a moment and retry this call.', 'Another WorkRail process may be accessing this session.') },
      ) as ToolFailure;
    case 'LOCK_RELEASE_FAILED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED',
        'A previous operation on this session did not release cleanly.',
        e.retry.afterMs,
        { suggestion: 'Wait a moment and retry this call. The lock will auto-expire shortly.' },
      ) as ToolFailure;
    case 'SESSION_NOT_HEALTHY':
      return errNotRetryable('SESSION_NOT_HEALTHY',
        'This session is in an unhealthy state and cannot accept new operations.',
        {
          suggestion: internalSuggestion('This session cannot be used. Call start_workflow to create a new session.', 'The session is in an unhealthy state.'),
          details: detailsSessionHealth(e.health) as unknown as JsonValue,
        },
      ) as ToolFailure;
    case 'SESSION_LOCK_REENTRANT':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED',
        'This session is already being modified by a concurrent call. Only one operation at a time is allowed per session.',
        1000,
        { suggestion: 'Wait for your other call to complete, then retry this one.' },
      ) as ToolFailure;
    case 'SESSION_LOAD_FAILED':
      return internalError(
        'WorkRail could not load the session data for this operation.',
        internalSuggestion('Retry the call.', 'WorkRail cannot load session data.'),
      );
    case 'LOCK_ACQUIRE_FAILED':
      return internalError(
        'WorkRail could not acquire a lock on this session.',
        internalSuggestion('Retry the call.', 'WorkRail is having trouble with session locking — check if another process is running.'),
      );
    case 'GATE_CALLBACK_FAILED':
      return internalError(
        'WorkRail encountered an error while processing this session operation. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail has an internal error.'),
      );
    default:
      const _exhaustive: never = e;
      return internalError(
        'WorkRail encountered an unexpected session error. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail has an internal error.'),
      );
  }
}

/** Map SnapshotStoreError to ToolFailure. */
export function snapshotStoreErrorToToolError(_e: SnapshotStoreError, _suggestion?: string): ToolFailure {
  return internalError(
    'WorkRail could not access its execution state data. This is not caused by your input.',
    internalSuggestion('Retry the call.', 'WorkRail has an internal storage error.'),
  );
}

/** Map PinnedWorkflowStoreError to ToolFailure. */
export function pinnedWorkflowStoreErrorToToolError(_e: PinnedWorkflowStoreError, _suggestion?: string): ToolFailure {
  return internalError(
    'WorkRail could not access the stored workflow definition. This is not caused by your input.',
    internalSuggestion('Retry the call.', 'WorkRail has an internal storage error.'),
  );
}

/** Map InternalError to ToolFailure. Exhaustive switch. */
export function mapInternalErrorToToolError(e: InternalError): ToolFailure {
  switch (e.kind) {
    case 'missing_node_or_run':
      return errNotRetryable(
        'PRECONDITION_FAILED',
        'The stateToken you provided does not match any active workflow session. It may be expired or from a different session.',
        { suggestion: 'Use the stateToken returned by the most recent start_workflow or continue_workflow call.' },
      ) as ToolFailure;
    case 'workflow_hash_mismatch':
      return errNotRetryable(
        'TOKEN_WORKFLOW_HASH_MISMATCH',
        'The stateToken refers to a different version of this workflow than what is currently stored.',
        { suggestion: 'Call start_workflow to create a new session with the current workflow version.' },
      ) as ToolFailure;
    case 'token_scope_mismatch':
      return errNotRetryable(
        'TOKEN_SCOPE_MISMATCH',
        'The stateToken and ackToken do not belong to the same session or node. Tokens must come from the same WorkRail response.',
        { suggestion: 'Use the stateToken and ackToken from the same continue_workflow or start_workflow response. Do not mix tokens from different calls.' },
      ) as ToolFailure;
    case 'missing_snapshot':
      return internalError(
        'WorkRail\'s execution state is incomplete — a required snapshot is missing. This is not caused by your input.',
        internalSuggestion('Retry the call, or call start_workflow to create a new session.', 'WorkRail has incomplete execution state.'),
      );
    case 'no_pending_step':
      return internalError(
        'There is no pending step to advance. The workflow may already be complete.',
        'Call continue_workflow with only a stateToken (no ackToken) to check the current workflow state.',
      );
    case 'invariant_violation':
      return internalError(
        'WorkRail encountered an unexpected error during workflow advancement. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail has an internal error during workflow advancement.'),
      );
    case 'advance_apply_failed':
      return internalError(
        'WorkRail could not record the workflow advancement. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail could not record the advancement.'),
      );
    case 'advance_next_failed':
      return internalError(
        'WorkRail could not compute the next workflow step. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail could not compute the next step.'),
      );
    default:
      const _exhaustive: never = e;
      return internalError(
        'WorkRail encountered an unexpected error. This is not caused by your input.',
        internalSuggestion('Retry the call.', 'WorkRail has an internal error.'),
      );
  }
}
