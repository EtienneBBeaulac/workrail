import type { AutonomyV2 } from '../schemas/session/preferences.js';
import { AUTONOMY_MODE, DELIMITER_SAFE_ID_PATTERN, MAX_BLOCKERS, MAX_BLOCKER_MESSAGE_BYTES, MAX_BLOCKER_SUGGESTED_FIX_BYTES } from '../constants.js';
import { err, ok, type Result } from 'neverthrow';
import { utf8ByteLength } from '../schemas/lib/utf8-byte-length.js';

export type CapabilityV2 = 'delegation' | 'web_browsing';
export type GapSeverityV1 = 'info' | 'warning' | 'critical';

export type UserOnlyDependencyReasonV1 =
  | 'needs_user_secret_or_token'
  | 'needs_user_account_access'
  | 'needs_user_artifact'
  | 'needs_user_choice'
  | 'needs_user_approval'
  | 'needs_user_environment_action';

export type GapReasonV1 =
  | { readonly category: 'user_only_dependency'; readonly detail: UserOnlyDependencyReasonV1 }
  | { readonly category: 'contract_violation'; readonly detail: 'missing_required_output' | 'invalid_required_output' | 'missing_required_notes' }
  | { readonly category: 'capability_missing'; readonly detail: 'required_capability_unavailable' | 'required_capability_unknown' }
  | { readonly category: 'unexpected'; readonly detail: 'invariant_violation' | 'storage_corruption_detected' | 'evaluation_error' };

export type BlockerCodeV1 =
  | 'USER_ONLY_DEPENDENCY'
  | 'MISSING_REQUIRED_OUTPUT'
  | 'INVALID_REQUIRED_OUTPUT'
  | 'MISSING_REQUIRED_NOTES'
  | 'MISSING_CONTEXT_KEY'
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'REQUIRED_CAPABILITY_UNKNOWN'
  | 'REQUIRED_CAPABILITY_UNAVAILABLE'
  | 'INVARIANT_VIOLATION'
  | 'STORAGE_CORRUPTION_DETECTED';

export type BlockerPointerV1 =
  | { readonly kind: 'context_key'; readonly key: string }
  | { readonly kind: 'context_budget' }
  | { readonly kind: 'output_contract'; readonly contractRef: string }
  | { readonly kind: 'capability'; readonly capability: CapabilityV2 }
  | { readonly kind: 'workflow_step'; readonly stepId: string };

export type BlockerV1 = {
  readonly code: BlockerCodeV1;
  readonly pointer: BlockerPointerV1;
  readonly message: string;
  readonly suggestedFix?: string;
};

export type BlockerReportV1 = {
  readonly blockers: readonly BlockerV1[];
};

export type ReasonV1 =
  | { readonly kind: 'missing_context_key'; readonly key: string }
  | { readonly kind: 'context_budget_exceeded' }
  | { readonly kind: 'missing_required_output'; readonly contractRef: string }
  | { readonly kind: 'invalid_required_output'; readonly contractRef: string }
  | { readonly kind: 'missing_notes'; readonly stepId: string }
  | { readonly kind: 'required_capability_unknown'; readonly capability: CapabilityV2 }
  | { readonly kind: 'required_capability_unavailable'; readonly capability: CapabilityV2 }
  | { readonly kind: 'user_only_dependency'; readonly detail: UserOnlyDependencyReasonV1; readonly stepId: string }
  | { readonly kind: 'invariant_violation' }
  | { readonly kind: 'storage_corruption_detected' }
  | { readonly kind: 'evaluation_error' };

export type ReasonModelError =
  | { readonly code: 'INVALID_DELIMITER_SAFE_ID'; readonly message: string }
  | { readonly code: 'INVALID_CONTRACT_REF'; readonly message: string }
  | { readonly code: 'BLOCKER_MESSAGE_TOO_LARGE'; readonly message: string }
  | { readonly code: 'BLOCKER_SUGGESTED_FIX_TOO_LARGE'; readonly message: string }
  | { readonly code: 'INVARIANT_VIOLATION'; readonly message: string };

