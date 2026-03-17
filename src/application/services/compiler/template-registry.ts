/**
 * Template Registry — Step Expansion with Routine Injection
 *
 * Maps `wr.templates.*` IDs to template expansion functions.
 * Templates expand a single step into one or more real steps at compile time.
 *
 * Two sources of template expanders:
 * 1. Built-in (closed-set, WorkRail-owned) — defined in TEMPLATE_DEFINITIONS
 * 2. Routine-derived — created from routine JSON definitions via createRoutineExpander()
 *
 * Routine-derived expanders use the naming convention:
 *   wr.templates.routine.<routine-id-without-routine-prefix>
 *   e.g., routine-tension-driven-design -> wr.templates.routine.tension-driven-design
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
// Routine-to-template expansion
// ---------------------------------------------------------------------------

/** Single-brace arg pattern: {argName} but NOT {{contextVar}} */
const SINGLE_BRACE_ARG = /(?<!\{)\{([^{}]+)\}(?!\})/g;

/**
 * Validates that a template arg value is a substitutable primitive.
 * Objects/arrays would silently produce "[object Object]" — reject them
 * at compile time rather than producing broken prompts at runtime.
 */
function isSubstitutableValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Substitute single-brace `{argName}` placeholders in a string.
 * Double-brace `{{contextVar}}` patterns are left untouched (runtime interpolation).
 *
 * Limitation: no escape mechanism for literal single-brace patterns.
 * Workaround: use double-braces or rephrase.
 */
function substituteArgs(
  template: string,
  args: Readonly<Record<string, unknown>>,
  templateId: string,
  routineId: string,
  stepId: string,
): Result<string, TemplateExpandError> {
  const missing: string[] = [];
  const badType: string[] = [];

  const result = template.replace(SINGLE_BRACE_ARG, (match, argName: string) => {
    if (!(argName in args)) {
      missing.push(argName);
      return match;
    }
    const value = args[argName];
    if (!isSubstitutableValue(value)) {
      badType.push(argName);
      return match;
    }
    return String(value);
  });

  if (missing.length > 0) {
    return err({
      code: 'TEMPLATE_EXPAND_FAILED',
      templateId,
      message: `MISSING_TEMPLATE_ARG: routine '${routineId}' step '${stepId}' references arg(s) '${missing.join("', '")}' but they were not provided in templateCall.args`,
    });
  }

  if (badType.length > 0) {
    return err({
      code: 'TEMPLATE_EXPAND_FAILED',
      templateId,
      message: `INVALID_TEMPLATE_ARG_TYPE: routine '${routineId}' step '${stepId}' arg(s) '${badType.join("', '")}' must be string, number, or boolean (got non-primitive)`,
    });
  }

  return ok(result);
}

/**
 * Convert a routine's ID to its template registry key.
 * Strips the "routine-" prefix if present.
 *
 * routine-tension-driven-design -> wr.templates.routine.tension-driven-design
 * context-gathering -> wr.templates.routine.context-gathering
 */
export function routineIdToTemplateId(routineId: string): string {
  const name = routineId.startsWith('routine-') ? routineId.slice('routine-'.length) : routineId;
  return `wr.templates.routine.${name}`;
}

/**
 * Create a TemplateExpander from a routine definition.
 *
 * Pure function. The expander:
 * - Maps routine steps to WorkflowStepDefinition[]
 * - Prefixes step IDs with callerId for provenance
 * - Performs {arg} substitution on step prompts
 * - Injects routine metaGuidance as step-level guidance
 * - Validates required fields (id, title, prompt) on each step
 * - Skips preconditions and clarificationPrompts (parent workflow handles these)
 */
export function createRoutineExpander(
  routineId: string,
  definition: WorkflowDefinition,
): Result<TemplateExpander, TemplateExpandError> {
  // Validate: no recursive templateCall in routine steps
  for (const step of definition.steps) {
    if ('templateCall' in step && step.templateCall) {
      return err({
        code: 'TEMPLATE_EXPAND_FAILED',
        templateId: routineIdToTemplateId(routineId),
        message: `Routine '${routineId}' step '${step.id}' contains a templateCall. Recursive routine injection is not allowed.`,
      });
    }
  }

  const templateId = routineIdToTemplateId(routineId);

  const expander: TemplateExpander = (
    callerId: string,
    args: Readonly<Record<string, unknown>>,
  ): Result<readonly WorkflowStepDefinition[], TemplateExpandError> => {
    const expandedSteps: WorkflowStepDefinition[] = [];

    for (const step of definition.steps) {
      // Validate required fields
      if (!step.id || !step.title) {
        return err({
          code: 'TEMPLATE_EXPAND_FAILED',
          templateId,
          message: `Routine '${routineId}' step '${step.id ?? '(missing id)'}' is missing required field '${!step.id ? 'id' : 'title'}'.`,
        });
      }
      if (!step.prompt) {
        return err({
          code: 'TEMPLATE_EXPAND_FAILED',
          templateId,
          message: `Routine '${routineId}' step '${step.id}' is missing required field 'prompt'.`,
        });
      }

      // Substitute args in prompt
      const promptResult = substituteArgs(step.prompt, args, templateId, routineId, step.id);
      if (promptResult.isErr()) return err(promptResult.error);

      // Also substitute args in title (some routines may reference args there)
      const titleResult = substituteArgs(step.title, args, templateId, routineId, step.id);
      if (titleResult.isErr()) return err(titleResult.error);

      // Build expanded step: spread all original fields, then override
      // id/title/prompt with processed values and inject metaGuidance.
      // Spreading preserves fields like agentRole, requireConfirmation,
      // notesOptional, outputContract, runCondition, etc. without
      // needing to explicitly list each one.
      const expandedStep: WorkflowStepDefinition = {
        ...step,
        id: `${callerId}.${step.id}`,
        title: titleResult.value,
        prompt: promptResult.value,
        // Inject routine metaGuidance as step-level guidance (Option B from design doc)
        ...(definition.metaGuidance && definition.metaGuidance.length > 0
          ? {
              guidance: [
                ...(step.guidance ?? []),
                ...definition.metaGuidance,
              ],
            }
          : {}),
      };

      expandedSteps.push(expandedStep);
    }

    return ok(expandedSteps);
  };

  return ok(expander);
}

// ---------------------------------------------------------------------------
// Canonical template definitions (closed set, WorkRail-owned)
// ---------------------------------------------------------------------------

// Empty for now — built-in template definitions can be added here.
const TEMPLATE_DEFINITIONS = new Map<string, TemplateExpander>();

// ---------------------------------------------------------------------------
// Registry constructor
// ---------------------------------------------------------------------------

/**
 * Create the template registry, optionally populated with routine-derived expanders.
 *
 * @param routineExpanders - Map of template IDs to expanders derived from routine definitions.
 *   Created externally via createRoutineExpander() to keep this function pure.
 */
export function createTemplateRegistry(
  routineExpanders?: ReadonlyMap<string, TemplateExpander>,
): TemplateRegistry {
  // Merge built-in and routine-derived expanders
  const allExpanders = new Map<string, TemplateExpander>(TEMPLATE_DEFINITIONS);
  if (routineExpanders) {
    for (const [id, expander] of routineExpanders) {
      allExpanders.set(id, expander);
    }
  }

  const knownIds = [...allExpanders.keys()];

  return {
    resolve(templateId: string): Result<TemplateExpander, TemplateResolveError> {
      const expander = allExpanders.get(templateId);
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
      return allExpanders.has(templateId);
    },

    knownIds(): readonly string[] {
      return knownIds;
    },
  };
}
