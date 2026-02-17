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
import type { ToolFailure } from './v2-execution-helpers.js';

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
      return errRetryAfterMs('INTERNAL_ERROR', normalizeTokenErrorMessage(e.message), e.retry.afterMs, {
        suggestion: 'Another WorkRail process may be writing to this session; retry.',
      }) as ToolFailure;
    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return errNotRetryable('SESSION_NOT_HEALTHY', `Session corruption detected: ${e.reason.code}`, {
        suggestion: 'Execution requires a healthy session. Export salvage view, then recreate.',
        details: detailsSessionHealth({ kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail', reason: e.reason }) as unknown as JsonValue,
      }) as ToolFailure;
    case 'SESSION_STORE_IO_ERROR':
      return internalError(e.message, 'Retry; check filesystem permissions.');
    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return internalError(e.message, 'Treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown session store error', 'Treat as invariant violation.');
  }
}

/** Map ExecutionSessionGateErrorV2 to ToolFailure. Exhaustive switch. */
export function gateErrorToToolError(e: ExecutionSessionGateErrorV2): ToolFailure {
  switch (e.code) {
    case 'SESSION_LOCKED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'LOCK_RELEASE_FAILED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, { suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.' }) as ToolFailure;
    case 'SESSION_NOT_HEALTHY':
      return errNotRetryable('SESSION_NOT_HEALTHY', e.message, { suggestion: 'Execution requires healthy session.', details: detailsSessionHealth(e.health) as unknown as JsonValue }) as ToolFailure;
    case 'SESSION_LOCK_REENTRANT':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, 1000, {
        suggestion: 'Session is locked by concurrent execution. Retry in 1 second.',
      }) as ToolFailure;
    case 'SESSION_LOAD_FAILED':
    case 'LOCK_ACQUIRE_FAILED':
    case 'GATE_CALLBACK_FAILED':
      return internalError(e.message, 'Retry; if persists, treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown gate error', 'Treat as invariant violation.');
  }
}

/** Map SnapshotStoreError to ToolFailure. */
export function snapshotStoreErrorToToolError(e: SnapshotStoreError, suggestion?: string): ToolFailure {
  return internalError(`Snapshot store error: ${e.message}`, suggestion);
}

/** Map PinnedWorkflowStoreError to ToolFailure. */
export function pinnedWorkflowStoreErrorToToolError(e: PinnedWorkflowStoreError, suggestion?: string): ToolFailure {
  return internalError(`Pinned workflow store error: ${e.message}`, suggestion);
}

/** Map InternalError to ToolFailure. Exhaustive switch. */
export function mapInternalErrorToToolError(e: InternalError): ToolFailure {
  switch (e.kind) {
    case 'missing_node_or_run':
      return errNotRetryable(
        'PRECONDITION_FAILED',
        'No durable run/node state was found for this stateToken. Advancement cannot be recorded.',
        { suggestion: 'Use a stateToken returned by WorkRail for an existing run/node.' }
      ) as ToolFailure;
    case 'workflow_hash_mismatch':
      return errNotRetryable(
        'TOKEN_WORKFLOW_HASH_MISMATCH',
        'workflowHash mismatch for this node.',
        { suggestion: 'Use the stateToken returned by WorkRail for this node.' }
      ) as ToolFailure;
    case 'token_scope_mismatch':
      return errNotRetryable(
        'TOKEN_SCOPE_MISMATCH',
        normalizeTokenErrorMessage(e.message),
        { suggestion: 'Use the correct token type for this operation.' }
      ) as ToolFailure;
    case 'missing_snapshot':
    case 'no_pending_step':
      return internalError('Incomplete execution state.', 'Retry; if this persists, treat as invariant violation.');
    case 'invariant_violation':
      return internalError(normalizeTokenErrorMessage(e.message), 'Treat as invariant violation.');
    case 'advance_apply_failed':
    case 'advance_next_failed':
      return internalError(normalizeTokenErrorMessage(e.message), 'Retry; if this persists, treat as invariant violation.');
    default:
      const _exhaustive: never = e;
      return internalError('Unknown internal error kind', 'Treat as invariant violation.');
  }
}