function ensureDelimiterSafeId(label: string, value: string): Result<string, ReasonModelError> {
  if (!DELIMITER_SAFE_ID_PATTERN.test(value)) {
    return err({
      code: 'INVALID_DELIMITER_SAFE_ID',
      message: `${label} must be delimiter-safe: [a-z0-9_-]+`,
    });
  }
  return ok(value);
}

function ensureContractRef(contractRef: string): Result<string, ReasonModelError> {
  // Boundary validation: reasonToBlocker is a public API that can be called with arbitrary reasons.
  // While OutputRequirementStatus guarantees non-empty contractRef, this function validates
  // at its own boundary since it's exported and testable independently.
  if (contractRef.trim().length === 0) {
    return err({ code: 'INVALID_CONTRACT_REF', message: 'contractRef must be non-empty' });
  }
  return ok(contractRef);
}

function ensureBlockerTextBudgets(blocker: BlockerV1): Result<BlockerV1, ReasonModelError> {
  if (utf8ByteLength(blocker.message) > MAX_BLOCKER_MESSAGE_BYTES) {
    return err({
      code: 'BLOCKER_MESSAGE_TOO_LARGE',
      message: `blocker.message exceeds ${MAX_BLOCKER_MESSAGE_BYTES} UTF-8 bytes`,
    });
  }
  if (blocker.suggestedFix && utf8ByteLength(blocker.suggestedFix) > MAX_BLOCKER_SUGGESTED_FIX_BYTES) {
    return err({
      code: 'BLOCKER_SUGGESTED_FIX_TOO_LARGE',
      message: `blocker.suggestedFix exceeds ${MAX_BLOCKER_SUGGESTED_FIX_BYTES} UTF-8 bytes`,
    });
  }
  return ok(blocker);
}

