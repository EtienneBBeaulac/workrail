/**
 * Sentinel Scan — Defense-in-Depth Token Check
 *
 * Scans all compiled step prompts for surviving {{wr.*}} tokens after the
 * full compiler pipeline has run. If any token is found, it signals a bug
 * in an upstream pass (a token that should have been resolved was missed).
 *
 * This runs as the final step in resolveDefinitionSteps, after
 * resolvePromptBlocksPass has rendered all promptBlocks into prompt strings.
 *
 * Why only `step.prompt` is checked (not `step.promptBlocks`):
 * resolvePromptBlocksPass (Phase 1c) converts every promptBlocks object into a
 * single `step.prompt` string and removes the promptBlocks field. By the time
 * this sentinel runs, any token that was in promptBlocks is already in
 * step.prompt — so scanning only `step.prompt` provides full coverage.
 *
 * Why this pass exists:
 * - Any surface (raw prompt, promptBlocks string value) that slips through
 *   the binding pass will produce a literal {{wr.bindings.x}} string in the
 *   compiled prompt with no other error.
 * - This sentinel catches that case regardless of which pass let it through.
 *
 * Loop body traversal is required — the same Array.isArray(step.body) pattern
 * used by all other compiler passes. Without it, loop body tokens are missed.
 *
 * False positive risk: extremely low. The pattern {{wr. requires two
 * consecutive braces immediately followed by 'wr.' — JSON single-brace
 * objects and generic {{variable}} Mustache tokens do not match.
 *
 * Pure function — no I/O, no mutation.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../types/workflow-definition.js';
import { isLoopStepDefinition } from '../../../types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type SentinelError = {
  readonly code: 'UNRESOLVED_TOKEN';
  readonly stepId: string;
  readonly token: string;
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Token pattern
// ---------------------------------------------------------------------------

/** Matches the opening of any {{wr.* token. Specific enough to avoid false positives. */
const UNRESOLVED_RE = /\{\{wr\./;

// ---------------------------------------------------------------------------
// Compiler pass
// ---------------------------------------------------------------------------

/**
 * Final pipeline pass: scan all compiled prompt strings for surviving {{wr.*}} tokens.
 *
 * If this pass fires, there is a bug in an upstream pass — a token was not
 * resolved and not caught by the pass that should have handled it.
 *
 * Pure function — no I/O, no mutation. Returns ok(undefined) on a clean scan.
 */
export function sentinelScanPass(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
): Result<void, SentinelError> {
  for (const step of steps) {
    // Check the step's own prompt (loop containers may have no prompt — guard with &&)
    if (step.prompt && UNRESOLVED_RE.test(step.prompt)) {
      const match = step.prompt.match(/\{\{wr\.[^}]*\}\}/);
      const token = match ? match[0] : '{{wr.*}}';
      return err({
        code: 'UNRESOLVED_TOKEN',
        stepId: step.id,
        token,
        message: `Step '${step.id}': compiled prompt contains unresolved token '${token}'. ` +
          `This indicates a bug in an upstream compiler pass.`,
      });
    }

    // Traverse inline loop body steps — same pattern as all other passes
    if (isLoopStepDefinition(step) && Array.isArray(step.body)) {
      for (const bodyStep of step.body) {
        if (bodyStep.prompt && UNRESOLVED_RE.test(bodyStep.prompt)) {
          const match = bodyStep.prompt.match(/\{\{wr\.[^}]*\}\}/);
          const token = match ? match[0] : '{{wr.*}}';
          return err({
            code: 'UNRESOLVED_TOKEN',
            stepId: bodyStep.id,
            token,
            message: `Loop body step '${bodyStep.id}': compiled prompt contains unresolved token '${token}'. ` +
              `This indicates a bug in an upstream compiler pass.`,
          });
        }
      }
    }
  }

  return ok(undefined);
}
