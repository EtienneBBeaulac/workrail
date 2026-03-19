/**
 * Binding Resolution Compiler Pass
 *
 * Replaces {{wr.bindings.slotId}} tokens in step prompt strings and promptBlocks
 * string values with the resolved routine/workflow ID. Runs at Phase 0.5:
 * after resolveTemplatesPass (template-expanded steps are visible) and before
 * resolveFeaturesPass (independent surface, no ordering dependency).
 *
 * Resolution order per slot:
 *   1. Project override from .workrail/bindings.json (provided as projectBindings)
 *   2. Fallback to extensionPoint default declared in the workflow definition
 *   3. Neither found → fail fast with UNKNOWN_BINDING_SLOT
 *
 * Why compile-time: resolved values become part of the compiled prompt string,
 * which is included in the workflow hash for session reproducibility.
 * Unknown slot IDs fail fast — no silent passthrough, no runtime surprises.
 *
 * Coverage: raw prompt strings AND promptBlocks plain string PromptValue fields.
 * Loop body traversal is explicit (same Array.isArray(step.body) pattern as all
 * other compiler passes).
 *
 * Pure function — no I/O, no mutation.
 */

import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { ExtensionPoint } from '../../../types/workflow-definition.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../types/workflow-definition.js';
import { isLoopStepDefinition } from '../../../types/workflow-definition.js';
import type { PromptBlocks, PromptValue } from './prompt-blocks.js';
import type { ProjectBindings } from './binding-registry.js';

// ---------------------------------------------------------------------------
// Token pattern
// ---------------------------------------------------------------------------

/**
 * Matches {{wr.bindings.slotId}} — slotId is captured in group 1.
 *
 * Accepts any non-empty, non-whitespace, non-brace characters as the slot ID.
 * This is intentionally permissive: structural validation (ValidationEngine)
 * is the right layer to enforce naming conventions. The compiler pass only
 * needs to identify and replace tokens; an unresolvable slot triggers
 * UNKNOWN_BINDING_SLOT with a clear error rather than a confusing sentinel
 * "upstream bug" message.
 */
/**
 * Exported so both the compiler pass and the structural validator use the
 * identical pattern — one definition, zero drift risk between layers.
 *
 * Consumers must reset `lastIndex` before each use (it is a stateful `g` regex).
 */
export const BINDING_TOKEN_RE = /\{\{wr\.bindings\.([^\s{}]+)\}\}/g;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type BindingPassError = {
  readonly code: 'UNKNOWN_BINDING_SLOT';
  readonly stepId: string;
  readonly slotId: string;
  readonly message: string;
};

// ---------------------------------------------------------------------------
// Slot resolution
// ---------------------------------------------------------------------------

/**
 * The source of a resolved binding slot — used to populate `resolvedOverrides`
 * (project-sourced only) alongside the full `resolvedBindings` manifest.
 */
export type BindingSource = 'project_override' | 'default';

/**
 * Result of resolving a single slot — includes the resolved value and its source.
 * The source is needed to populate `resolvedOverrides` vs `resolvedBindings`.
 */
interface SlotResolution {
  readonly value: string;
  readonly source: BindingSource;
}

/**
 * Resolve a single slot ID to its bound routine/workflow ID and source.
 *
 * Resolution order:
 * 1. Project override (from .workrail/bindings.json) → source: 'project_override'
 * 2. extensionPoint default                          → source: 'default'
 * 3. err(UNKNOWN_BINDING_SLOT) — fail fast
 */
function resolveSlot(
  slotId: string,
  stepId: string,
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
): Result<SlotResolution, BindingPassError> {
  // 1. Project override wins
  const override = projectBindings.get(slotId);
  if (override !== undefined) return ok({ value: override, source: 'project_override' });

  // 2. extensionPoint default
  const ep = extensionPoints.find(ep => ep.slotId === slotId);
  if (ep !== undefined) return ok({ value: ep.default, source: 'default' });

  // 3. Unknown slot — fail fast with helpful message
  const knownSlots = extensionPoints.map(ep => ep.slotId);
  const hint = knownSlots.length === 0
    ? 'This workflow declares no extensionPoints. Add an extensionPoints entry with this slotId.'
    : `Declared slots: [${knownSlots.join(', ')}]. Check for typos.`;

  return err({
    code: 'UNKNOWN_BINDING_SLOT',
    stepId,
    slotId,
    message: `Step '${stepId}': unknown binding slot '${slotId}'. ${hint}`,
  });
}

// ---------------------------------------------------------------------------
// String-level token replacement
// ---------------------------------------------------------------------------

/**
 * Result of resolving binding tokens in a single string.
 * Carries both the substituted text and the slot→routineId pairs resolved,
 * so callers can populate the binding manifest without a second pass.
 */
interface StringResolutionResult {
  readonly text: string;
  /** All (slotId → SlotResolution) pairs resolved during this substitution. */
  readonly resolved: ReadonlyMap<string, SlotResolution>;
}

