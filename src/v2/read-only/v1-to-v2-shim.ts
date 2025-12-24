import type { Workflow } from '../../types/workflow.js';
import type { CompiledWorkflowSnapshotV1 } from '../durable-core/schemas/compiled-workflow/index.js';

/**
 * Slice 1: compile a v1 Workflow into a read-only preview snapshot.
 *
 * Guardrail: this is intentionally named and scoped as a shim. Preview snapshots
 * are not executable; they exist only for `inspect_workflow` metadata/hashing.
 */
export function compileV1WorkflowToV2PreviewSnapshot(workflow: Workflow): Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_preview' }> {
  const firstStep = workflow.definition.steps[0];

  // v1 workflows always have at least one step (validated on load),
  // but keep the shim fail-fast and deterministic.
  if (!firstStep) {
    return {
      schemaVersion: 1,
      sourceKind: 'v1_preview',
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
    sourceKind: 'v1_preview',
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

/**
 * Slice 3: pin the full v1 workflow definition as durable truth for deterministic v2 execution.
 *
 * This is still a v1-backed execution strategy (not v2 authoring). It exists so `workflowHash`
 * reflects the full workflow definition and remains stable even if on-disk sources change.
 */
export function compileV1WorkflowToPinnedSnapshot(workflow: Workflow): Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }> {
  return {
    schemaVersion: 1,
    sourceKind: 'v1_pinned',
    workflowId: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    definition: workflow.definition as unknown,
  };
}
