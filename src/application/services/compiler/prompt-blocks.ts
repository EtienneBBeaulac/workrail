/**
 * PromptBlocks — Structured Prompt Authoring
 *
 * Provides typed prompt blocks as an alternative to raw prompt strings.
 * Blocks are rendered into a deterministic text prompt at compile time.
 *
 * Why compile-time: the rendered prompt is included in the workflow hash,
 * ensuring deterministic execution. The runtime prompt renderer reads
 * step.prompt (already a string) and is unchanged.
 *
 * Lock: promptBlocks rendering order is deterministic (goal → constraints →
 * procedure → outputRequired → verify). Same blocks always produce same text.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';

// ---------------------------------------------------------------------------
// PromptPart — discriminated union for inline content
// ---------------------------------------------------------------------------

/**
 * A single part of a prompt value.
 *
 * Why discriminated union: a prompt part is either literal text or a
 * reference to a canonical WorkRail snippet. The union makes the two
 * cases exhaustive and prevents stringly-typed ref IDs from being
 * confused with literal text.
 *
 * Refs are resolved in a separate compiler pass (PR2). This module
 * treats 'ref' parts as opaque — they must be resolved before rendering.
 */
export type PromptPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'ref'; readonly refId: string };

/** A prompt value is either a plain string or an array of parts. */
export type PromptValue = string | readonly PromptPart[];

// ---------------------------------------------------------------------------
// PromptBlocks — structured prompt sections
// ---------------------------------------------------------------------------

/**
 * Structured prompt blocks for a workflow step.
 *
 * Canonical block set (locked): goal, constraints, procedure,
 * outputRequired, verify. Rendered in this deterministic order.
 *
 * All fields are optional — authors include only the sections they need.
 * At least one block must be present (validated at compile time).
 */
export interface PromptBlocks {
  readonly goal?: PromptValue;
  readonly constraints?: readonly PromptValue[];
  readonly procedure?: readonly PromptValue[];
  readonly outputRequired?: Readonly<Record<string, string>>;
  readonly verify?: readonly PromptValue[];
}

// ---------------------------------------------------------------------------
// Rendering — pure, deterministic
// ---------------------------------------------------------------------------

export type PromptBlocksRenderError =
  | { readonly code: 'EMPTY_BLOCKS'; readonly message: string }
  | { readonly code: 'UNRESOLVED_REF'; readonly refId: string; readonly message: string };

/**
 * Resolve a PromptValue to a plain string.
 *
 * Returns an error if any ref parts remain unresolved. Refs must be
 * resolved by the ref resolution pass before rendering.
 */
function resolvePromptValue(value: PromptValue): Result<string, PromptBlocksRenderError> {
  if (typeof value === 'string') return ok(value);

  const parts: string[] = [];
  for (const part of value) {
    switch (part.kind) {
      case 'text':
        parts.push(part.text);
        break;
      case 'ref':
        return err({
          code: 'UNRESOLVED_REF',
          refId: part.refId,
          message: `Unresolved ref '${part.refId}' in prompt blocks. Refs must be resolved before rendering.`,
        });
    }
  }
  return ok(parts.join(''));
}

/**
 * Resolve an array of PromptValues to an array of strings.
 */
function resolvePromptValues(values: readonly PromptValue[]): Result<readonly string[], PromptBlocksRenderError> {
  const resolved: string[] = [];
  for (const value of values) {
    const res = resolvePromptValue(value);
    if (res.isErr()) return err(res.error);
    resolved.push(res.value);
  }
  return ok(resolved);
}

/**
 * Render PromptBlocks into a deterministic prompt string.
 *
 * Section order is locked: goal → constraints → procedure →
 * outputRequired → verify. Same blocks always produce same text.
 *
 * All ref parts must be resolved before calling this function.
 * Use the ref resolution pass first, then render.
 */
