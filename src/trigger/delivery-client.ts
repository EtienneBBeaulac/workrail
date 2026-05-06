/**
 * WorkRail Auto: Delivery Client
 *
 * Posts a WorkflowRunResult as JSON to a configured callbackUrl.
 *
 * Design notes:
 * - post() uses the global fetch() (available since Node 18; this project
 *   requires Node >= 20 per package.json engines).
 * - Returns Result<void, DeliveryError>. Never throws. Errors are data.
 * - DeliveryError is a discriminated union so callers can distinguish
 *   HTTP-level failures (non-2xx) from network-level failures (no response).
 * - The callbackUrl is validated at load time in trigger-store.ts (http/https
 *   only). This module trusts the URL it receives.
 *
 * Non-goals:
 * - Retry on failure (follow-up work)
 * - Custom request headers / auth (follow-up work)
 */

import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import type { WorkflowRunResult } from '../daemon/types.js';
import type { DaemonEventEmitter } from '../daemon/daemon-events.js';

// ---------------------------------------------------------------------------
// DeliveryError: discriminated union for POST failure modes
// ---------------------------------------------------------------------------

export type DeliveryError =
  /** The server responded with a non-2xx HTTP status code. */
  | { readonly kind: 'http_error'; readonly status: number; readonly body: string }
  /** The request could not be sent (DNS failure, connection refused, timeout). */
  | { readonly kind: 'network_error'; readonly message: string };

// ---------------------------------------------------------------------------
// post: send WorkflowRunResult JSON to callbackUrl
// ---------------------------------------------------------------------------

/**
 * POST a WorkflowRunResult as JSON to the given callbackUrl.
 *
 * @param callbackUrl - The delivery target URL (must be http:// or https://).
 *   Validated at load time by trigger-store.ts; trusted here.
 * @param result - The WorkflowRunResult to deliver.
 * @param emitter - Optional event emitter. When provided, emits delivery_attempted
 *   after the HTTP POST resolves (success or failure). When absent, no event is emitted.
 * @returns Result<void, DeliveryError>. Never throws.
 */
export async function post(
  callbackUrl: string,
  result: WorkflowRunResult,
  emitter?: DaemonEventEmitter,
): Promise<Result<void, DeliveryError>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      emitter?.emit({ kind: 'delivery_attempted', callbackUrl, outcome: 'http_error', statusCode: res.status });
      return err({ kind: 'http_error', status: res.status, body });
    }
    emitter?.emit({ kind: 'delivery_attempted', callbackUrl, outcome: 'success', statusCode: res.status });
    return ok(undefined);
  } catch (e: unknown) {
    emitter?.emit({ kind: 'delivery_attempted', callbackUrl, outcome: 'network_error' });
    return err({ kind: 'network_error', message: String(e) });
  } finally {
    clearTimeout(timer);
  }
}
