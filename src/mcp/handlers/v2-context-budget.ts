/**
 * v2 Context Budget Checking
 *
 * Pure functions for validating context objects against budget constraints.
 * Enforces:
 * - JSON-safe values only (no undefined/functions/symbols)
 * - No circular references
 * - Depth limit (MAX_CONTEXT_DEPTH)
 * - Byte budget (MAX_CONTEXT_BYTES measured as JCS UTF-8)
 * - Canonical JSON serialization (RFC 8785)
 */

import { errNotRetryable } from '../types.js';
import type { JsonObject, JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { toCanonicalBytes } from '../../v2/durable-core/canonical/jcs.js';
import {
  EVENT_KIND,
  OUTPUT_CHANNEL,
  PAYLOAD_KIND,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_DEPTH,
} from '../../v2/durable-core/constants.js';
import { normalizeTokenErrorMessage } from './v2-error-mapping.js';
import type { ToolFailure } from './v2-execution-helpers.js';

// ── Types ─────────────────────────────────────────────────────────────

type Bytes = number & { readonly __brand: 'Bytes' };

const MAX_CONTEXT_BYTES_V2 = MAX_CONTEXT_BYTES as Bytes;

export type ContextToolNameV2 = 'start_workflow' | 'continue_workflow';

type ContextValidationIssue =
  | { readonly kind: 'unsupported_value'; readonly path: string; readonly valueType: string }
  | { readonly kind: 'non_finite_number'; readonly path: string; readonly value: string }
  | { readonly kind: 'circular_reference'; readonly path: string }
  | { readonly kind: 'too_deep'; readonly path: string; readonly maxDepth: number };

type ContextValidationDetails =
  | { readonly kind: 'context_invalid_shape'; readonly tool: ContextToolNameV2; readonly expected: 'object' }
  | { readonly kind: 'context_unsupported_value'; readonly tool: ContextToolNameV2; readonly path: string; readonly valueType: string }
  | { readonly kind: 'context_non_finite_number'; readonly tool: ContextToolNameV2; readonly path: string; readonly value: string }
  | { readonly kind: 'context_circular_reference'; readonly tool: ContextToolNameV2; readonly path: string }
  | { readonly kind: 'context_too_deep'; readonly tool: ContextToolNameV2; readonly path: string; readonly maxDepth: number }
  | { readonly kind: 'context_not_canonical_json'; readonly tool: ContextToolNameV2; readonly measuredAs: 'jcs_utf8_bytes'; readonly code: string; readonly message: string }
  | { readonly kind: 'context_budget_exceeded'; readonly tool: ContextToolNameV2; readonly measuredBytes: number; readonly maxBytes: number; readonly measuredAs: 'jcs_utf8_bytes' };

export type ContextBudgetCheck = { readonly ok: true } | { readonly ok: false; readonly error: ToolFailure };

// ── Validation ────────────────────────────────────────────────────────

/** Recursively validate a JSON value for JSON-safety, depth, and circularity. */
function validateJsonValueOrIssue(value: unknown, path: string, depth: number, seen: WeakSet<object>): ContextValidationIssue | null {
  if (depth > MAX_CONTEXT_DEPTH) return { kind: 'too_deep', path, maxDepth: MAX_CONTEXT_DEPTH };

  if (value === null) return null;

  const t = typeof value;
  if (t === 'string' || t === 'boolean') return null;

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      return { kind: 'non_finite_number', path, value: String(value) };
    }
    return null;
  }

  if (t === 'object') {
    if (Array.isArray(value)) {
      if (seen.has(value)) return { kind: 'circular_reference', path };
      seen.add(value);
      for (let i = 0; i < value.length; i++) {
        const child = validateJsonValueOrIssue(value[i], `${path}[${i}]`, depth + 1, seen);
        if (child) return child;
      }
      return null;
    }

    if (seen.has(value as object)) return { kind: 'circular_reference', path };
    seen.add(value as object);

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const child = validateJsonValueOrIssue(v, path === '$' ? `$.${k}` : `${path}.${k}`, depth + 1, seen);
      if (child) return child;
    }

    return null;
  }

  return { kind: 'unsupported_value', path, valueType: t };
}

/**
 * Check context against all budget constraints.
 * Returns ok=true if valid, or ok=false with a ToolFailure containing structured details.
 */