export function reasonToGap(reason: ReasonV1): { readonly severity: GapSeverityV1; readonly reason: GapReasonV1; readonly summary: string } {
  switch (reason.kind) {
    case 'user_only_dependency':
      return {
        severity: 'critical',
        reason: { category: 'user_only_dependency', detail: reason.detail },
        summary: `User-only dependency: ${reason.detail} (stepId=${reason.stepId})`,
      };
    case 'missing_required_output':
      return {
        severity: 'critical',
        reason: { category: 'contract_violation', detail: 'missing_required_output' },
        summary: `Missing required output for contractRef=${reason.contractRef}`,
      };
    case 'invalid_required_output':
      return {
        severity: 'critical',
        reason: { category: 'contract_violation', detail: 'invalid_required_output' },
        summary: `Invalid required output for contractRef=${reason.contractRef}`,
      };
    case 'missing_notes':
      return {
        severity: 'critical',
        reason: { category: 'contract_violation', detail: 'missing_required_notes' },
        summary: `Missing required notes for stepId=${reason.stepId}`,
      };
    case 'required_capability_unknown':
      return {
        severity: 'critical',
        reason: { category: 'capability_missing', detail: 'required_capability_unknown' },
        summary: `Required capability status unknown: ${reason.capability}`,
      };
    case 'required_capability_unavailable':
      return {
        severity: 'critical',
        reason: { category: 'capability_missing', detail: 'required_capability_unavailable' },
        summary: `Required capability unavailable: ${reason.capability}`,
      };
    case 'storage_corruption_detected':
      return {
        severity: 'critical',
        reason: { category: 'unexpected', detail: 'storage_corruption_detected' },
        summary: 'Storage corruption detected',
      };
    case 'evaluation_error':
      return {
        severity: 'critical',
        reason: { category: 'unexpected', detail: 'evaluation_error' },
        summary: 'Validation evaluation failed',
      };
    case 'missing_context_key':
      return {
        severity: 'critical',
        reason: { category: 'unexpected', detail: 'invariant_violation' },
        summary: `Missing required context key: ${reason.key}`,
      };
    case 'context_budget_exceeded':
      return {
        severity: 'critical',
        reason: { category: 'unexpected', detail: 'invariant_violation' },
        summary: 'Context budget exceeded',
      };
    case 'invariant_violation':
      return {
        severity: 'critical',
        reason: { category: 'unexpected', detail: 'invariant_violation' },
        summary: 'Invariant violation',
      };
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function blockerSortKey(b: BlockerV1): string {
  const p = b.pointer;
  let ptrStable: string;
  switch (p.kind) {
    case 'context_key':
      ptrStable = p.key;
      break;
    case 'output_contract':
      ptrStable = p.contractRef;
      break;
    case 'capability':
      ptrStable = p.capability;
      break;
    case 'workflow_step':
      ptrStable = p.stepId;
      break;
    case 'context_budget':
      ptrStable = '';
      break;
    default: {
      const _exhaustive: never = p;
      ptrStable = _exhaustive;
    }
  }
  return `${b.code}|${p.kind}|${ptrStable}`;
}

export function reasonToBlocker(reason: ReasonV1): Result<BlockerV1, ReasonModelError> {
  switch (reason.kind) {
    case 'missing_context_key':
      return ensureDelimiterSafeId('context_key.key', reason.key)
        .map((key) => ({
          code: 'MISSING_CONTEXT_KEY' as const,
          pointer: { kind: 'context_key' as const, key },
          message: `Missing required context key: ${key}`,
          suggestedFix: `Include context.${key} (delimiter-safe key) in the next continue_workflow call.`,
        }))
        .andThen(ensureBlockerTextBudgets);

    case 'context_budget_exceeded':
      return ensureBlockerTextBudgets({
        code: 'CONTEXT_BUDGET_EXCEEDED',
        pointer: { kind: 'context_budget' },
        message: 'Context exceeded the allowed budget or was non-serializable.',
        suggestedFix: 'Remove large blobs from context and pass only small external inputs (IDs, paths, parameters).',
      });

    case 'missing_required_output':
      return ensureContractRef(reason.contractRef)
        .map((contractRef) => ({
          code: 'MISSING_REQUIRED_OUTPUT' as const,
          pointer: { kind: 'output_contract' as const, contractRef },
          message: `Missing required output (contractRef=${contractRef}).`,
          suggestedFix: 'Call continue_workflow WITHOUT ackToken to rehydrate and receive a fresh ackToken, then retry with output.notesMarkdown that satisfies the step output requirements.',
        }))
        .andThen(ensureBlockerTextBudgets);

    case 'invalid_required_output':
      return ensureContractRef(reason.contractRef)
        .map((contractRef) => ({
          code: 'INVALID_REQUIRED_OUTPUT' as const,
          pointer: { kind: 'output_contract' as const, contractRef },
          message: `Invalid output for contractRef=${contractRef}.`,
          suggestedFix: 'Update output.notesMarkdown to satisfy validation. Then call continue_workflow WITHOUT ackToken (rehydrate) to receive a fresh ackToken, and retry advance with that new ackToken. Replaying the same ackToken is idempotent and will keep returning this blocked result.',
        }))
        .andThen(ensureBlockerTextBudgets);

    case 'missing_notes':
      return ensureDelimiterSafeId('workflow_step.stepId', reason.stepId)
        .map((stepId) => ({
          code: 'MISSING_REQUIRED_NOTES' as const,
          pointer: { kind: 'workflow_step' as const, stepId },
          message: `Step "${stepId}" requires notes documenting your work (output.notesMarkdown).`,
          suggestedFix: 'Add output.notesMarkdown with a detailed recap: what you did, key decisions/trade-offs, what you produced (files, paths, numbers), and anything notable. Use markdown formatting. 10–30 lines. Use the retryAckToken to retry without rehydrating.',
        }))
        .andThen(ensureBlockerTextBudgets);

    case 'required_capability_unknown':
      return ensureBlockerTextBudgets({
        code: 'REQUIRED_CAPABILITY_UNKNOWN',
        pointer: { kind: 'capability', capability: reason.capability },
        message: `Required capability status is unknown: ${reason.capability}.`,
        suggestedFix: 'Probe the capability (or run the required tool) and retry.',
      });

    case 'required_capability_unavailable':
      return ensureBlockerTextBudgets({
        code: 'REQUIRED_CAPABILITY_UNAVAILABLE',
        pointer: { kind: 'capability', capability: reason.capability },
        message: `Required capability is unavailable: ${reason.capability}.`,
        suggestedFix: 'Enable the capability or choose an alternate approach that does not require it.',
      });

    case 'user_only_dependency':
      return ensureDelimiterSafeId('workflow_step.stepId', reason.stepId)
        .map((stepId) => ({
          code: 'USER_ONLY_DEPENDENCY' as const,
          pointer: { kind: 'workflow_step' as const, stepId },
          message: `Step requires user input: ${reason.detail}.`,
          suggestedFix: 'Ask the user for the required input/approval and retry.',
        }))
        .andThen(ensureBlockerTextBudgets);

    case 'invariant_violation':
      return ensureBlockerTextBudgets({
        code: 'INVARIANT_VIOLATION',
        pointer: { kind: 'context_budget' },
        message: 'Invariant violation: execution cannot safely proceed.',
        suggestedFix: 'Inspect the durable event log and pinned workflow snapshot for mismatches.',
      });

    case 'storage_corruption_detected':
      return ensureBlockerTextBudgets({
        code: 'STORAGE_CORRUPTION_DETECTED',
        pointer: { kind: 'context_budget' },
        message: 'Storage corruption detected: durable session data failed validation.',
        suggestedFix: 'Stop and investigate the session store; do not continue advancing this session.',
      });

    case 'evaluation_error':
      return ensureBlockerTextBudgets({
        code: 'INVARIANT_VIOLATION',
        pointer: { kind: 'context_budget' },
        message: 'Validation evaluation failed: ValidationEngine encountered an error.',
        suggestedFix: 'Check validation criteria for malformed rules or circular references.',
      });

    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Build a blocker report from blocking reasons.
 * 
 * Note: With the blocked nodes architectural upgrade (ADR 008), blockers are now stored in
 * blocked_attempt node snapshots rather than advance_recorded outcomes. This function is still
 * used to build blocker reports, but they're attached to blocked snapshots instead.
 */
export function buildBlockerReport(reasons: readonly ReasonV1[]): Result<BlockerReportV1, ReasonModelError> {
  const blockers: BlockerV1[] = [];
  for (const reason of reasons) {
    const b = reasonToBlocker(reason);
    if (b.isErr()) return err(b.error);
    blockers.push(b.value);
  }

  blockers.sort((a, b) => blockerSortKey(a).localeCompare(blockerSortKey(b), 'en-US'));

  return ok({ blockers: blockers.slice(0, MAX_BLOCKERS) });
}

/**
 * Determine if execution should block based on autonomy mode and reasons.
 * 
 * Lock: §10 Mode-driven blocking behavior
 * 
 * Blocking logic:
 * - No reasons → Never block (nothing preventing execution)
 * - full_auto_never_stop → Never block (record gaps instead)
 * - guided / full_auto_stop_on_user_deps → Block if any reasons present
 * 
 * This is the core mode-driven decision point that determines whether
 * missing requirements cause blocked (halts execution) or gap_recorded
 * (continues with gap logged).
 * 
 * @param autonomy - Current autonomy mode from preferences
 * @param reasons - Array of blocking reasons from detectBlockingReasonsV1
 * @returns true if execution should halt (emit blocked), false to continue
 */
export function shouldBlock(autonomy: AutonomyV2, reasons: readonly ReasonV1[]): boolean {
  if (reasons.length === 0) return false;
  return autonomy !== AUTONOMY_MODE.FULL_AUTO_NEVER_STOP;
}
