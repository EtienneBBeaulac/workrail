/**
 * Input validation for advance operations.
 * Validates and normalizes inputs at the boundary.
 */

import { ok, err, type Result } from 'neverthrow';
import type { RunId, NodeId } from '../../../v2/durable-core/ids/index.js';
import type { LoadedSessionTruthV2 } from '../../../v2/ports/session-event-log-store.port.js';
import type { JsonValue, JsonObject } from '../../../v2/durable-core/canonical/json-types.js';
import type { V2ContinueWorkflowInput } from '../../v2/tools.js';
import type { OutputContract } from '../../../types/workflow-definition.js';
import type { ValidationCriteria } from '../../../types/validation.js';

import { getStepById } from '../../../types/workflow.js';
import { projectRunContextV2 } from '../../../v2/projections/run-context.js';
import { projectPreferencesV2 } from '../../../v2/projections/preferences.js';
import { mergeContext } from '../../../v2/durable-core/domain/context-merge.js';
import type { InternalError } from '../v2-error-mapping.js';
import { EVENT_KIND } from '../../../v2/durable-core/constants.js';

/**
 * Result of validating advance inputs at the boundary.
 * Once constructed, the core logic can trust all fields without re-checking.
 */
export interface ValidatedAdvanceInputs {
  readonly pendingStep: { readonly stepId: string; readonly loopPath: readonly { readonly loopId: string; readonly iteration: number }[] };
  readonly mergedContext: Record<string, unknown>;
  readonly inputContextObj: JsonObject | undefined;
  readonly validationCriteria: ValidationCriteria | undefined;
  readonly outputContract: OutputContract | undefined;
  readonly notesMarkdown: string | undefined;
  readonly artifacts: readonly unknown[];
  readonly autonomy: 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
  readonly riskPolicy: 'conservative' | 'balanced' | 'aggressive';
  readonly effectivePrefs: { readonly autonomy: string; readonly riskPolicy: string } | undefined;
  /**
   * When true, notes are NOT required for this step.
   *
   * Auto-derived from step definition:
   * - `outputContract` present → true (artifact IS the evidence; notes are supplemental)
   * - `notesOptional: true` explicitly set → true
   * - Otherwise → false (notes are required; omitting them blocks the advance)
   */
  readonly notesOptional: boolean;
}

export function validateAdvanceInputs(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
  readonly currentNodeId: NodeId;
  readonly inputContext: JsonValue | undefined;
  readonly inputOutput: V2ContinueWorkflowInput['output'];
  readonly pinnedWorkflow: ReturnType<typeof import('../../../types/workflow.js').createWorkflow>;
  readonly pendingStep: { readonly stepId: string; readonly loopPath: readonly { readonly loopId: string; readonly iteration: number }[] };
}): Result<ValidatedAdvanceInputs, InternalError> {
  const { truth, runId, currentNodeId, inputContext, inputOutput, pinnedWorkflow, pendingStep } = args;

  // Context merge
  const storedContextRes = projectRunContextV2(truth.events);
  const storedContext = storedContextRes.isOk() ? storedContextRes.value.byRunId[String(runId)]?.context : undefined;

  const inputContextObj =
    inputContext && typeof inputContext === 'object' && inputContext !== null && !Array.isArray(inputContext)
      ? (inputContext as JsonObject)
      : undefined;

  const mergedContextRes = mergeContext(storedContext, inputContextObj);
  if (mergedContextRes.isErr()) {
    return err({ kind: 'invariant_violation' as const, message: `Context merge failed: ${mergedContextRes.error.message}` });
  }

  // Step metadata — getStepById returns WorkflowStepDefinition | LoopStepDefinition | null,
  // both of which carry validationCriteria? and outputContract? as typed fields.
  const step = getStepById(pinnedWorkflow, pendingStep.stepId);
  const validationCriteria = step?.validationCriteria;
  const outputContract = step?.outputContract;

  // Auto-derive notesOptional.
  // outputContract steps: artifact is primary evidence → notes are supplemental (no enforcement).
  // notesOptional: true explicitly set: author opted out for mechanical steps.
  // Everything else: notes are required; omitting them blocks the advance.
  const notesOptional =
    outputContract !== undefined ||
    (step !== null && step !== undefined && 'notesOptional' in step && step.notesOptional === true);

  // Preferences
  const parentByNodeId: Record<string, string | null> = {};
  for (const e of truth.events) {
    if (e.kind !== EVENT_KIND.NODE_CREATED) continue;
    if (e.scope?.runId !== String(runId)) continue;
    parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
  }
  const prefs = projectPreferencesV2(truth.events, parentByNodeId);
  const effectivePrefs = prefs.isOk() ? prefs.value.byNodeId[String(currentNodeId)]?.effective : undefined;
  const rawAutonomy = effectivePrefs?.autonomy ?? 'guided';
  const rawRiskPolicy = effectivePrefs?.riskPolicy ?? 'conservative';

  // Validate at boundary — narrow from string to literal union, fail fast on unknown values
  const VALID_AUTONOMY = ['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop'] as const;
  const VALID_RISK_POLICY = ['conservative', 'balanced', 'aggressive'] as const;

  if (!VALID_AUTONOMY.includes(rawAutonomy as typeof VALID_AUTONOMY[number])) {
    return err({ kind: 'invariant_violation' as const, message: `Unknown autonomy mode: ${rawAutonomy}` });
  }
  if (!VALID_RISK_POLICY.includes(rawRiskPolicy as typeof VALID_RISK_POLICY[number])) {
    return err({ kind: 'invariant_violation' as const, message: `Unknown risk policy: ${rawRiskPolicy}` });
  }

  const autonomy = rawAutonomy as typeof VALID_AUTONOMY[number];
  const riskPolicy = rawRiskPolicy as typeof VALID_RISK_POLICY[number];

  return ok({
    pendingStep,
    mergedContext: mergedContextRes.value as Record<string, unknown>,
    inputContextObj,
    validationCriteria,
    outputContract,
    notesMarkdown: inputOutput?.notesMarkdown,
    artifacts: inputOutput?.artifacts ?? [],
    autonomy,
    riskPolicy,
    effectivePrefs,
    notesOptional,
  });
}
