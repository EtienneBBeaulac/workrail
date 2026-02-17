/**
 * v2 State Conversion
 *
 * Pure functions converting between v1 ExecutionState (used by WorkflowInterpreter)
 * and v2 EngineStateV1 (stored in execution snapshots).
 *
 * Also contains step metadata extraction, preference derivation, and intent derivation.
 */

import type { EngineStateV1, LoopPathFrameV1 } from '../../v2/durable-core/schemas/execution-snapshot/index.js';
import { asDelimiterSafeIdV1, stepInstanceKeyFromParts } from '../../v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import type { ExecutionState, LoopFrame } from '../../domain/execution/state.js';
import type { RunId, NodeId } from '../../v2/durable-core/ids/index.js';
import type { LoadedSessionTruthV2 } from '../../v2/ports/session-event-log-store.port.js';
import { projectPreferencesV2 } from '../../v2/projections/preferences.js';
import { createWorkflow, getStepById } from '../../types/workflow.js';
import { EVENT_KIND } from '../../v2/durable-core/constants.js';

// ── State Conversion ──────────────────────────────────────────────────

/** Convert v2 EngineStateV1 (snapshot) to v1 ExecutionState (interpreter). */
export function toV1ExecutionState(engineState: EngineStateV1): ExecutionState {
  if (engineState.kind === 'init') return { kind: 'init' as const };
  if (engineState.kind === 'complete') return { kind: 'complete' as const };

  const pendingStep =
    engineState.pending.kind === 'some'
      ? {
          stepId: String(engineState.pending.step.stepId),
          loopPath: engineState.pending.step.loopPath.map((f: LoopPathFrameV1) => ({
            loopId: String(f.loopId),
            iteration: f.iteration,
          })),
        }
      : undefined;

  return {
    kind: 'running' as const,
    completed: [...engineState.completed.values].map(String),
    loopStack: engineState.loopStack.map((f) => ({
      loopId: String(f.loopId),
      iteration: f.iteration,
      bodyIndex: f.bodyIndex,
    })),
    pendingStep,
  };
}

/** Convert a running v1 ExecutionState to v2 EngineStateV1 (running variant). */
export function convertRunningExecutionStateToEngineState(
  state: Extract<ExecutionState, { kind: 'running' }>
): Extract<EngineStateV1, { kind: 'running' }> {
  const completedArray: readonly string[] = [...state.completed].sort((a: string, b: string) =>
    a.localeCompare(b)
  );
  const completed = completedArray.map(s => stepInstanceKeyFromParts(asDelimiterSafeIdV1(s), []));

  const loopStack = state.loopStack.map((f: LoopFrame) => ({
    loopId: asDelimiterSafeIdV1(f.loopId),
    iteration: f.iteration,
    bodyIndex: f.bodyIndex,
  }));

  const pending = state.pendingStep
    ? {
        kind: 'some' as const,
        step: {
          stepId: asDelimiterSafeIdV1(state.pendingStep.stepId),
          loopPath: state.pendingStep.loopPath.map((p) => ({
            loopId: asDelimiterSafeIdV1(p.loopId),
            iteration: p.iteration,
          })),
        },
      }
    : { kind: 'none' as const };

  return {
    kind: 'running' as const,
    completed: { kind: 'set' as const, values: completed },
    loopStack,
    pending,
  };
}

/** Convert any v1 ExecutionState to v2 EngineStateV1. */
export function fromV1ExecutionState(state: ExecutionState): EngineStateV1 {
  if (state.kind === 'init') {
    return { kind: 'init' as const };
  }
  if (state.kind === 'complete') {
    return { kind: 'complete' as const };
  }
  return convertRunningExecutionStateToEngineState(state);
}

// ── Workflow Source Kind ───────────────────────────────────────────────

export type WorkflowSourceKind = 'bundled' | 'user' | 'project' | 'remote' | 'plugin';

