import type { Workflow } from '../../types/workflow.js';
import type { CompiledWorkflowSnapshotV1 } from '../durable-core/schemas/compiled-workflow/index.js';
import { resolveDefinitionSteps } from '../../application/services/workflow-compiler.js';
import { type Result, ok, err } from 'neverthrow';
import type { DomainError } from '../../domain/execution/error.js';

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
  // - normal step with prompt: use prompt directly
  // - normal step with promptBlocks: resolve via compiler pipeline
  // - loop step: provide a deterministic placeholder (Slice 1 does not implement loops)
  const isLoop = (firstStep as any).type === 'loop';
  let prompt: string;
  if (isLoop) {
    prompt = `Loop step '${firstStep.id}' cannot be previewed in v2 Slice 1 (loop execution/compilation not implemented yet).`;
  } else if (typeof (firstStep as any).prompt === 'string') {
    prompt = (firstStep as any).prompt as string;
  } else {
    // promptBlocks-only step: resolve to get prompt string
    const resolved = resolveDefinitionSteps(
      [firstStep as any],
      workflow.definition.features ?? [],
    );
    prompt = resolved.isOk() && (resolved.value[0] as any)?.prompt
      ? (resolved.value[0] as any).prompt as string
      : `Step '${firstStep.id}' has no prompt (promptBlocks resolution failed).`;
  }

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
 * Boundary invariant: the pinned definition has all promptBlocks resolved
 * into prompt strings. This ensures `renderPendingPrompt` — which reads
 * `step.prompt` directly — always finds a compiled prompt, never an absent
 * one from a promptBlocks-only step.
 *
 * Why here: this is the boundary between authored and durable. Validate
 * at boundaries, trust inside. Everything downstream trusts that prompt
 * exists on every step.
 */
export function compileV1WorkflowToPinnedSnapshot(workflow: Workflow): Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }> {
  // Resolve authoring-layer constructs (templates, features, refs, promptBlocks)
  // before pinning. If resolution fails, pin the raw definition as fallback
  // (existing workflows with only `prompt` strings are unaffected).
  const resolved = resolveDefinitionSteps(
    workflow.definition.steps,
    workflow.definition.features ?? [],
  );

  const resolvedDefinition = resolved.isOk()
    ? { ...workflow.definition, steps: resolved.value }
    : workflow.definition;

  return {
    schemaVersion: 1,
    sourceKind: 'v1_pinned',
    workflowId: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    definition: resolvedDefinition as unknown,
  };
}

/**
 * Result-returning wrapper for compileV1WorkflowToPinnedSnapshot.
 *
 * Used by the validation pipeline to handle normalization errors explicitly.
 * Returns Result<T, DomainError> where T matches the pipeline's ExecutableCompiledWorkflowSnapshot type.
 *
 * This propagates resolution errors from promptBlocks/templates/refs instead of
 * silently falling back to the raw definition.
 */
export function normalizeV1WorkflowToPinnedSnapshot(
  workflow: Workflow
): Result<Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>, DomainError> {
  // Attempt to resolve authoring-layer constructs (templates, features, refs, promptBlocks)
  const resolved = resolveDefinitionSteps(
    workflow.definition.steps,
    workflow.definition.features ?? [],
  );

  // If resolution fails, return the error to the pipeline
  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const resolvedDefinition = { ...workflow.definition, steps: resolved.value };

  return ok({
    schemaVersion: 1,
    sourceKind: 'v1_pinned' as const,
    workflowId: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    definition: resolvedDefinition as unknown,
  });
}
