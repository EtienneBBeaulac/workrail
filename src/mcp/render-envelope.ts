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

interface V2ExecutionRenderMetadata {
  readonly lifecycle: V2ExecutionResponseLifecycle;
  readonly contentEnvelope?: StepContentEnvelope;
}

const V2_EXECUTION_RENDER_META = Symbol.for('workrail.v2ExecutionRenderMeta');

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

export function attachV2ExecutionRenderMetadata<TResponse extends object>(args: {
  readonly response: TResponse;
  readonly lifecycle: V2ExecutionResponseLifecycle;
  readonly contentEnvelope?: StepContentEnvelope;
}): TResponse {
  Object.defineProperty(args.response, V2_EXECUTION_RENDER_META, {
    value: Object.freeze({
      lifecycle: args.lifecycle,
      ...(args.contentEnvelope != null ? { contentEnvelope: args.contentEnvelope } : {}),
    } satisfies V2ExecutionRenderMetadata),
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return args.response;
}

export function getV2ExecutionRenderEnvelope(
  value: unknown,
): V2ExecutionRenderEnvelope<unknown> | null {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === 'v2_execution_render_envelope' &&
    'response' in candidate &&
    typeof candidate.lifecycle === 'string' &&
    VALID_LIFECYCLES.has(candidate.lifecycle)
  ) {
    return candidate as unknown as V2ExecutionRenderEnvelope<unknown>;
  }

  const metadata = Reflect.get(candidate, V2_EXECUTION_RENDER_META) as V2ExecutionRenderMetadata | undefined;
  if (metadata == null || !VALID_LIFECYCLES.has(metadata.lifecycle)) {
    return null;
  }

  return createV2ExecutionRenderEnvelope({
    response: value,
    lifecycle: metadata.lifecycle,
    contentEnvelope: metadata.contentEnvelope,
  });
}

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
