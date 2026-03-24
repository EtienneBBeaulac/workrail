/**
 * Test helper: unwrap a render envelope to access the inner response.
 *
 * Handlers now wrap responses in V2ExecutionRenderEnvelope. Tests that
 * access `.data.continueToken` etc. need to unwrap first.
 */

import { isV2ExecutionRenderEnvelope } from '../../src/mcp/render-envelope.js';

/**
 * If `data` is a render envelope, returns the inner `response`.
 * Otherwise returns `data` as-is (backward compat for non-enveloped paths).
 */
export function unwrapResponse(data: unknown): Record<string, unknown> {
  if (isV2ExecutionRenderEnvelope(data)) {
    return data.response as Record<string, unknown>;
  }
  return data as Record<string, unknown>;
}
