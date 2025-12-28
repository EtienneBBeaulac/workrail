/**
 * workflow_next pre-validation (error UX only)
 *
 * This module performs shallow checks for obviously wrong shapes and returns a
 * bounded, copy/pasteable template to help the agent correct the call.
 *
 * Important:
 * - This is NOT a schema. Zod remains the source of truth.
 * - This MUST NOT silently coerce invalid input into valid input.
 */

import { errNotRetryable } from '../types.js';
import type { ToolError } from '../types.js';
import type { JsonValue } from '../output-schemas.js';

export type PreValidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ToolError };

function normalizeWorkflowIdForTemplate(value: unknown): string {
  if (typeof value !== 'string') return '<workflowId>';
  // Keep help payloads small and deterministic.
  if (value.length === 0) return '<workflowId>';
  if (value.length > 64) return '<workflowId>';
  return value;
}

function variablesToContextTemplate(value: unknown): Record<string, JsonValue> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  const result: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Only include values that are JSON-safe (filter out undefined)
    if (v !== undefined) {
      result[k] = v as JsonValue;
    }
  }
  return result;
}

export function preValidateWorkflowNextArgs(args: unknown): PreValidateResult {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: errNotRetryable('VALIDATION_ERROR', 'Invalid input: expected a JSON object.') };
  }

  const a = args as Record<string, unknown>;
  const suggestedContext = variablesToContextTemplate(a.variables);

  if (!('workflowId' in a)) {
    return { ok: false, error: errNotRetryable('VALIDATION_ERROR', 'Missing required field: workflowId.') };
  }

  if (!('state' in a)) {
    return {
      ok: false,
      error: errNotRetryable('VALIDATION_ERROR', 'Missing required field: state. For the first call, use { kind: "init" }.', {
        correctTemplate: {
          workflowId: normalizeWorkflowIdForTemplate(a.workflowId),
          state: { kind: 'init' },
          context: suggestedContext,
        },
      }),
    };
  }

  const state = a.state as unknown;
  if (state == null || typeof state !== 'object' || Array.isArray(state)) {
    return {
      ok: false,
      error: errNotRetryable('VALIDATION_ERROR', 'Invalid state: expected an object with discriminator field "kind".', {
        correctTemplate: { kind: 'init' },
      }),
    };
  }

  const kind = (state as any).kind as unknown;
  if (typeof kind !== 'string') {
    return {
      ok: false,
      error: errNotRetryable('VALIDATION_ERROR', 'Invalid state: missing state.kind. Valid values: "init" | "running" | "complete".', {
        correctTemplate: { kind: 'init' },
      }),
    };
  }

  if (kind === 'running') {
    const completed = (state as any).completed;
    const loopStack = (state as any).loopStack;
    if (!Array.isArray(completed) || !Array.isArray(loopStack)) {
      return {
        ok: false,
        error: errNotRetryable('VALIDATION_ERROR', 'Invalid state: state.kind="running" requires completed: string[] and loopStack: LoopFrame[].', {
          correctTemplate: { kind: 'running', completed: [], loopStack: [] },
        }),
      };
    }
  }

  // Common mistake: using `variables` instead of `context` (context is the only supported key).
  if ('variables' in a && !('context' in a)) {
    const correctTemplate: Record<string, JsonValue> = {
      workflowId: normalizeWorkflowIdForTemplate(a.workflowId),
      state: a.state as JsonValue,
      context: suggestedContext,
    };
    if (a.event && typeof a.event === 'object') {
      correctTemplate.event = a.event as JsonValue;
    }
    return {
      ok: false,
      error: errNotRetryable('VALIDATION_ERROR', 'Unexpected top-level key: variables. Use context (object) for condition evaluation and loop inputs.', {
        correctTemplate,
      }),
    };
  }

  // Leave detailed validation to Zod (source of truth).
  return { ok: true };
}
