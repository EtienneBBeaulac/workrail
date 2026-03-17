/**
 * Template Registry — Step Expansion
 *
 * Maps `wr.templates.*` IDs to template expansion functions.
 * Templates expand a single step into one or more real steps at compile time.
 *
 * Supports two sources of templates:
 * 1. Static (WorkRail-owned) template definitions
 * 2. Routine-derived templates — routine JSON steps injected via templateCall
 *
 * Templates produce steps that become part of the compiled workflow hash.
 * Deterministic: same input always produces same output.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { WorkflowStepDefinition, WorkflowDefinition } from '../../../types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Template definition types
// ---------------------------------------------------------------------------

/**
 * A template expansion function.
 *
 * Takes the calling step's ID (used as prefix for expanded step IDs)
 * and optional args, returns one or more real steps.
 *
 * Pure function — no I/O, deterministic.
 */
export type TemplateExpander = (
  callerId: string,
  args: Readonly<Record<string, unknown>>,
) => Result<readonly WorkflowStepDefinition[], TemplateExpandError>;

export type TemplateExpandError = {
  readonly code: 'TEMPLATE_EXPAND_FAILED';
  readonly templateId: string;
  readonly message: string;
};

export type TemplateResolveError = {
  readonly code: 'UNKNOWN_TEMPLATE';
  readonly templateId: string;
  readonly message: string;
};

/** Read-only lookup interface for template resolution. */
export interface TemplateRegistry {
  readonly resolve: (templateId: string) => Result<TemplateExpander, TemplateResolveError>;
  readonly has: (templateId: string) => boolean;
  readonly knownIds: () => readonly string[];
}

// ---------------------------------------------------------------------------
// Routine-to-template bridge
// ---------------------------------------------------------------------------

/** Single-brace arg pattern: matches {argName} but not {{contextVar}}.
 * Uses negative lookbehind/lookahead to skip double-brace context variables. */
const SINGLE_BRACE_ARG = /(?<!\{)\{([^{}]+)\}(?!\})/g;

/**
 * Substitute single-brace `{argName}` placeholders in a string.
 * Double-brace `{{contextVar}}` patterns are left untouched (runtime context).
 *
 * Returns the substituted string, or an error listing unresolved args.
 */
function substituteArgs(
  text: string,
  args: Readonly<Record<string, unknown>>,
  routineId: string,
  stepId: string,
): Result<string, TemplateExpandError> {
  const missing: string[] = [];

  const substituted = text.replace(SINGLE_BRACE_ARG, (match, argName: string) => {
    if (argName in args) {
      return String(args[argName]);
    }
    missing.push(argName);
    return match; // leave in place for error reporting
  });

  if (missing.length > 0) {
    return err({
      code: 'TEMPLATE_EXPAND_FAILED',
      templateId: `wr.templates.routine.${routineId}`,
      message: `MISSING_TEMPLATE_ARG: routine '${routineId}' step '${stepId}' references arg(s) '${missing.join("', '")}' but they were not provided in templateCall.args`,
    });
  }

  return ok(substituted);
}

/**
 * Validate that a routine's steps don't contain templateCall (no recursive injection).
 */
function validateNoRecursiveTemplateCall(
  routineId: string,
  steps: readonly WorkflowStepDefinition[],
): Result<void, TemplateExpandError> {
  for (const step of steps) {
    if (step.templateCall) {
      return err({
        code: 'TEMPLATE_EXPAND_FAILED',
        templateId: `wr.templates.routine.${routineId}`,
        message: `Routine '${routineId}' step '${step.id}' contains a templateCall. Recursive routine injection is not supported.`,
      });
    }
  }
  return ok(undefined);
}

/**
 * Create a TemplateExpander from a routine definition.
 *
 * Maps routine steps to WorkflowStepDefinition[] with:
 * - Step ID prefixing (callerId.stepId)
 * - Single-brace arg substitution on prompts
 * - Routine metaGuidance injected as step-level guidance
 * - Validation: required fields, no unresolved args, no recursive templateCall
 *
 * Pure function — no I/O.
 */
