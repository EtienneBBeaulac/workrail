/**
 * v2 Execution Helpers
 *
 * Typed error unions and pure helper functions for refactoring v2 execution handlers.
 * This module provides:
 * - Closed-set error unions for handler-level errors (exhaustive switching required)
 * - Error mappers from domain errors to handler errors
 * - Pure functions returning ResultAsync instead of throwing
 *
 * Philosophy: all errors are typed data; no exceptions leak from core logic.
 */

import type { JsonValue } from '../output-schemas.js';
import { errNotRetryable, errRetryAfterMs } from '../types.js';

// Import v2 error types
import type { WorkflowId, WorkflowHash } from '../../v2/durable-core/ids/index.js';
import type { ExecutionSessionGateErrorV2 } from '../../v2/usecases/execution-session-gate.js';
import type { SessionEventLogStoreError } from '../../v2/ports/session-event-log-store.port.js';
import type { SnapshotStoreError } from '../../v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStoreError } from '../../v2/ports/pinned-workflow-store.port.js';
import type { KeyringError } from '../../v2/ports/keyring.port.js';
import type { TokenDecodeErrorV2, TokenVerifyErrorV2, TokenSignErrorV2 } from '../../v2/durable-core/tokens/index.js';
import { detailsSessionHealth } from '../types.js';

/**
 * Convenience type for tool error results.
 * Extract<ToolResult<never>, { type: 'error' }>
 */
export type ToolFailure = ReturnType<typeof errNotRetryable> | ReturnType<typeof errRetryAfterMs>;

/**
 * Typed error union for start_workflow handler.
 *
 * Philosophy: explicit closed set; exhaustive switching required at compile time.
 * Every variant must be handled in mapStartWorkflowErrorToToolError.
 */
export type StartWorkflowError =
  | { readonly kind: 'precondition_failed'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'invariant_violation'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'validation_failed'; readonly failure: ToolFailure }
  | { readonly kind: 'workflow_not_found'; readonly workflowId: WorkflowId }
  | { readonly kind: 'workflow_has_no_steps'; readonly workflowId: WorkflowId }
  | { readonly kind: 'keyring_load_failed'; readonly cause: KeyringError }
  | { readonly kind: 'hash_computation_failed'; readonly message: string }
  | { readonly kind: 'pinned_workflow_store_failed'; readonly cause: PinnedWorkflowStoreError }
  | { readonly kind: 'snapshot_creation_failed'; readonly cause: SnapshotStoreError }
  | { readonly kind: 'session_append_failed'; readonly cause: ExecutionSessionGateErrorV2 | SessionEventLogStoreError }
  | { readonly kind: 'token_signing_failed'; readonly cause: TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2 };

/**
 * Typed error union for continue_workflow handler.
 *
 * Philosophy: explicit closed set; exhaustive switching required at compile time.
 * Every variant must be handled in mapContinueWorkflowErrorToToolError.
 */
export type ContinueWorkflowError =
  | { readonly kind: 'precondition_failed'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'token_unknown_node'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'invariant_violation'; readonly message: string; readonly suggestion?: string }
  | { readonly kind: 'validation_failed'; readonly failure: ToolFailure }
  | { readonly kind: 'token_decode_failed'; readonly cause: TokenDecodeErrorV2 }
  | { readonly kind: 'token_verify_failed'; readonly cause: TokenVerifyErrorV2 }
  | { readonly kind: 'keyring_load_failed'; readonly cause: KeyringError }
  | { readonly kind: 'session_load_failed'; readonly cause: SessionEventLogStoreError }
  | { readonly kind: 'snapshot_load_failed'; readonly cause: SnapshotStoreError }
  | { readonly kind: 'pinned_workflow_store_failed'; readonly cause: PinnedWorkflowStoreError }
  | { readonly kind: 'pinned_workflow_missing'; readonly workflowHash: WorkflowHash }
  | { readonly kind: 'token_signing_failed'; readonly cause: TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2 }
  | { readonly kind: 'advance_execution_failed'; readonly cause: ExecutionSessionGateErrorV2 | SessionEventLogStoreError };

