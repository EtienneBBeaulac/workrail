import { err, ok, type Result } from 'neverthrow';
import type { ValidationResult } from '../../../types/validation.js';
import { DELIMITER_SAFE_ID_PATTERN } from '../constants.js';
import type { ReasonV1 } from './reason-model.js';

export type BlockingDecisionError = {
  readonly code: 'INVALID_DELIMITER_SAFE_ID';
  readonly message: string;
};

export type OutputRequirementStatus =
  | { readonly kind: 'not_required' }
  | { readonly kind: 'satisfied' }
  | { readonly kind: 'missing'; readonly contractRef: string }
  | { readonly kind: 'invalid'; readonly contractRef: string; readonly validation: ValidationResult };

export type CapabilityRequirementStatus =
  | { readonly kind: 'not_required' }
  | { readonly kind: 'unknown'; readonly capability: 'delegation' | 'web_browsing' }
  | { readonly kind: 'unavailable'; readonly capability: 'delegation' | 'web_browsing' };

/**
 * Detect blocking reasons from current execution state.
 * 
 * Analyzes missing context, budget violations, output requirements, and capability
 * requirements to determine what's preventing execution from continuing.
 * 
 * Lock: §9 Blocking reason detection (mode-driven behavior)
 * 
 * Returns discriminated union of blocking reasons:
 * - context_budget_exceeded: Context too large
 * - missing_context_key: Required context field missing
 * - missing_required_output: Step requires output that's not provided
 * - invalid_required_output: Output provided but validation failed
 * - missing_capability: Required capability not available
 * 
 * @param args.missingContextKeys - Context keys referenced but not provided
 * @param args.contextBudgetExceeded - Whether context exceeds MAX_CONTEXT_BYTES
 * @param args.outputRequirement - Output requirement status from validator
 * @param args.capabilityRequirement - Capability requirement status
 * @returns Array of blocking reasons, or error if context key invalid
 */
export function detectBlockingReasonsV1(args: {
  readonly missingContextKeys?: readonly string[];
  readonly contextBudgetExceeded?: boolean;
  readonly outputRequirement?: OutputRequirementStatus;
  readonly capabilityRequirement?: CapabilityRequirementStatus;
  /**
   * When present, notes are required but were not provided.
   * The stepId is included for the blocker pointer (workflow_step kind).
   *
   * Absent when notes are optional (outputContract steps, or notesOptional: true).
   */
  readonly missingNotes?: { readonly stepId: string };
}): Result<readonly ReasonV1[], BlockingDecisionError> {
  const reasons: ReasonV1[] = [];

  if (args.contextBudgetExceeded) {
    reasons.push({ kind: 'context_budget_exceeded' });
  }

  if (args.missingContextKeys) {
    for (const key of args.missingContextKeys) {
      if (!DELIMITER_SAFE_ID_PATTERN.test(key)) {
        return err({
          code: 'INVALID_DELIMITER_SAFE_ID',
          message: `context key must be delimiter-safe: [a-z0-9_-]+ (got: ${key})`,
        });
      }
      reasons.push({ kind: 'missing_context_key', key });
    }
  }

  const outReq = args.outputRequirement;
  if (outReq) {
    switch (outReq.kind) {
      case 'not_required':
      case 'satisfied':
        break;
      case 'missing':
        reasons.push({ kind: 'missing_required_output', contractRef: outReq.contractRef });
        break;
      case 'invalid':
        // We do not embed the full validator output in the durable reason; we only persist the closed-set code.
        reasons.push({ kind: 'invalid_required_output', contractRef: outReq.contractRef });
        break;
      default: {
        const _exhaustive: never = outReq;
        return _exhaustive;
      }
    }
  }

  const capReq = args.capabilityRequirement;
  if (capReq) {
    switch (capReq.kind) {
      case 'not_required':
        break;
      case 'unknown':
        reasons.push({ kind: 'required_capability_unknown', capability: capReq.capability });
        break;
      case 'unavailable':
        reasons.push({ kind: 'required_capability_unavailable', capability: capReq.capability });
        break;
      default: {
        const _exhaustive: never = capReq;
        return _exhaustive;
      }
    }
  }

  if (args.missingNotes) {
    if (!DELIMITER_SAFE_ID_PATTERN.test(args.missingNotes.stepId)) {
      return err({
        code: 'INVALID_DELIMITER_SAFE_ID',
        message: `step ID must be delimiter-safe: [a-z0-9_-]+ (got: ${args.missingNotes.stepId})`,
      });
    }
    reasons.push({ kind: 'missing_notes', stepId: args.missingNotes.stepId });
  }

  return ok(reasons);
}