export function createRoutineExpander(
  routineId: string,
  definition: WorkflowDefinition,
): Result<TemplateExpander, TemplateExpandError> {
  const routineSteps = definition.steps as readonly WorkflowStepDefinition[];

  // Validate no recursive templateCall at registration time
  const recursiveCheck = validateNoRecursiveTemplateCall(routineId, routineSteps);
  if (recursiveCheck.isErr()) return err(recursiveCheck.error);

  // Validate required fields on all steps
  for (const step of routineSteps) {
    if (!step.id || !step.title) {
      return err({
        code: 'TEMPLATE_EXPAND_FAILED',
        templateId: `wr.templates.routine.${routineId}`,
        message: `Routine '${routineId}' step '${step.id ?? '(missing id)'}' is missing required field '${!step.id ? 'id' : 'title'}'.`,
      });
    }
    if (!step.prompt) {
      return err({
        code: 'TEMPLATE_EXPAND_FAILED',
        templateId: `wr.templates.routine.${routineId}`,
        message: `Routine '${routineId}' step '${step.id}' is missing required field 'prompt'.`,
      });
    }
  }

  const routineGuidance = definition.metaGuidance ?? [];

  const expander: TemplateExpander = (
    callerId: string,
    args: Readonly<Record<string, unknown>>,
  ): Result<readonly WorkflowStepDefinition[], TemplateExpandError> => {
    const expandedSteps: WorkflowStepDefinition[] = [];

    for (const step of routineSteps) {
      // Substitute args in prompt
      const promptResult = substituteArgs(step.prompt!, args, routineId, step.id);
      if (promptResult.isErr()) return err(promptResult.error);

      // Merge routine metaGuidance into step-level guidance (Option B from design)
      const mergedGuidance: readonly string[] = routineGuidance.length > 0
        ? [...(step.guidance ?? []), ...routineGuidance]
        : (step.guidance ?? []);

      const expandedStep: WorkflowStepDefinition = {
        id: `${callerId}.${step.id}`,
        title: step.title,
        prompt: promptResult.value,
        ...(step.agentRole !== undefined && { agentRole: step.agentRole }),
        ...(mergedGuidance.length > 0 && { guidance: mergedGuidance }),
        ...(step.requireConfirmation !== undefined && { requireConfirmation: step.requireConfirmation }),
      };

      expandedSteps.push(expandedStep);
    }

    return ok(expandedSteps);
  };

  return ok(expander);
}

/**
 * Derive the template ID for a routine.
 * Convention: routine "routine-tension-driven-design" -> "wr.templates.routine.tension-driven-design"
 */
export function routineIdToTemplateId(routineId: string): string {
  const name = routineId.startsWith('routine-') ? routineId.slice('routine-'.length) : routineId;
  return `wr.templates.routine.${name}`;
}

// ---------------------------------------------------------------------------
// Canonical template definitions (closed set, WorkRail-owned)
// ---------------------------------------------------------------------------

// Static templates (empty for now — added in future PRs).
const STATIC_TEMPLATE_DEFINITIONS = new Map<string, TemplateExpander>();

// ---------------------------------------------------------------------------
// Registry constructor
// ---------------------------------------------------------------------------

/**
 * Create the template registry.
 *
 * Merges static (WorkRail-owned) templates with routine-derived templates.
 * Routine definitions are optional — when absent, only static templates are available.
 *
 * Returns the registry and any errors encountered during routine expander creation
 * (routine errors are non-fatal to the registry itself — invalid routines are skipped
 * and reported).
 */
export function createTemplateRegistry(
  routineDefinitions?: ReadonlyMap<string, WorkflowDefinition>,
): TemplateRegistry {
  const allTemplates = new Map<string, TemplateExpander>(STATIC_TEMPLATE_DEFINITIONS);

  // Register routine-derived templates
  if (routineDefinitions) {
    for (const [routineId, definition] of routineDefinitions) {
      const templateId = routineIdToTemplateId(routineId);
      const expanderResult = createRoutineExpander(routineId, definition);
      if (expanderResult.isOk()) {
        allTemplates.set(templateId, expanderResult.value);
      }
      // Invalid routines are silently skipped — they can still be used via delegation
    }
  }

  const knownIds = [...allTemplates.keys()];

  return {
    resolve(templateId: string): Result<TemplateExpander, TemplateResolveError> {
      const expander = allTemplates.get(templateId);
      if (!expander) {
        return err({
          code: 'UNKNOWN_TEMPLATE',
          templateId,
          message: `Unknown template '${templateId}'. Known templates: ${knownIds.length > 0 ? knownIds.join(', ') : '(none)'}`,
        });
      }
      return ok(expander);
    },

    has(templateId: string): boolean {
      return allTemplates.has(templateId);
    },

    knownIds(): readonly string[] {
      return knownIds;
    },
  };
}
