import type { Workflow } from '../../types/workflow.js';
import type { CompiledWorkflowSnapshotV1 } from '../durable-core/schemas/compiled-workflow/index.js';

/**
 * Slice 1 only: compile a v1 Workflow into a minimal v2 compiled snapshot shape.
 *
 * Guardrail: this is intentionally named and scoped as a shim so it does not
 * become the long-term v2 compiler. It should be deleted once v2 authoring
 * and compilation are implemented.
 */
export function compileV1WorkflowToV2CompiledSnapshotV1(workflow: Workflow): CompiledWorkflowSnapshotV1 {
  const firstStep = workflow.definition.steps[0];

  // v1 workflows always have at least one step (validated on load),
  // but keep the shim fail-fast and deterministic.
  if (!firstStep) {
    return {
      schemaVersion: 1,
      sourceKind: 'v1_shim',
      workflowId: workflow.definition.id,
      name: workflow.definition.name,
      description: workflow.definition.description,
      version: workflow.definition.version,
      preview: {
        stepId: '(missing)',
        title: 'Invalid workflow: missing first step',
        prompt: 'This workflow has no steps. It is invalid and cannot be previewed.',
      },
    };
  }

  // Best-effort preview:
  // - normal step: use prompt directly
  // - loop step: provide a deterministic placeholder (Slice 1 does not implement loops)
  const isLoop = (firstStep as any).type === 'loop';
  const prompt =
    !isLoop && typeof (firstStep as any).prompt === 'string'
      ? ((firstStep as any).prompt as string)
      : `Loop step '${firstStep.id}' cannot be previewed in v2 Slice 1 (loop execution/compilation not implemented yet).`;

  return {
    schemaVersion: 1,
    sourceKind: 'v1_shim',
    workflowId: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    preview: {
      stepId: firstStep.id,
      title: (firstStep as any).title ?? firstStep.id,
      prompt,
    },
  };
}
