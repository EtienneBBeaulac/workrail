import type { Workflow } from '../../types/workflow.js';
import type { CompiledWorkflowSnapshotV1 } from '../durable-core/schemas/compiled-workflow/index.js';
import { resolveDefinitionSteps } from '../../application/services/workflow-compiler.js';
import { isLoopStepDefinition } from '../../types/workflow-definition.js';
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
  let prompt: string;
  if (isLoopStepDefinition(firstStep)) {
    prompt = `Loop step '${firstStep.id}' cannot be previewed in v2 Slice 1 (loop execution/compilation not implemented yet).`;
  } else if (typeof firstStep.prompt === 'string') {
    prompt = firstStep.prompt;
  } else {
    // promptBlocks-only step: resolve to get prompt string
    const resolved = resolveDefinitionSteps(
      [firstStep],
      workflow.definition.features ?? [],
      workflow.definition.extensionPoints ?? [],
      workflow.definition.id,
    );
    const resolvedPrompt = resolved.isOk() ? resolved.value.steps[0]?.prompt : undefined;
    prompt = typeof resolvedPrompt === 'string'
      ? resolvedPrompt
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
      title: firstStep.title,
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
  // Resolve authoring-layer constructs (templates, features, refs, promptBlocks, bindings)
  // before pinning. If resolution fails, pin the raw definition as fallback
  // (existing workflows with only `prompt` strings are unaffected).
  const resolved = resolveDefinitionSteps(
    workflow.definition.steps,
    workflow.definition.features ?? [],
    workflow.definition.extensionPoints ?? [],
    workflow.definition.id,
  );

  const resolvedDefinition = resolved.isOk()
    ? { ...workflow.definition, steps: resolved.value.steps }
    : workflow.definition;

  const resolvedBindings = resolved.isOk() && resolved.value.resolvedBindings.size > 0
    ? Object.fromEntries(resolved.value.resolvedBindings)
    : undefined;

  const pinnedOverrides = resolved.isOk() && resolved.value.resolvedOverrides.size > 0
    ? Object.fromEntries(resolved.value.resolvedOverrides)
    : undefined;

  return {
    schemaVersion: 1,
    sourceKind: 'v1_pinned',
    workflowId: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    definition: resolvedDefinition as unknown,
    ...(resolvedBindings !== undefined ? { resolvedBindings } : {}),
    ...(pinnedOverrides !== undefined ? { pinnedOverrides } : {}),
  };
}

/**
 * Result-returning wrapper for compileV1WorkflowToPinnedSnapshot.
 *
 * Used by the validation pipeline to handle normalization errors explicitly.
 * Returns Result<T, DomainError> where T matches the pipeline's ExecutableCompiledWorkflowSnapshot type.
 *
 * This propagates resolution errors from promptBlocks/templates/refs/bindings instead of
 * silently falling back to the raw definition.
 */
export function normalizeV1WorkflowToPinnedSnapshot(
  workflow: Workflow
): Result<Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>, DomainError> {
  // Attempt to resolve authoring-layer constructs (templates, features, refs, promptBlocks, bindings)
  const resolved = resolveDefinitionSteps(
    workflow.definition.steps,
    workflow.definition.features ?? [],
    workflow.definition.extensionPoints ?? [],
    workflow.definition.id,
  );

  // If resolution fails, return the error to the pipeline
  if (resolved.isErr()) {
    return err(resolved.error);
  }

  const resolvedDefinition = { ...workflow.definition, steps: resolved.value.steps };

  const resolvedBindings = resolved.value.resolvedBindings.size > 0
    ? Object.fromEntries(resolved.value.resolvedBindings)
    : undefined;

  const pinnedOverrides = resolved.value.resolvedOverrides.size > 0
    ? Object.fromEntries(resolved.value.resolvedOverrides)
    : undefined;

  return ok({
    schemaVersion: 1,
    sourceKind: 'v1_pinned' as const,
    workflowId: workflow.definition.id,
    name: workflow.definition.name,
    description: workflow.definition.description,
    version: workflow.definition.version,
    definition: resolvedDefinition as unknown,
    ...(resolvedBindings !== undefined ? { resolvedBindings } : {}),
    ...(pinnedOverrides !== undefined ? { pinnedOverrides } : {}),
  });
}
