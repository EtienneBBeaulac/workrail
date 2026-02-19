/**
 * Template Resolution Compiler Pass
 *
 * Replaces steps with `templateCall` with the expanded steps from the
 * template registry. Runs FIRST in the compiler pipeline — before
 * features, refs, and promptBlocks rendering.
 *
 * Why first: templates produce real steps that may use promptBlocks,
 * refs, and features. All subsequent passes operate on the expanded steps.
 *
 * Pure function — no I/O, no mutation.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { TemplateRegistry, TemplateResolveError, TemplateExpandError } from './template-registry.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../types/workflow-definition.js';
import { isLoopStepDefinition } from '../../../types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ResolveTemplatesPassError =
  | { readonly code: 'TEMPLATE_RESOLVE_ERROR'; readonly stepId: string; readonly cause: TemplateResolveError }
  | { readonly code: 'TEMPLATE_EXPAND_ERROR'; readonly stepId: string; readonly cause: TemplateExpandError };

// ---------------------------------------------------------------------------
// Step-level template resolution
// ---------------------------------------------------------------------------

function resolveStepTemplate(
  step: WorkflowStepDefinition,
  registry: TemplateRegistry,
): Result<readonly WorkflowStepDefinition[], ResolveTemplatesPassError> {
  if (!step.templateCall) return ok([step]);

  const { templateId, args } = step.templateCall;

  // Resolve the template expander
  const expanderResult = registry.resolve(templateId);
  if (expanderResult.isErr()) {
    return err({
      code: 'TEMPLATE_RESOLVE_ERROR',
      stepId: step.id,
      cause: expanderResult.error,
    });
  }

  // Expand the template
  const expandResult = expanderResult.value(step.id, args ?? {});
  if (expandResult.isErr()) {
    return err({
      code: 'TEMPLATE_EXPAND_ERROR',
      stepId: step.id,
      cause: expandResult.error,
    });
  }

  return ok(expandResult.value);
}

// ---------------------------------------------------------------------------
// Compiler pass
// ---------------------------------------------------------------------------

/**
 * Compiler pass: expand all template_call steps into real steps.
 *
 * Must run FIRST in the pipeline (before features, refs, blocks).
 * Template calls in loop body steps are also expanded.
 * Pure function — no I/O, no mutation.
 */
export function resolveTemplatesPass(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
  registry: TemplateRegistry,
): Result<readonly (WorkflowStepDefinition | LoopStepDefinition)[], ResolveTemplatesPassError> {
  const resolved: (WorkflowStepDefinition | LoopStepDefinition)[] = [];

  for (const step of steps) {
    if (isLoopStepDefinition(step)) {
      // Loop steps themselves cannot be template calls (loops have their own structure).
      // But inline body steps can be template calls.
      if (Array.isArray(step.body)) {
        const bodyResolved: WorkflowStepDefinition[] = [];
        for (const bodyStep of step.body) {
          const res = resolveStepTemplate(bodyStep, registry);
          if (res.isErr()) return err(res.error);
          bodyResolved.push(...res.value);
        }
        resolved.push({ ...step, body: bodyResolved } as LoopStepDefinition);
      } else {
        resolved.push(step);
      }
    } else {
      const res = resolveStepTemplate(step, registry);
      if (res.isErr()) return err(res.error);
      // Template expansion may produce multiple steps — splice them in
      resolved.push(...res.value);
    }
  }

  return ok(resolved);
}
