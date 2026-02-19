/**
 * Template Registry — Closed-Set Step Expansion
 *
 * Maps `wr.templates.*` IDs to template expansion functions.
 * Templates expand a single step into one or more real steps at compile time.
 *
 * Why closed-set: templates produce steps that become part of the compiled
 * workflow hash. User-defined templates would break determinism.
 *
 * The registry starts empty — template definitions are added in future PRs.
 * This PR ships the expansion machinery and compiler wiring.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { WorkflowStepDefinition } from '../../../types/workflow-definition.js';

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
// Canonical template definitions (closed set, WorkRail-owned)
// ---------------------------------------------------------------------------

// Empty for now — template definitions will be added in future PRs.
// The registry machinery and compiler pass are the deliverable for PR4.
const TEMPLATE_DEFINITIONS = new Map<string, TemplateExpander>();

// ---------------------------------------------------------------------------
// Registry constructor
// ---------------------------------------------------------------------------

/** Create the canonical template registry (frozen, closed-set). */
export function createTemplateRegistry(): TemplateRegistry {
  const knownIds = [...TEMPLATE_DEFINITIONS.keys()];

  return {
    resolve(templateId: string): Result<TemplateExpander, TemplateResolveError> {
      const expander = TEMPLATE_DEFINITIONS.get(templateId);
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
      return TEMPLATE_DEFINITIONS.has(templateId);
    },

    knownIds(): readonly string[] {
      return knownIds;
    },
  };
}
