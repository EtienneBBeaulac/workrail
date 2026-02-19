/**
 * Ref Resolution Compiler Pass
 *
 * Walks all promptBlocks in all steps, replacing { kind: 'ref' } parts
 * with { kind: 'text' } parts using the RefRegistry. Runs before the
 * promptBlocks rendering pass so refs are fully resolved before rendering.
 *
 * Pure function — no I/O, no mutation.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { RefRegistry, RefResolveError } from './ref-registry.js';
import type { PromptPart, PromptValue, PromptBlocks } from './prompt-blocks.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../types/workflow-definition.js';
import { isLoopStepDefinition } from '../../../types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ResolveRefsPassError = {
  readonly code: 'REF_RESOLVE_ERROR';
  readonly stepId: string;
  readonly cause: RefResolveError;
};

// ---------------------------------------------------------------------------
// PromptValue ref resolution
// ---------------------------------------------------------------------------

/** Resolve all ref parts in a PromptValue to text parts. */
function resolvePromptValueRefs(
  value: PromptValue,
  registry: RefRegistry,
): Result<PromptValue, RefResolveError> {
  if (typeof value === 'string') return ok(value);

  const resolved: PromptPart[] = [];
  for (const part of value) {
    switch (part.kind) {
      case 'text':
        resolved.push(part);
        break;
      case 'ref': {
        const res = registry.resolve(part.refId);
        if (res.isErr()) return err(res.error);
        resolved.push({ kind: 'text', text: res.value });
        break;
      }
    }
  }
  return ok(resolved);
}

/** Resolve all ref parts in an array of PromptValues. */
function resolvePromptValuesRefs(
  values: readonly PromptValue[],
  registry: RefRegistry,
): Result<readonly PromptValue[], RefResolveError> {
  const resolved: PromptValue[] = [];
  for (const value of values) {
    const res = resolvePromptValueRefs(value, registry);
    if (res.isErr()) return err(res.error);
    resolved.push(res.value);
  }
  return ok(resolved);
}

// ---------------------------------------------------------------------------
// PromptBlocks ref resolution
// ---------------------------------------------------------------------------

/** Resolve all refs in a PromptBlocks object. */
function resolveBlockRefs(
  blocks: PromptBlocks,
  registry: RefRegistry,
): Result<PromptBlocks, RefResolveError> {
  let result: PromptBlocks = { ...blocks };

  if (blocks.goal !== undefined) {
    const res = resolvePromptValueRefs(blocks.goal, registry);
    if (res.isErr()) return err(res.error);
    result = { ...result, goal: res.value };
  }

  if (blocks.constraints !== undefined) {
    const res = resolvePromptValuesRefs(blocks.constraints, registry);
    if (res.isErr()) return err(res.error);
    result = { ...result, constraints: res.value };
  }

  if (blocks.procedure !== undefined) {
    const res = resolvePromptValuesRefs(blocks.procedure, registry);
    if (res.isErr()) return err(res.error);
    result = { ...result, procedure: res.value };
  }

  if (blocks.verify !== undefined) {
    const res = resolvePromptValuesRefs(blocks.verify, registry);
    if (res.isErr()) return err(res.error);
    result = { ...result, verify: res.value };
  }

  // outputRequired is Record<string, string> — no refs possible
  return ok(result);
}

// ---------------------------------------------------------------------------
// Step-level ref resolution
// ---------------------------------------------------------------------------

function resolveStepRefs(
  step: WorkflowStepDefinition,
  registry: RefRegistry,
): Result<WorkflowStepDefinition, ResolveRefsPassError> {
  if (!step.promptBlocks) return ok(step);

  const res = resolveBlockRefs(step.promptBlocks, registry);
  if (res.isErr()) {
    return err({
      code: 'REF_RESOLVE_ERROR',
      stepId: step.id,
      cause: res.error,
    });
  }

  return ok({ ...step, promptBlocks: res.value });
}

// ---------------------------------------------------------------------------
// Compiler pass
// ---------------------------------------------------------------------------

/**
 * Compiler pass: resolve all wr.refs.* in promptBlocks.
 *
 * Must run BEFORE resolvePromptBlocksPass (which rejects unresolved refs).
 * Pure function — no I/O, no mutation.
 */
export function resolveRefsPass(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
  registry: RefRegistry,
): Result<readonly (WorkflowStepDefinition | LoopStepDefinition)[], ResolveRefsPassError> {
  const resolved: (WorkflowStepDefinition | LoopStepDefinition)[] = [];

  for (const step of steps) {
    if (isLoopStepDefinition(step)) {
      // Resolve the loop step itself
      const loopRes = resolveStepRefs(step, registry);
      if (loopRes.isErr()) return err(loopRes.error);

      // Resolve inline body steps
      if (Array.isArray(step.body)) {
        const bodyResolved: WorkflowStepDefinition[] = [];
        for (const bodyStep of step.body) {
          const bodyRes = resolveStepRefs(bodyStep, registry);
          if (bodyRes.isErr()) return err(bodyRes.error);
          bodyResolved.push(bodyRes.value);
        }
        resolved.push({
          ...step,
          ...(loopRes.value.promptBlocks ? { promptBlocks: loopRes.value.promptBlocks } : {}),
          body: bodyResolved,
        } as LoopStepDefinition);
      } else {
        resolved.push({
          ...step,
          ...(loopRes.value.promptBlocks ? { promptBlocks: loopRes.value.promptBlocks } : {}),
        } as LoopStepDefinition);
      }
    } else {
      const res = resolveStepRefs(step, registry);
      if (res.isErr()) return err(res.error);
      resolved.push(res.value);
    }
  }

  return ok(resolved);
}