/**
 * Map StartWorkflowError to ToolFailure.
 *
 * Exhaustive: if a new variant is added to StartWorkflowError,
 * the switch statement will fail to compile.
 *
 * @param e - The error to map
 * @returns A ToolFailure to return to the client
 */
export function mapStartWorkflowErrorToToolError(e: StartWorkflowError): ToolFailure {
  switch (e.kind) {
    case 'precondition_failed':
      return errNotRetryable('PRECONDITION_FAILED', e.message, e.suggestion ? { suggestion: e.suggestion } : undefined);

    case 'invariant_violation':
      return errNotRetryable('INTERNAL_ERROR', e.message, e.suggestion ? { suggestion: e.suggestion } : undefined);

    case 'validation_failed':
      return e.failure;

    case 'workflow_not_found':
      return errNotRetryable('NOT_FOUND', `Workflow not found: ${e.workflowId}`, {
        suggestion: 'Use list_workflows to discover available workflows.',
      });

    case 'workflow_has_no_steps':
      return errNotRetryable('PRECONDITION_FAILED', 'Workflow has no steps and cannot be started.', {
        suggestion: 'Fix the workflow definition (must contain at least one step).',
      });

    case 'keyring_load_failed':
      return mapKeyringErrorToToolError(e.cause);

    case 'hash_computation_failed':
      return errNotRetryable('INTERNAL_ERROR', `Failed to compute workflow hash: ${e.message}`, {
        suggestion: 'Retry start_workflow; if this persists, treat as invariant violation.',
      });

    case 'pinned_workflow_store_failed':
      return mapPinnedWorkflowStoreErrorToToolError(e.cause);

    case 'snapshot_creation_failed':
      return mapSnapshotStoreErrorToToolError(e.cause);

    case 'session_append_failed':
      return mapSessionOrGateErrorToToolError(e.cause);

    case 'token_signing_failed':
      return mapTokenSigningErrorToToolError(e.cause);

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map ContinueWorkflowError to ToolFailure.
 *
 * Exhaustive: if a new variant is added to ContinueWorkflowError,
 * the switch statement will fail to compile.
 *
 * @param e - The error to map
 * @returns A ToolFailure to return to the client
 */
export function mapContinueWorkflowErrorToToolError(e: ContinueWorkflowError): ToolFailure {
  switch (e.kind) {
    case 'precondition_failed':
      return errNotRetryable('PRECONDITION_FAILED', e.message, e.suggestion ? { suggestion: e.suggestion } : undefined);

    case 'token_unknown_node':
      return errNotRetryable('TOKEN_UNKNOWN_NODE', e.message, e.suggestion ? { suggestion: e.suggestion } : undefined);

    case 'invariant_violation':
      return errNotRetryable('INTERNAL_ERROR', e.message, e.suggestion ? { suggestion: e.suggestion } : undefined);

    case 'validation_failed':
      return e.failure;

    case 'token_decode_failed':
      return mapTokenDecodeErrorToToolError(e.cause);

    case 'token_verify_failed':
      return mapTokenVerifyErrorToToolError(e.cause);

    case 'keyring_load_failed':
      return mapKeyringErrorToToolError(e.cause);

    case 'session_load_failed':
      return mapSessionEventLogStoreErrorToToolError(e.cause);

    case 'snapshot_load_failed':
      return mapSnapshotStoreErrorToToolError(e.cause);

    case 'pinned_workflow_store_failed':
      return mapPinnedWorkflowStoreErrorToToolError(e.cause);

    case 'pinned_workflow_missing':
      return errNotRetryable('PRECONDITION_FAILED', `Pinned workflow snapshot is missing for hash: ${e.workflowHash}`, {
        suggestion: 'Re-run start_workflow or re-pin the workflow via inspect_workflow.',
      });

    case 'token_signing_failed':
      return mapTokenSigningErrorToToolError(e.cause);

    case 'advance_execution_failed':
      return mapSessionOrGateErrorToToolError(e.cause);

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map TokenDecodeErrorV2 to ToolFailure.
 * Used for token parsing/format errors.
 *
 * @param e - Token decode error
 * @returns ToolFailure with user-facing guidance
 */
export function mapTokenDecodeErrorToToolError(e: TokenDecodeErrorV2): ToolFailure {
  // Bech32m-specific error enrichment
  if (e.code === 'TOKEN_INVALID_FORMAT' && (e as any).details?.bech32mError) {
    const bech32mErr = (e as any).details.bech32mError;
    
    if (bech32mErr.code === 'BECH32M_CHECKSUM_FAILED') {
      return errNotRetryable(
        'TOKEN_INVALID_FORMAT',
        'Token corrupted (bech32m checksum failed). Likely copy/paste error.',
        {
          suggestion: 'Copy the entire token string exactly as returned. Use triple-click to select the complete line.',
          details: {
            errorType: 'corruption_detected',
            estimatedPosition: bech32mErr.position,
            tokenFormat: 'binary+bech32m',
          },
        }
      );
    }
    
    if (bech32mErr.code === 'BECH32M_HRP_MISMATCH') {
      return errNotRetryable(
        'TOKEN_INVALID_FORMAT',
        `Wrong token type. ${e.message}`,
        {
          suggestion: 'Ensure you are using the correct token (stateToken vs ackToken) for this operation.',
          details: {
            errorType: 'hrp_mismatch',
          },
        }
      );
    }
  }
  
  switch (e.code) {
    case 'TOKEN_INVALID_FORMAT':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.',
      });

    case 'TOKEN_UNSUPPORTED_VERSION':
      return errNotRetryable('TOKEN_UNSUPPORTED_VERSION', e.message, {
        suggestion: 'Update WorkRail to a version that supports this token format.',
      });

    case 'TOKEN_SCOPE_MISMATCH':
      return errNotRetryable('TOKEN_SCOPE_MISMATCH', e.message, {
        suggestion: 'Tokens must come from the same WorkRail response. Do not mix tokens from different runs or nodes.',
      });

    case 'TOKEN_PAYLOAD_INVALID':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail.',
      });

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map TokenVerifyErrorV2 to ToolFailure.
 * Used for token signature verification errors.
 *
 * @param e - Token verification error
 * @returns ToolFailure with user-facing guidance
 */
export function mapTokenVerifyErrorToToolError(e: TokenVerifyErrorV2): ToolFailure {
  switch (e.code) {
    case 'TOKEN_BAD_SIGNATURE':
      return errNotRetryable('TOKEN_BAD_SIGNATURE', e.message, {
        suggestion: 'Token signature verification failed. Use the exact tokens returned by WorkRail.',
      });

    case 'TOKEN_INVALID_FORMAT':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail.',
      });

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map TokenDecodeErrorV2 | TokenVerifyErrorV2 to ToolFailure.
 *
 * Exhaustive switch on the union of both error types. Since some codes overlap
 * (TOKEN_INVALID_FORMAT exists in both), we map to the same user-facing error.
 * Compile error if a new code is added without a handler.
 *
 * @param e - Token error (decode or verify)
 * @returns ToolFailure with user-facing guidance
 */
export function mapTokenSigningErrorToToolError(e: TokenDecodeErrorV2 | TokenVerifyErrorV2 | TokenSignErrorV2): ToolFailure {
  switch (e.code) {
    // Decode-specific codes
    case 'TOKEN_UNSUPPORTED_VERSION':
      return errNotRetryable('TOKEN_UNSUPPORTED_VERSION', e.message, {
        suggestion: 'Update WorkRail to a version that supports this token format.',
      });

    case 'TOKEN_SCOPE_MISMATCH':
      return errNotRetryable('TOKEN_SCOPE_MISMATCH', e.message, {
        suggestion: 'Tokens must come from the same WorkRail response. Do not mix tokens from different runs or nodes.',
      });

    case 'TOKEN_PAYLOAD_INVALID':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail.',
      });

    // Signing-specific codes
    case 'TOKEN_ENCODE_FAILED':
      return errNotRetryable('INTERNAL_ERROR', `Token encoding failed: ${e.message}`, {
        suggestion: 'Retry; if this persists, treat as invariant violation.',
      });

    case 'KEYRING_INVALID':
      return errNotRetryable('INTERNAL_ERROR', `Keyring invalid: ${e.message}`, {
        suggestion: 'Regenerate v2 keyring by deleting the v2 data directory and retrying.',
      });

    // Verify-specific code
    case 'TOKEN_BAD_SIGNATURE':
      return errNotRetryable('TOKEN_BAD_SIGNATURE', e.message, {
        suggestion: 'Token signature verification failed. Use the exact tokens returned by WorkRail.',
      });

    // Shared code (exists in both types)
    case 'TOKEN_INVALID_FORMAT':
      return errNotRetryable('TOKEN_INVALID_FORMAT', e.message, {
        suggestion: 'Use the exact tokens returned by WorkRail. Tokens are opaque; do not edit or construct them.',
      });

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map KeyringError to ToolFailure.
 * Keyring errors are internal and non-recoverable (no retryable variants).
 *
 * @param e - Keyring error
 * @returns ToolFailure
 */
export function mapKeyringErrorToToolError(e: KeyringError): ToolFailure {
  switch (e.code) {
    case 'KEYRING_IO_ERROR':
      return errNotRetryable('INTERNAL_ERROR', `Keyring I/O error: ${e.message}`, {
        suggestion: 'Retry; check filesystem permissions. If this persists, treat as invariant violation.',
      });

    case 'KEYRING_CORRUPTION_DETECTED':
      return errNotRetryable('INTERNAL_ERROR', `Keyring corruption detected: ${e.message}`, {
        suggestion: 'Delete the WorkRail v2 data directory for this repo and retry.',
      });

    case 'KEYRING_INVARIANT_VIOLATION':
      return errNotRetryable('INTERNAL_ERROR', `Keyring invariant violation: ${e.message}`, {
        suggestion: 'Treat as invariant violation.',
      });

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map SessionEventLogStoreError to ToolFailure.
 * Handles lock contention (retryable) vs. corruption/IO (non-retryable).
 *
 * @param e - Session store error
 * @returns ToolFailure (may be retryable depending on error kind)
 */
export function mapSessionEventLogStoreErrorToToolError(e: SessionEventLogStoreError): ToolFailure {
  switch (e.code) {
    case 'SESSION_STORE_LOCK_BUSY':
      return errRetryAfterMs('INTERNAL_ERROR', e.message, e.retry.afterMs, {
        suggestion: 'Another WorkRail process may be writing to this session; retry.',
      });

    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return errNotRetryable('SESSION_NOT_HEALTHY', `Session corruption detected: ${e.reason.code}`, {
        suggestion: 'Execution requires a healthy session. Export salvage view, then recreate.',
        details: detailsSessionHealth({ kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail', reason: e.reason }) as unknown as JsonValue,
      });

    case 'SESSION_STORE_IO_ERROR':
      return errNotRetryable('INTERNAL_ERROR', e.message, {
        suggestion: 'Retry; check filesystem permissions.',
      });

    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return errNotRetryable('INTERNAL_ERROR', e.message, {
        suggestion: 'Treat as invariant violation.',
      });

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map ExecutionSessionGateErrorV2 to ToolFailure.
 * Handles lock contention, health issues, and gate failures.
 *
 * @param e - Gate error
 * @returns ToolFailure (may be retryable depending on error kind)
 */
export function mapExecutionSessionGateErrorToToolError(e: ExecutionSessionGateErrorV2): ToolFailure {
  switch (e.code) {
    case 'SESSION_LOCKED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, {
        suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.',
      });

    case 'LOCK_RELEASE_FAILED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, e.retry.afterMs, {
        suggestion: 'Retry in 1–3 seconds; if this persists >10s, ensure no other WorkRail process is running.',
      });

    case 'SESSION_NOT_HEALTHY':
      return errNotRetryable('SESSION_NOT_HEALTHY', e.message, {
        suggestion: 'Execution requires healthy session.',
        details: detailsSessionHealth(e.health) as unknown as JsonValue,
      });

    case 'SESSION_LOCK_REENTRANT':
      // Concurrent execution detected (in-process or cross-process).
      // This is a retryable condition per design locks (agents can make parallel tool calls).
      return errRetryAfterMs('TOKEN_SESSION_LOCKED', e.message, 1000, {
        suggestion: 'Session is currently locked by concurrent execution. Retry in 1 second.',
      });

    case 'SESSION_LOAD_FAILED':
    case 'LOCK_ACQUIRE_FAILED':
    case 'GATE_CALLBACK_FAILED':
      return errNotRetryable('INTERNAL_ERROR', e.message, {
        suggestion: 'Retry; if this persists, treat as invariant violation.',
      });

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map SnapshotStoreError to ToolFailure.
 * Snapshot errors are internal and non-recoverable.
 *
 * @param e - Snapshot store error
 * @param suggestion - Optional custom suggestion
 * @returns ToolFailure
 */
export function mapSnapshotStoreErrorToToolError(e: SnapshotStoreError, suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR', `Snapshot store error: ${e.message}`, {
    suggestion: suggestion ?? 'Retry; if this persists, treat as invariant violation.',
  });
}

/**
 * Map PinnedWorkflowStoreError to ToolFailure.
 * Pinned workflow store errors are internal and non-recoverable.
 *
 * @param e - Pinned workflow store error
 * @param suggestion - Optional custom suggestion
 * @returns ToolFailure
 */
export function mapPinnedWorkflowStoreErrorToToolError(e: PinnedWorkflowStoreError, suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR', `Pinned workflow store error: ${e.message}`, {
    suggestion: suggestion ?? 'Retry; if this persists, treat as invariant violation.',
  });
}

/**
 * Dispatch SessionEventLogStoreError or ExecutionSessionGateErrorV2 to appropriate mapper.
 * Used in handlers where either error type may be returned.
 *
 * Discriminates on `code` property, which differs between the two error types.
 * Gate codes and store codes are disjoint, so exhaustive switching works correctly.
 *
 * @param e - The error (either session store or gate)
 * @returns ToolFailure
 */
export function mapSessionOrGateErrorToToolError(e: SessionEventLogStoreError | ExecutionSessionGateErrorV2): ToolFailure {
  // All gate codes (ExecutionSessionGateErrorV2)
  if (
    e.code === 'SESSION_LOCKED' ||
    e.code === 'LOCK_RELEASE_FAILED' ||
    e.code === 'SESSION_NOT_HEALTHY' ||
    e.code === 'SESSION_LOAD_FAILED' ||
    e.code === 'SESSION_LOCK_REENTRANT' ||
    e.code === 'LOCK_ACQUIRE_FAILED' ||
    e.code === 'GATE_CALLBACK_FAILED'
  ) {
    return mapExecutionSessionGateErrorToToolError(e as ExecutionSessionGateErrorV2);
  }

  // All store codes (SessionEventLogStoreError)
  if (
    e.code === 'SESSION_STORE_LOCK_BUSY' ||
    e.code === 'SESSION_STORE_IO_ERROR' ||
    e.code === 'SESSION_STORE_CORRUPTION_DETECTED' ||
    e.code === 'SESSION_STORE_INVARIANT_VIOLATION'
  ) {
    return mapSessionEventLogStoreErrorToToolError(e as SessionEventLogStoreError);
  }

  // Exhaustiveness guard
  const _exhaustive: never = e;
  return _exhaustive;
}
