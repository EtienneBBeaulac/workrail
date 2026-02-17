import { err, ok, type Result } from 'neverthrow';
import type { Sha256PortV2 } from '../../ports/sha256.port.js';
import type { AttemptId } from '../ids/index.js';
import { deriveChildAttemptId } from '../ids/attempt-id-derivation.js';
import type { ExecutionSnapshotFileV1, EngineStateV1 } from '../schemas/execution-snapshot/index.js';
import type { BlockedSnapshotV1, ContractViolationReasonV1, TerminalReasonV1 } from '../schemas/execution-snapshot/index.js';
import type { BlockerReportV1, ReasonV1 } from './reason-model.js';

export type BlockedNodeBuildError =
  | { readonly code: 'BLOCKED_NODE_INVARIANT_VIOLATION'; readonly message: string }
  | { readonly code: 'BLOCKED_NODE_UNSUPPORTED_STATE'; readonly message: string };

function toContractViolationReason(reason: ReasonV1): ContractViolationReasonV1 | null {
  switch (reason.kind) {
    case 'invalid_required_output':
      return { kind: 'invalid_required_output', contractRef: reason.contractRef };
    case 'missing_required_output':
      return { kind: 'missing_required_output', contractRef: reason.contractRef };
    case 'missing_context_key':
      return { kind: 'missing_context_key', key: reason.key };
    case 'context_budget_exceeded':
      return { kind: 'context_budget_exceeded' };
    default:
      return null;
  }
}

function toTerminalReason(reason: ReasonV1): TerminalReasonV1 | null {
  switch (reason.kind) {
    case 'user_only_dependency':
      return { kind: 'user_only_dependency', detail: reason.detail, stepId: reason.stepId };
    case 'required_capability_unknown':
      return { kind: 'required_capability_unknown', capability: reason.capability };
    case 'required_capability_unavailable':
      return { kind: 'required_capability_unavailable', capability: reason.capability };
    case 'invariant_violation':
      return { kind: 'invariant_violation' };
    case 'storage_corruption_detected':
      return { kind: 'storage_corruption_detected' };
    case 'evaluation_error':
      return { kind: 'evaluation_error' };
    default:
      return null;
  }
}

function buildBlockedPayload(args: {
  readonly primaryReason: ReasonV1;
  readonly attemptId: AttemptId;
  readonly validationRef: string;
  readonly blockers: BlockerReportV1;
  readonly sha256: Sha256PortV2;
}): Result<BlockedSnapshotV1, BlockedNodeBuildError> {
  const retryable = toContractViolationReason(args.primaryReason);
  if (retryable) {
    const retryAttemptIdRes = deriveChildAttemptId(args.attemptId, args.sha256);
    if (retryAttemptIdRes.isErr()) {
      return err({
        code: 'BLOCKED_NODE_INVARIANT_VIOLATION',
        message: `Failed to derive retry attemptId: ${retryAttemptIdRes.error.message}`,
      });
    }
    return ok({
      kind: 'retryable_block',
      reason: retryable,
      retryAttemptId: String(retryAttemptIdRes.value),
      validationRef: args.validationRef,
      blockers: args.blockers,
    });
  }

  const terminal = toTerminalReason(args.primaryReason);
  if (terminal) {
    return ok({
      kind: 'terminal_block',
      reason: terminal,
      validationRef: args.validationRef,
      blockers: args.blockers,
    });
  }

  return err({
    code: 'BLOCKED_NODE_INVARIANT_VIOLATION',
    message: `Unsupported primary reason for blocked snapshot: ${args.primaryReason.kind}`,
  });
}

export function buildBlockedNodeSnapshot(args: {
  readonly priorSnapshot: ExecutionSnapshotFileV1;
  readonly primaryReason: ReasonV1;
  readonly attemptId: AttemptId;
  readonly validationRef: string;
  readonly blockers: BlockerReportV1;
  readonly sha256: Sha256PortV2;
}): Result<ExecutionSnapshotFileV1, BlockedNodeBuildError> {
  const state = args.priorSnapshot.enginePayload.engineState as EngineStateV1;
  
  // Accept both running and blocked states (blocked state occurs when chaining retries)
  if (state.kind !== 'running' && state.kind !== 'blocked') {
    return err({
      code: 'BLOCKED_NODE_UNSUPPORTED_STATE',
      message: `Blocked nodes can only be created from running or blocked state (got: ${state.kind})`,
    });
  }

  const blockedRes = buildBlockedPayload({
    primaryReason: args.primaryReason,
    attemptId: args.attemptId,
    validationRef: args.validationRef,
    blockers: args.blockers,
    sha256: args.sha256,
  });
  if (blockedRes.isErr()) return err(blockedRes.error);

  return ok({
    ...args.priorSnapshot,
    enginePayload: {
      ...args.priorSnapshot.enginePayload,
      engineState: {
        kind: 'blocked',
        completed: state.completed,
        loopStack: state.loopStack,
        pending: state.pending,
        blocked: blockedRes.value,
      },
    },
  });
}