const workflowSourceKindMap: Record<string, WorkflowSourceKind> = {
  bundled: 'bundled',
  user: 'user',
  project: 'project',
  remote: 'remote',
  plugin: 'plugin',
  git: 'remote',
  custom: 'project',
};

/** Map a raw source kind string to the closed WorkflowSourceKind set. */
export function mapWorkflowSourceKind(kind: string): WorkflowSourceKind {
  const mapped = workflowSourceKindMap[kind];
  return mapped ?? 'project';
}

// ── Step Metadata ─────────────────────────────────────────────────────

export interface StepMetadata {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly requireConfirmation: boolean;
}

/**
 * Extract step metadata (title, prompt) from a workflow step with type-safe property access.
 * Returns sealed StepMetadata with guaranteed non-empty strings.
 */
export function extractStepMetadata(
  workflow: ReturnType<typeof createWorkflow>,
  stepId: string | null,
  options?: { defaultTitle?: string; defaultPrompt?: string }
): StepMetadata {
  const resolvedStepId = stepId ?? '';
  const step = stepId ? getStepById(workflow, stepId) : null;

  const hasStringProp = (obj: unknown, prop: string): boolean =>
    typeof obj === 'object' &&
    obj !== null &&
    prop in obj &&
    typeof (obj as unknown as Record<string, unknown>)[prop] === 'string';

  const title = hasStringProp(step, 'title')
    ? String((step as unknown as Record<string, unknown>).title)
    : options?.defaultTitle ?? resolvedStepId;

  const prompt = hasStringProp(step, 'prompt')
    ? String((step as unknown as Record<string, unknown>).prompt)
    : options?.defaultPrompt ?? (stepId ? `Pending step: ${stepId}` : '');

  const requireConfirmation =
    typeof step === 'object' && step !== null && 'requireConfirmation' in step
      ? Boolean((step as unknown as Record<string, unknown>).requireConfirmation)
      : false;

  return { stepId: resolvedStepId, title, prompt, requireConfirmation };
}

// ── Preferences ───────────────────────────────────────────────────────

export type PreferencesV2 = {
  readonly autonomy: 'guided' | 'full_auto_stop_on_user_deps' | 'full_auto_never_stop';
  readonly riskPolicy: 'conservative' | 'balanced' | 'aggressive';
};

export const defaultPreferences: PreferencesV2 = { autonomy: 'guided', riskPolicy: 'conservative' };

/** Derive effective preferences for a specific node from durable events. */
export function derivePreferencesForNode(args: {
  readonly truth: LoadedSessionTruthV2;
  readonly runId: RunId;
  readonly nodeId: NodeId;
}): PreferencesV2 {
  const parentByNodeId: Record<string, string | null> = {};
  for (const e of args.truth.events) {
    if (e.kind !== EVENT_KIND.NODE_CREATED) continue;
    if (e.scope?.runId !== String(args.runId)) continue;
    parentByNodeId[String(e.scope.nodeId)] = e.data.parentNodeId;
  }

  const prefs = projectPreferencesV2(args.truth.events, parentByNodeId);
  if (prefs.isErr()) return defaultPreferences;

  const p = prefs.value.byNodeId[String(args.nodeId)]?.effective;
  if (!p) return defaultPreferences;

  return { autonomy: p.autonomy, riskPolicy: p.riskPolicy };
}

// ── Intent ────────────────────────────────────────────────────────────

export type NextIntentV2 = 'perform_pending_then_continue' | 'await_user_confirmation' | 'rehydrate_only' | 'complete';

/** Derive the next intent from execution state. */
export function deriveNextIntent(args: {
  readonly rehydrateOnly: boolean;
  readonly isComplete: boolean;
  readonly pending: StepMetadata | null;
}): NextIntentV2 {
  if (args.isComplete && !args.pending) return 'complete';
  if (args.rehydrateOnly) return 'rehydrate_only';
  if (!args.pending) return 'complete';
  return args.pending.requireConfirmation ? 'await_user_confirmation' : 'perform_pending_then_continue';
}
