/**
 * Internal render envelope for MCP response formatting.
 *
 * Keeps render-only metadata separate from public tool output schemas.
 * This metadata is consumed only at the `toMcpResult` boundary.
 *
 * @module mcp/render-envelope
 */

import type { StepContentEnvelope } from './step-content-envelope.js';

/** Valid lifecycle phases for v2 execution responses. */
export const V2_EXECUTION_LIFECYCLES = ['start', 'advance', 'rehydrate'] as const;

export type V2ExecutionResponseLifecycle = (typeof V2_EXECUTION_LIFECYCLES)[number];

export interface V2ExecutionRenderEnvelope<TResponse> {
  readonly kind: 'v2_execution_render_envelope';
  readonly response: TResponse;
  readonly lifecycle: V2ExecutionResponseLifecycle;
  /**
   * Typed content envelope for the pending step.
   * When present, the formatter can use it for structured content rendering.
   * When absent, the formatter falls back to current behavior (incremental adoption).
   */
  readonly contentEnvelope?: StepContentEnvelope;
}

export function createV2ExecutionRenderEnvelope<TResponse>(args: {
  readonly response: TResponse;
  readonly lifecycle: V2ExecutionResponseLifecycle;
  readonly contentEnvelope?: StepContentEnvelope;
}): V2ExecutionRenderEnvelope<TResponse> {
  return Object.freeze({
    kind: 'v2_execution_render_envelope' as const,
    response: args.response,
    lifecycle: args.lifecycle,
    ...(args.contentEnvelope != null ? { contentEnvelope: args.contentEnvelope } : {}),
  });
}

const VALID_LIFECYCLES: ReadonlySet<string> = new Set(V2_EXECUTION_LIFECYCLES);

export function isV2ExecutionRenderEnvelope(
  value: unknown,
): value is V2ExecutionRenderEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === 'v2_execution_render_envelope' &&
    'response' in candidate &&
    typeof candidate.lifecycle === 'string' &&
    VALID_LIFECYCLES.has(candidate.lifecycle)
  );
}