export function checkContextBudget(args: { readonly tool: ContextToolNameV2; readonly context: unknown }): ContextBudgetCheck {
  if (args.context === undefined) return { ok: true };

  if (typeof args.context !== 'object' || args.context === null || Array.isArray(args.context)) {
    const details = {
      kind: 'context_invalid_shape',
      tool: args.tool,
      expected: 'object',
    } satisfies ContextValidationDetails & JsonObject;

    return {
      ok: false,
      error: errNotRetryable('VALIDATION_ERROR', `context must be a JSON object for ${args.tool}.`, {
        suggestion:
          'Pass context as an object of external inputs (e.g., {"ticketId":"...","repoPath":"..."}). Do not pass arrays or primitives.',
        details,
      }) as ToolFailure,
    };
  }

  const contextObj = args.context as JsonObject;

  const issue = validateJsonValueOrIssue(contextObj, '$', 0, new WeakSet());
  if (issue) {
    const details = (() => {
      switch (issue.kind) {
        case 'unsupported_value':
          return {
            kind: 'context_unsupported_value',
            tool: args.tool,
            path: issue.path,
            valueType: issue.valueType,
          } satisfies ContextValidationDetails & JsonObject;
        case 'non_finite_number':
          return {
            kind: 'context_non_finite_number',
            tool: args.tool,
            path: issue.path,
            value: issue.value,
          } satisfies ContextValidationDetails & JsonObject;
        case 'circular_reference':
          return {
            kind: 'context_circular_reference',
            tool: args.tool,
            path: issue.path,
          } satisfies ContextValidationDetails & JsonObject;
        case 'too_deep':
          return {
            kind: 'context_too_deep',
            tool: args.tool,
            path: issue.path,
            maxDepth: issue.maxDepth,
          } satisfies ContextValidationDetails & JsonObject;
        default: {
          const _exhaustive: never = issue;
          return {
            kind: 'context_invalid_shape',
            tool: args.tool,
            expected: 'object',
          } satisfies ContextValidationDetails & JsonObject;
        }
      }
    })();

    return {
      ok: false,
      error: errNotRetryable(
        'VALIDATION_ERROR',
        normalizeTokenErrorMessage(`context is not JSON-serializable for ${args.tool} (see details).`),
        {
          suggestion:
            'Remove non-JSON values (undefined/functions/symbols), circular references, and non-finite numbers. Keep context to plain JSON objects/arrays/primitives only.',
          details: details as unknown as JsonValue,
        }
      ) as ToolFailure,
    };
  }

  const canonicalRes = toCanonicalBytes(contextObj);
  if (canonicalRes.isErr()) {
    const details = {
      kind: 'context_not_canonical_json',
      tool: args.tool,
      measuredAs: 'jcs_utf8_bytes',
      code: canonicalRes.error.code,
      message: canonicalRes.error.message,
    } satisfies ContextValidationDetails & JsonObject;

    const suggestion =
      canonicalRes.error.code === 'CANONICAL_JSON_NON_FINITE_NUMBER'
        ? 'Remove NaN/Infinity/-Infinity from context. Canonical JSON forbids non-finite numbers.'
        : 'Ensure context contains only JSON primitives, arrays, and objects (no undefined/functions/symbols).';

    return {
      ok: false,
      error: errNotRetryable(
        'VALIDATION_ERROR',
        normalizeTokenErrorMessage(`context cannot be canonicalized for ${args.tool}: ${canonicalRes.error.code}`),
        {
          suggestion,
          details,
        }
      ) as ToolFailure,
    };
  }

  const measuredBytes = (canonicalRes.value as unknown as Uint8Array).length as Bytes;
  if (measuredBytes > MAX_CONTEXT_BYTES_V2) {
    const details = {
      kind: 'context_budget_exceeded',
      tool: args.tool,
      measuredBytes,
      maxBytes: MAX_CONTEXT_BYTES_V2,
      measuredAs: 'jcs_utf8_bytes',
    } satisfies ContextValidationDetails & JsonObject;

    return {
      ok: false,
      error: errNotRetryable(
        'VALIDATION_ERROR',
        `context is too large for ${args.tool}: ${measuredBytes} bytes (max ${MAX_CONTEXT_BYTES_V2}). Size is measured as UTF-8 bytes of RFC 8785 (JCS) canonical JSON.`,
        {
          suggestion:
            'Remove large blobs from context (docs/logs/diffs). Pass references instead (file paths, IDs, hashes). If you must include text, include only the minimal excerpt, then retry.',
          details,
        }
      ) as ToolFailure,
    };
  }

  return { ok: true };
}

// ── Artifact Collection ───────────────────────────────────────────────

import type { DomainEventV1 } from '../../v2/durable-core/schemas/session/index.js';

/**
 * Collect artifacts for loop evaluation from durable events + current input.
 * Deterministic: eventIndex order, then current attempt appended.
 */
export function collectArtifactsForEvaluation(args: {
  readonly truthEvents: readonly DomainEventV1[];
  readonly inputArtifacts: readonly unknown[];
}): readonly unknown[] {
  const collected: unknown[] = [];

  for (const e of args.truthEvents) {
    if (e.kind !== EVENT_KIND.NODE_OUTPUT_APPENDED) continue;
    if (e.data.outputChannel !== OUTPUT_CHANNEL.ARTIFACT) continue;
    if (e.data.payload.payloadKind !== PAYLOAD_KIND.ARTIFACT_REF) continue;
    const payload = e.data.payload as typeof e.data.payload & { content?: unknown };
    if (payload.content === undefined) continue;
    collected.push(payload.content);
  }

  return [...collected, ...args.inputArtifacts];
}
