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
 * Standard escalation suffix for internal error suggestions.
 * Tells the agent exactly what to provide when the user needs to report the issue.
 */
const ESCALATION_SUFFIX =
  ' To report this, share the name of the tool you called, the input you provided, and this error message with the user so they can forward it to the WorkRail developer.';

/**
 * Build an internal error suggestion with standard escalation guidance.
 * @param retryAdvice - What the agent should try first (e.g. "Retry the call.")
 * @param userMessage - What to tell the user if the retry doesn't work
 */
export function internalSuggestion(retryAdvice: string, userMessage: string): string {
  return `${retryAdvice} If the error persists, tell the user: "${userMessage}"${ESCALATION_SUFFIX}`;
}

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
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail encountered an unexpected error while starting the workflow. This is not caused by your input.',
        { suggestion: internalSuggestion('Retry start_workflow.', 'WorkRail has an internal error.') },
      );

    case 'validation_failed':
      return e.failure;

    case 'workflow_not_found':
      return errNotRetryable('NOT_FOUND', `Workflow not found: ${e.workflowId}`, {
        suggestion: 'Call list_workflows to see available workflows and verify the workflowId.',
      });

    case 'workflow_has_no_steps':
      return errNotRetryable('PRECONDITION_FAILED', `Workflow "${e.workflowId}" has no steps and cannot be started.`, {
        suggestion: 'Tell the user: "This workflow definition is empty (no steps). The workflow JSON file needs to be fixed."',
      });

    case 'keyring_load_failed':
      return mapKeyringErrorToToolError(e.cause);

    case 'hash_computation_failed':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail could not compute a content hash for the workflow definition. This is not caused by your input.',
        { suggestion: internalSuggestion('Retry start_workflow.', 'WorkRail has an internal error computing workflow hashes.') },
      );

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
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail encountered an unexpected error while continuing the workflow. This is not caused by your input.',
        { suggestion: internalSuggestion('Retry continue_workflow.', 'WorkRail has an internal error.') },
      );

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
      return errNotRetryable('PRECONDITION_FAILED',
        'The stored workflow definition for this session is missing. The session may have been created with a different WorkRail data directory.',
        { suggestion: 'Call start_workflow again to create a fresh session for this workflow.' },
      );

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
  if (e.code === 'TOKEN_INVALID_FORMAT' && e.details?.bech32mError) {
    const bech32mErr = e.details.bech32mError;
    
    if (bech32mErr.code === 'BECH32M_CHECKSUM_FAILED') {
      return errNotRetryable(
        'TOKEN_INVALID_FORMAT',
        'Token corrupted (bech32m checksum failed). Likely copy/paste error.',
        {
          suggestion: 'Use the exact token string as returned. Do not truncate or modify it.',
          details: {
            errorType: 'corruption_detected',
            estimatedPosition: bech32mErr.position ?? null,
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
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail could not create a security token for this operation. This is not caused by your input.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal error creating tokens.') },
      );

    case 'KEYRING_INVALID':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail\'s security keys are in an invalid state and cannot sign tokens.',
        { suggestion: internalSuggestion('', 'WorkRail\'s security keys need to be regenerated. Delete the .workrail/v2 data directory and restart.') },
      );

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
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail could not read its security keys from disk.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail cannot access its security keys. Check that the ~/.workrail directory is readable.') },
      );

    case 'KEYRING_CORRUPTION_DETECTED':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail\'s security keys are corrupted and cannot be used.',
        { suggestion: internalSuggestion('', 'WorkRail\'s security keys are corrupted. Delete the .workrail/v2 directory and restart WorkRail to regenerate them.') },
      );

    case 'KEYRING_INVARIANT_VIOLATION':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail\'s security key system encountered an unexpected error. This is not caused by your input.',
        { suggestion: internalSuggestion('', 'WorkRail has an internal error with its security keys.') },
      );

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
      return errRetryAfterMs('INTERNAL_ERROR',
        'The session is temporarily busy (another operation is in progress).',
        e.retry.afterMs,
        { suggestion: internalSuggestion('Retry this call in a few seconds.', 'Another WorkRail process may be accessing this session.') },
      );

    case 'SESSION_STORE_CORRUPTION_DETECTED':
      return errNotRetryable('SESSION_NOT_HEALTHY',
        'This session\'s data is corrupted and cannot be used.',
        {
          suggestion: `This session cannot be recovered. Call start_workflow to create a new session for this workflow.${ESCALATION_SUFFIX}`,
          details: detailsSessionHealth({ kind: e.location === 'head' ? 'corrupt_head' : 'corrupt_tail', reason: e.reason }) as unknown as JsonValue,
        },
      );

    case 'SESSION_STORE_IO_ERROR':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail could not read or write session data to disk.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail cannot access its data files. Check that the ~/.workrail directory exists and is writable.') },
      );

    case 'SESSION_STORE_INVARIANT_VIOLATION':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail encountered an unexpected error with session storage. This is not caused by your input.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal storage error.') },
      );

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
      return errRetryAfterMs('TOKEN_SESSION_LOCKED',
        'This session is currently being modified by another operation.',
        e.retry.afterMs,
        { suggestion: internalSuggestion('Wait a moment and retry this call.', 'Another WorkRail process may be accessing this session.') },
      );

    case 'LOCK_RELEASE_FAILED':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED',
        'A previous operation on this session did not release cleanly.',
        e.retry.afterMs,
        { suggestion: 'Wait a moment and retry this call. The lock will auto-expire shortly.' },
      );

    case 'SESSION_NOT_HEALTHY':
      return errNotRetryable('SESSION_NOT_HEALTHY',
        'This session is in an unhealthy state and cannot accept new operations.',
        {
          suggestion: `This session cannot be used. Call start_workflow to create a new session.${ESCALATION_SUFFIX}`,
          details: detailsSessionHealth(e.health) as unknown as JsonValue,
        },
      );

    case 'SESSION_LOCK_REENTRANT':
      return errRetryAfterMs('TOKEN_SESSION_LOCKED',
        'This session is already being modified by a concurrent call you made. Only one operation at a time is allowed per session.',
        1000,
        { suggestion: 'Wait for your other call to complete, then retry this one.' },
      );

    case 'SESSION_LOAD_FAILED':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail could not load the session data for this operation.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail cannot load session data.') },
      );

    case 'LOCK_ACQUIRE_FAILED':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail could not acquire a lock on this session.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail is having trouble with session locking — check if another WorkRail process is running.') },
      );

    case 'GATE_CALLBACK_FAILED':
      return errNotRetryable('INTERNAL_ERROR',
        'WorkRail encountered an error while processing this session operation. This is not caused by your input.',
        { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal error.') },
      );

    default:
      const _exhaustive: never = e;
      return _exhaustive;
  }
}

