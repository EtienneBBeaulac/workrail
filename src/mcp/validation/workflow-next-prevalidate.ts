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

export type PreValidateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'VALIDATION_ERROR' | 'PRECONDITION_FAILED';
      readonly message: string;
      readonly correctTemplate?: unknown;
    };

function normalizeWorkflowIdForTemplate(value: unknown): string {
  if (typeof value !== 'string') return '<workflowId>';
  // Keep help payloads small and deterministic.
  if (value.length === 0) return '<workflowId>';
  if (value.length > 64) return '<workflowId>';
  return value;
}

export function preValidateWorkflowNextArgs(args: unknown): PreValidateResult {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Invalid input: expected a JSON object.' };
  }

  const a = args as Record<string, unknown>;

  if (!('workflowId' in a)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Missing required field: workflowId.' };
  }

  if (!('state' in a)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Missing required field: state. For the first call, use { kind: "init" }.',
      correctTemplate: {
        workflowId: normalizeWorkflowIdForTemplate(a.workflowId),
        state: { kind: 'init' },
        context: {},
      },
    };
  }

  const state = a.state as unknown;
  if (state == null || typeof state !== 'object' || Array.isArray(state)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Invalid state: expected an object with discriminator field "kind".',
      correctTemplate: { kind: 'init' },
    };
  }

  const kind = (state as any).kind as unknown;
  if (typeof kind !== 'string') {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Invalid state: missing state.kind. Valid values: "init" | "running" | "complete".',
      correctTemplate: { kind: 'init' },
    };
  }

  if (kind === 'running') {
    const completed = (state as any).completed;
    const loopStack = (state as any).loopStack;
    if (!Array.isArray(completed) || !Array.isArray(loopStack)) {
      return {
        ok: false,
        code: 'VALIDATION_ERROR',
        message: 'Invalid state: state.kind="running" requires completed: string[] and loopStack: LoopFrame[].',
        correctTemplate: { kind: 'running', completed: [], loopStack: [] },
      };
    }
  }

  // Leave detailed validation to Zod (source of truth).
  return { ok: true };
}
