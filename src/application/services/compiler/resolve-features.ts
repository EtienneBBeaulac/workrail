/**
 * Feature Resolution Compiler Pass
 *
 * Applies declared features to all steps that use promptBlocks.
 * Features inject content into promptBlocks sections (constraints,
 * procedure, verify). Runs BEFORE ref resolution, since features
 * may inject refs that need resolving.
 *
 * Steps using raw `prompt` strings are not modified — features only
 * apply to promptBlocks-based steps. This is intentional: raw prompt
 * steps are fully authored by the workflow author.
 *
 * Pure function — no I/O, no mutation.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { FeatureRegistry, FeatureDefinition, FeatureResolveError } from './feature-registry.js';
import type { PromptBlocks, PromptValue } from './prompt-blocks.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../types/workflow-definition.js';
import { isLoopStepDefinition } from '../../../types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ResolveFeaturesPassError =
  | { readonly code: 'FEATURE_RESOLVE_ERROR'; readonly cause: FeatureResolveError }
  | { readonly code: 'FEATURE_ON_RAW_PROMPT_STEP'; readonly stepId: string; readonly message: string };

// ---------------------------------------------------------------------------
// Block merging — append feature content to existing blocks
// ---------------------------------------------------------------------------

function appendValues(
  existing: readonly PromptValue[] | undefined,
  injected: readonly PromptValue[] | undefined,
): readonly PromptValue[] | undefined {
  if (!injected || injected.length === 0) return existing;
  if (!existing || existing.length === 0) return injected;
  return [...existing, ...injected];
}

/** Merge feature injections into a step's promptBlocks. */
function applyFeatureToBlocks(
  blocks: PromptBlocks,
  feature: FeatureDefinition,
): PromptBlocks {
  return {
    ...blocks,
    constraints: appendValues(blocks.constraints, feature.constraints),
    procedure: appendValues(blocks.procedure, feature.procedure),
    verify: appendValues(blocks.verify, feature.verify),
  };
}

/** Apply all features to a step's promptBlocks. */
function applyFeaturesToStep(
  step: WorkflowStepDefinition,
  features: readonly FeatureDefinition[],
): WorkflowStepDefinition {
  if (!step.promptBlocks || features.length === 0) return step;

  let blocks = step.promptBlocks;
  for (const feature of features) {
    blocks = applyFeatureToBlocks(blocks, feature);
  }
  return { ...step, promptBlocks: blocks };
}

// ---------------------------------------------------------------------------
// Compiler pass
// ---------------------------------------------------------------------------

/**
 * Compiler pass: apply declared features to all promptBlocks-based steps.
 *
 * Must run BEFORE resolveRefsPass (features may inject refs).
 * Pure function — no I/O, no mutation.
 *
 * @param steps - workflow steps
 * @param featureIds - declared feature IDs from WorkflowDefinition.features
 * @param registry - feature registry for looking up definitions
 */
export function resolveFeaturesPass(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
  featureIds: readonly string[],
  registry: FeatureRegistry,
): Result<readonly (WorkflowStepDefinition | LoopStepDefinition)[], ResolveFeaturesPassError> {
  if (featureIds.length === 0) return ok(steps);

  // Resolve all feature IDs upfront (fail fast on unknown)
  const features: FeatureDefinition[] = [];
  for (const id of featureIds) {
    const res = registry.resolve(id);
    if (res.isErr()) {
      return err({ code: 'FEATURE_RESOLVE_ERROR', cause: res.error });
    }
    features.push(res.value);
  }

  // Apply features to each step
  const resolved: (WorkflowStepDefinition | LoopStepDefinition)[] = [];

  for (const step of steps) {
    if (isLoopStepDefinition(step)) {
      // Apply to the loop step itself
      const resolvedLoop = applyFeaturesToStep(step, features);

      // Apply to inline body steps
      if (Array.isArray(step.body)) {
        const bodyResolved = step.body.map(bodyStep =>
          applyFeaturesToStep(bodyStep, features)
        );
        resolved.push({
          ...step,
          ...(resolvedLoop.promptBlocks ? { promptBlocks: resolvedLoop.promptBlocks } : {}),
          body: bodyResolved,
        } as LoopStepDefinition);
      } else {
        resolved.push({
          ...step,
          ...(resolvedLoop.promptBlocks ? { promptBlocks: resolvedLoop.promptBlocks } : {}),
        } as LoopStepDefinition);
      }
    } else {
      resolved.push(applyFeaturesToStep(step, features));
    }
  }

  return ok(resolved);
}