export function renderPromptBlocks(blocks: PromptBlocks): Result<string, PromptBlocksRenderError> {
  const sections: string[] = [];

  // Goal
  if (blocks.goal !== undefined) {
    const res = resolvePromptValue(blocks.goal);
    if (res.isErr()) return err(res.error);
    sections.push(`## Goal\n${res.value}`);
  }

  // Constraints
  if (blocks.constraints !== undefined && blocks.constraints.length > 0) {
    const res = resolvePromptValues(blocks.constraints);
    if (res.isErr()) return err(res.error);
    sections.push(`## Constraints\n${res.value.map(c => `- ${c}`).join('\n')}`);
  }

  // Procedure
  if (blocks.procedure !== undefined && blocks.procedure.length > 0) {
    const res = resolvePromptValues(blocks.procedure);
    if (res.isErr()) return err(res.error);
    sections.push(`## Procedure\n${res.value.map((p, i) => `${i + 1}. ${p}`).join('\n')}`);
  }

  // Output Required
  if (blocks.outputRequired !== undefined && Object.keys(blocks.outputRequired).length > 0) {
    const entries = Object.entries(blocks.outputRequired)
      .map(([key, value]) => `- **${key}**: ${value}`)
      .join('\n');
    sections.push(`## Output Required\n${entries}`);
  }

  // Verify
  if (blocks.verify !== undefined && blocks.verify.length > 0) {
    const res = resolvePromptValues(blocks.verify);
    if (res.isErr()) return err(res.error);
    sections.push(`## Verify\n${res.value.map(v => `- ${v}`).join('\n')}`);
  }

  if (sections.length === 0) {
    return err({
      code: 'EMPTY_BLOCKS',
      message: 'promptBlocks must contain at least one non-empty section.',
    });
  }

  return ok(sections.join('\n\n'));
}

// ---------------------------------------------------------------------------
// Compiler pass — resolve promptBlocks into prompt strings
// ---------------------------------------------------------------------------

import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../types/workflow-definition.js';
import { isLoopStepDefinition } from '../../../types/workflow-definition.js';

export type PromptBlocksPassError =
  | { readonly code: 'PROMPT_BLOCKS_ERROR'; readonly stepId: string; readonly cause: PromptBlocksRenderError }
  | { readonly code: 'PROMPT_AND_BLOCKS_BOTH_SET'; readonly stepId: string; readonly message: string };

/**
 * Resolve a single step's promptBlocks into a prompt string.
 *
 * Rules:
 * - If step has prompt (non-empty): use as-is (backward compat)
 * - If step has promptBlocks: render to prompt string
 * - If step has both: compile-time error (handled by validation, not here)
 * - If step has neither: leave prompt undefined (validation catches later)
 */
function resolveStepPromptBlocks(
  step: WorkflowStepDefinition,
): Result<WorkflowStepDefinition, PromptBlocksPassError> {
  // Mutual exclusion: prompt XOR promptBlocks
  if (step.prompt && step.promptBlocks) {
    return err({
      code: 'PROMPT_AND_BLOCKS_BOTH_SET',
      stepId: step.id,
      message: `Step '${step.id}' declares both prompt and promptBlocks. Use exactly one.`,
    });
  }

  if (!step.promptBlocks) return ok(step);

  const renderResult = renderPromptBlocks(step.promptBlocks);
  if (renderResult.isErr()) {
    return err({
      code: 'PROMPT_BLOCKS_ERROR',
      stepId: step.id,
      cause: renderResult.error,
    });
  }

  // Produce a new step with prompt filled from rendered blocks.
  // promptBlocks is preserved for introspection (Studio, export).
  return ok({
    ...step,
    prompt: renderResult.value,
  });
}

/**
 * Compiler pass: resolve all promptBlocks into prompt strings.
 *
 * Processes top-level steps and inline loop body steps.
 * Pure function — no I/O, no mutation.
 */
export function resolvePromptBlocksPass(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
): Result<readonly (WorkflowStepDefinition | LoopStepDefinition)[], PromptBlocksPassError> {
  const resolved: (WorkflowStepDefinition | LoopStepDefinition)[] = [];

  for (const step of steps) {
    if (isLoopStepDefinition(step)) {
      // Resolve the loop step itself
      const loopRes = resolveStepPromptBlocks(step);
      if (loopRes.isErr()) return err(loopRes.error);

      // Resolve inline body steps
      if (Array.isArray(step.body)) {
        const bodyResolved: WorkflowStepDefinition[] = [];
        for (const bodyStep of step.body) {
          const bodyRes = resolveStepPromptBlocks(bodyStep);
          if (bodyRes.isErr()) return err(bodyRes.error);
          bodyResolved.push(bodyRes.value);
        }
        // Preserve the full LoopStepDefinition shape (type, loop, body)
        const resolvedLoop: LoopStepDefinition = {
          ...step,
          ...(loopRes.value.prompt !== undefined ? { prompt: loopRes.value.prompt } : {}),
          body: bodyResolved,
        };
        resolved.push(resolvedLoop);
      } else {
        resolved.push({ ...step, ...(loopRes.value.prompt !== undefined ? { prompt: loopRes.value.prompt } : {}) } as LoopStepDefinition);
      }
    } else {
      const res = resolveStepPromptBlocks(step);
      if (res.isErr()) return err(res.error);
      resolved.push(res.value);
    }
  }

  return ok(resolved);
}