/**
 * Replace all {{wr.bindings.slotId}} tokens in a string.
 *
 * Returns err on the first unresolvable slot. On success, returns both
 * the substituted string and the map of slot→SlotResolution pairs that were
 * resolved — collected in a single pass to avoid redundant work.
 *
 * SlotResolution carries both the resolved value and its source
 * ('project_override' | 'default'), allowing callers to populate
 * both `resolvedBindings` (all) and `resolvedOverrides` (project-sourced only).
 */
function resolveBindingTokensInString(
  text: string,
  stepId: string,
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
): Result<StringResolutionResult, BindingPassError> {
  // Fast path: no binding tokens present
  if (!text.includes('{{wr.bindings.')) return ok({ text, resolved: new Map() });

  let result = text;
  const resolvedMap = new Map<string, SlotResolution>();

  // Collect all matches first to avoid modifying the string while iterating
  const matches: Array<{ full: string; slotId: string }> = [];
  const re = new RegExp(BINDING_TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    matches.push({ full: match[0]!, slotId: match[1]! });
  }

  for (const { full, slotId } of matches) {
    const resolved = resolveSlot(slotId, stepId, extensionPoints, projectBindings);
    if (resolved.isErr()) return err(resolved.error);
    // Replace all occurrences of this specific token in the string
    result = result.split(full).join(resolved.value.value);
    resolvedMap.set(slotId, resolved.value);
  }

  return ok({ text: result, resolved: resolvedMap });
}

// ---------------------------------------------------------------------------
// PromptBlocks scanning — plain string PromptValue fields only
// ---------------------------------------------------------------------------

/**
 * Scan a PromptValue for binding tokens.
 *
/**
 * Accumulator threaded through all binding resolution helpers.
 *
 * Two separate maps so callers can populate:
 * - `all`       — every resolved slot (for the full `resolvedBindings` manifest)
 * - `overrides` — only project-override slots (for `resolvedOverrides`, used by
 *                 drift detection to correctly identify override-removal as drift)
 */
interface BindingAccumulator {
  readonly all: Map<string, string>;
  readonly overrides: Map<string, string>;
}

/** Merge a SlotResolution into the accumulator — only records in the correct map. */
function accumulateSlotResolution(acc: BindingAccumulator, slotId: string, resolution: SlotResolution): void {
  acc.all.set(slotId, resolution.value);
  if (resolution.source === 'project_override') {
    acc.overrides.set(slotId, resolution.value);
  }
}

/**
 * Only plain string PromptValues are scanned — PromptPart arrays
 * (used by wr.refs.*) are passed through unchanged because binding tokens
 * do not appear inside typed PromptPart arrays.
 *
 * Returns the substituted value plus any newly resolved slot entries.
 */
function resolveBindingTokensInPromptValue(
  value: PromptValue,
  stepId: string,
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
  acc: BindingAccumulator,
): Result<PromptValue, BindingPassError> {
  if (typeof value !== 'string') return ok(value);
  const res = resolveBindingTokensInString(value, stepId, extensionPoints, projectBindings);
  if (res.isErr()) return err(res.error);
  for (const [k, resolution] of res.value.resolved) accumulateSlotResolution(acc, k, resolution);
  return ok(res.value.text);
}

/**
 * Scan an array of PromptValues for binding tokens.
 */
function resolveBindingTokensInPromptValues(
  values: readonly PromptValue[],
  stepId: string,
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
  acc: BindingAccumulator,
): Result<readonly PromptValue[], BindingPassError> {
  const resolved: PromptValue[] = [];
  for (const v of values) {
    const res = resolveBindingTokensInPromptValue(v, stepId, extensionPoints, projectBindings, acc);
    if (res.isErr()) return err(res.error);
    resolved.push(res.value);
  }
  return ok(resolved);
}

/**
 * Scan all string fields in a PromptBlocks object for binding tokens.
 */
function resolveBindingTokensInBlocks(
  blocks: PromptBlocks,
  stepId: string,
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
  acc: BindingAccumulator,
): Result<PromptBlocks, BindingPassError> {
  let result: PromptBlocks = { ...blocks };

  if (blocks.goal !== undefined) {
    const res = resolveBindingTokensInPromptValue(blocks.goal, stepId, extensionPoints, projectBindings, acc);
    if (res.isErr()) return err(res.error);
    result = { ...result, goal: res.value };
  }

  if (blocks.constraints !== undefined) {
    const res = resolveBindingTokensInPromptValues(blocks.constraints, stepId, extensionPoints, projectBindings, acc);
    if (res.isErr()) return err(res.error);
    result = { ...result, constraints: res.value };
  }

  if (blocks.procedure !== undefined) {
    const res = resolveBindingTokensInPromptValues(blocks.procedure, stepId, extensionPoints, projectBindings, acc);
    if (res.isErr()) return err(res.error);
    result = { ...result, procedure: res.value };
  }

  if (blocks.verify !== undefined) {
    const res = resolveBindingTokensInPromptValues(blocks.verify, stepId, extensionPoints, projectBindings, acc);
    if (res.isErr()) return err(res.error);
    result = { ...result, verify: res.value };
  }

  if (blocks.outputRequired !== undefined) {
    const resolvedOutputRequired: Record<string, string> = {};
    for (const [key, value] of Object.entries(blocks.outputRequired)) {
      const res = resolveBindingTokensInString(value, stepId, extensionPoints, projectBindings);
      if (res.isErr()) return err(res.error);
      resolvedOutputRequired[key] = res.value.text;
      for (const [k, resolution] of res.value.resolved) accumulateSlotResolution(acc, k, resolution);
    }
    result = { ...result, outputRequired: resolvedOutputRequired };
  }

  return ok(result);
}

