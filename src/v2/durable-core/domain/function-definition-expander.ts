import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { Workflow, FunctionDefinition, LoopStepDefinition, WorkflowStepDefinition } from '../../../types/workflow.js';
import { isLoopStepDefinition } from '../../../types/workflow.js';
import type { LoopPathFrameV1 } from '../schemas/execution-snapshot/index.js';

export type FunctionExpansionError = {
  readonly code: 'FUNCTION_EXPANSION_FAILED';
  readonly message: string;
};

/**
 * Find a loop step by loopId (recursive search, pure).
 */
function findLoopById(workflow: Workflow, loopId: string): LoopStepDefinition | null {
  function searchSteps(steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[]): LoopStepDefinition | null {
    for (const step of steps) {
      if (!isLoopStepDefinition(step)) continue;

      if (step.id === loopId) return step;

      // Recursively search loop body
      if (Array.isArray(step.body)) {
        const found = searchSteps(step.body);
        if (found) return found;
      }
    }
    return null;
  }

  return searchSteps(workflow.definition.steps);
}

/**
 * Get workflow-scoped function definitions.
 */
function getWorkflowScopeDefs(workflow: Workflow): readonly FunctionDefinition[] {
  return workflow.definition.functionDefinitions?.filter(
    f => !f.scope || f.scope === 'workflow'
  ) ?? [];
}

/**
 * Get loop-scoped function definitions.
 */
function getLoopScopeDefs(args: {
  readonly workflow: Workflow;
  readonly loopPath: readonly LoopPathFrameV1[];
}): readonly FunctionDefinition[] {
  return args.loopPath.flatMap(frame => {
    const loopStep = findLoopById(args.workflow, String(frame.loopId));
    return loopStep?.functionDefinitions?.filter(
      f => !f.scope || f.scope === 'loop'
    ) ?? [];
  });
}

/**
 * Get step-scoped function definitions.
 */
function getStepScopeDefs(args: {
  readonly workflow: Workflow;
  readonly stepId: string;
}): readonly FunctionDefinition[] {
  const step = args.workflow.definition.steps.find(s => s.id === args.stepId);
  return step?.functionDefinitions?.filter(
    f => !f.scope || f.scope === 'step'
  ) ?? [];
}

/**
 * Expand function definitions for a step, respecting scope priority.
 * 
 * Lock (§1040-1051):
 * - Scope priority: step → loop → workflow (closest wins)
 * - Filter to functionReferences[] only
 * - Deterministic ordering: scope priority, then name lex
 */
export function expandFunctionDefinitions(args: {
  readonly workflow: Workflow;
  readonly stepId: string;
  readonly loopPath: readonly LoopPathFrameV1[];
  readonly functionReferences: readonly string[];
}): Result<readonly FunctionDefinition[], FunctionExpansionError> {
  // Collect all visible function definitions (functional concat)
  const allDefs = [
    ...getWorkflowScopeDefs(args.workflow),
    ...getLoopScopeDefs({ workflow: args.workflow, loopPath: args.loopPath }),
    ...getStepScopeDefs({ workflow: args.workflow, stepId: args.stepId }),
  ];

  // Deduplication via Map: last-write-wins so step (closest) overrides workflow (furthest)
  const deduped = new Map<string, FunctionDefinition>();
  for (const def of allDefs) {
    deduped.set(def.name, def);
  }

  // Filter to referenced functions (or all if no filter)
  const filtered = args.functionReferences.length > 0
    ? Array.from(deduped.values()).filter(f => args.functionReferences.includes(f.name))
    : Array.from(deduped.values());

  // Deterministic ordering: scope priority, then name lex
  const scopePriority: Record<string, number> = { step: 0, loop: 1, workflow: 2 };
  const sorted = filtered.sort((a, b) => {
    const aScope = a.scope ?? 'workflow';
    const bScope = b.scope ?? 'workflow';
    const aPri = scopePriority[aScope] ?? 2;
    const bPri = scopePriority[bScope] ?? 2;
    if (aPri !== bPri) return aPri - bPri;
    return a.name.localeCompare(b.name, 'en-US');
  });

  return ok(sorted);
}

/**
 * Format function definition for prompt injection.
 */
export function formatFunctionDef(def: FunctionDefinition): string {
  return `function ${def.name}(...)\n  ${def.definition}`;
}