/**
 * Map SnapshotStoreError to ToolFailure.
 * Snapshot errors are internal and non-recoverable.
 */
export function mapSnapshotStoreErrorToToolError(e: SnapshotStoreError, _suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR',
    'WorkRail could not access its execution state data. This is not caused by your input.',
    { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal storage error.') },
  );
}

/**
 * Map PinnedWorkflowStoreError to ToolFailure.
 * Pinned workflow store errors are internal and non-recoverable.
 */
export function mapPinnedWorkflowStoreErrorToToolError(e: PinnedWorkflowStoreError, _suggestion?: string): ToolFailure {
  return errNotRetryable('INTERNAL_ERROR',
    'WorkRail could not access the stored workflow definition. This is not caused by your input.',
    { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal storage error.') },
  );
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

// ── Token Minting Helpers ───────────────────────────────────────────────

// Note: The user requested a mintAndSignTokenOrFail helper, but after analyzing the codebase,
// the actual pattern being used is signTokenOrErr from v2-token-ops.ts, which already handles
// the complete minting pipeline. The duplication is not in the low-level encoding/signing,
// but rather in the high-level token creation patterns. For now, we keep the v2-token-ops.ts
// helper as-is and don't add a duplicate abstraction here.

// ── Prompt Rendering Helpers ──────────────────────────────────────────────

import type { LoopPathFrameV1 } from '../../v2/durable-core/schemas/execution-snapshot/index.js';
import type { RunId, NodeId } from '../../v2/durable-core/ids/index.js';
import type { LoadedSessionTruthV2 } from '../../v2/ports/session-event-log-store.port.js';
import { renderPendingPrompt, type StepMetadata } from '../../v2/durable-core/domain/prompt-renderer.js';

/**
 * Render a pending prompt with fallback to default metadata.
 * Used in replay and rehydrate paths where prompt rendering should not fail.
 *
 * @param args - Workflow, step details, truth, and scope identifiers
 * @returns PromptOutputV1 (always succeeds, falls back on error)
 */
export function renderPendingPromptOrDefault(args: {
  readonly workflow: ReturnType<typeof import('../../types/workflow.js').createWorkflow>;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly rehydrateOnly: boolean;
}): StepMetadata {
  return renderPendingPrompt({
    workflow: args.workflow,
    stepId: args.stepId,
    loopPath: args.loopPath,
    truth: args.truth,
    runId: args.runId,
    nodeId: args.nodeId,
    rehydrateOnly: args.rehydrateOnly,
  }).unwrapOr({
    stepId: args.stepId,
    title: args.stepId,
    prompt: `Pending step: ${args.stepId}`,
    requireConfirmation: false,
  });
}

// ── Preferences Derivation Helpers ────────────────────────────────────────

import { EVENT_KIND } from '../../v2/durable-core/constants.js';
import { projectPreferencesV2 } from '../../v2/projections/preferences.js';

/**
 * Preferences output shape for WorkRail v2 tools.
 */
export type PreferencesV2 = {
  readonly autonomy: 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
  readonly riskPolicy: 'conservative' | 'balanced' | 'aggressive';
};

/**
 * Default preferences when derivation fails or no preferences are set.
 */
export const defaultPreferences: PreferencesV2 = { 
  autonomy: 'guided', 
  riskPolicy: 'conservative' 
};

/**
 * Derive effective preferences for a node, with fallback to defaults.
 * Builds parent map inline and projects preferences from durable events.
 *
 * @param args - Truth, runId, and nodeId
 * @returns PreferencesV2 (always succeeds, falls back on error)
 */
export function derivePreferencesOrDefault(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
  readonly nodeId: NodeId;
}): PreferencesV2 {
  // Build parent map from node_created events
  const parentByNodeId: Record<string, string | null> = {};
  for (const e of args.truth.events) {
    if (e.kind !== EVENT_KIND.NODE_CREATED) continue;
    if (e.scope?.runId !== String(args.runId)) continue;
    parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
  }

  // Project preferences and extract for target node
  const prefs = projectPreferencesV2(args.truth.events, parentByNodeId);
  if (prefs.isErr()) return defaultPreferences;
  
  const p = prefs.value.byNodeId[String(args.nodeId)]?.effective;
  return p ? { autonomy: p.autonomy, riskPolicy: p.riskPolicy } : defaultPreferences;
}