// ---------------------------------------------------------------------------
// Step-level resolution
// ---------------------------------------------------------------------------

/**
 * Resolve binding tokens in a single step.
 *
 * Generic over T to preserve the concrete step type (WorkflowStepDefinition or
 * LoopStepDefinition) — avoids unsafe `as LoopStepDefinition` casts at callsites.
 * Only `prompt` and `promptBlocks` fields are replaced; all other fields are
 * preserved via object spread.
 */
function resolveStepBindings<T extends WorkflowStepDefinition>(
  step: T,
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
  acc: BindingAccumulator,
): Result<T, BindingPassError> {
  let updated = step;

  // Resolve binding tokens in raw prompt string.
  // resolveBindingTokensInString returns both the substituted text and the
  // resolved slot entries in one pass — no second scan needed.
  if (step.prompt !== undefined) {
    const res = resolveBindingTokensInString(step.prompt, step.id, extensionPoints, projectBindings);
    if (res.isErr()) return err(res.error);
    if (res.value.text !== step.prompt) {
      // Spread preserves all fields of T (including loop-specific body, routineRef, etc.)
      updated = { ...updated, prompt: res.value.text };
    }
    for (const [k, resolution] of res.value.resolved) accumulateSlotResolution(acc, k, resolution);
  }

  // Resolve binding tokens in promptBlocks string values.
  // acc is threaded through so all surfaces are captured in one pass.
  if (step.promptBlocks !== undefined) {
    const res = resolveBindingTokensInBlocks(step.promptBlocks, step.id, extensionPoints, projectBindings, acc);
    if (res.isErr()) return err(res.error);
    updated = { ...updated, promptBlocks: res.value };
  }

  return ok(updated);
}

// ---------------------------------------------------------------------------
// Compiler pass
// ---------------------------------------------------------------------------

export interface BindingPassResult {
  readonly steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[];
  /** All resolved slots: slotId → routineId (both project overrides and defaults). */
  readonly resolvedBindings: ReadonlyMap<string, string>;
  /**
   * Project-override slots only: slotId → routineId.
   *
   * Subset of `resolvedBindings`. Used by drift detection at resume time so
   * that override-removal (currentValue === undefined) is correctly identified
   * as drift rather than "using default". Slots resolved via extensionPoint
   * defaults are absent here — `undefined` for them at resume time is not drift.
   */
  readonly resolvedOverrides: ReadonlyMap<string, string>;
}

/**
 * Compiler pass: resolve all {{wr.bindings.slotId}} tokens.
 *
 * Processes top-level steps and inline loop body steps.
 * Resolution order: projectBindings override → extensionPoint default → fail fast.
 * Pure function — no I/O, no mutation.
 */
export function resolveBindingsPass(
  steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[],
  extensionPoints: readonly ExtensionPoint[],
  projectBindings: ProjectBindings,
): Result<BindingPassResult, BindingPassError> {
  const resolved: (WorkflowStepDefinition | LoopStepDefinition)[] = [];
  const acc: BindingAccumulator = { all: new Map(), overrides: new Map() };

  for (const step of steps) {
    if (isLoopStepDefinition(step)) {
      // resolveStepBindings<LoopStepDefinition> preserves the concrete type —
      // no cast needed. prompt/promptBlocks are updated; body and all other
      // loop-specific fields flow through via the generic spread.
      const loopRes = resolveStepBindings(step, extensionPoints, projectBindings, acc);
      if (loopRes.isErr()) return err(loopRes.error);

      // Resolve inline loop body steps and re-attach under the updated loop.
      if (Array.isArray(step.body)) {
        const bodyResolved: WorkflowStepDefinition[] = [];
        for (const bodyStep of step.body) {
          const bodyRes = resolveStepBindings(bodyStep, extensionPoints, projectBindings, acc);
          if (bodyRes.isErr()) return err(bodyRes.error);
          bodyResolved.push(bodyRes.value);
        }
        resolved.push({ ...loopRes.value, body: bodyResolved });
      } else {
        resolved.push(loopRes.value);
      }
    } else {
      const res = resolveStepBindings(step, extensionPoints, projectBindings, acc);
      if (res.isErr()) return err(res.error);
      resolved.push(res.value);
    }
  }

  return ok({ steps: resolved, resolvedBindings: acc.all, resolvedOverrides: acc.overrides });
}
