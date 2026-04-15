/**
 * WorkRail Auto: Trigger Router
 *
 * Routes incoming webhook events to runWorkflow() calls.
 *
 * Responsibilities:
 * 1. Look up the trigger definition by ID from the store index.
 * 2. Validate HMAC-SHA256 signature (if hmacSecret is configured).
 * 3. Apply contextMapping: extract fields from payload using dot-path traversal.
 * 4. Enqueue a runWorkflow() call via KeyedAsyncQueue (fire-and-forget).
 * 5. Log results to stdout (MVP delivery system).
 *
 * Design notes:
 * - HMAC uses crypto.timingSafeEqual (timing-safe). Length difference short-circuits
 *   before the call -- this is safe because HMAC-SHA256 digest length is constant (32 bytes).
 * - KeyedAsyncQueue key = triggerId. Two concurrent webhooks for the same trigger are
 *   serialized; webhooks for different triggers run concurrently.
 * - runWorkflow() is called AFTER the 202 response is sent. The caller (listener) fires
 *   the route call as a background task; the result is logged, not returned.
 * - contextMapping dot-path: "$.pull_request.html_url" -> payload.pull_request.html_url.
 *   Leading "$." is stripped. Array indexing (e.g. "[0]") logs a warning and returns undefined.
 */

import * as crypto from 'node:crypto';
import type { WorkflowTrigger, WorkflowRunResult } from '../daemon/workflow-runner.js';
import type { V2ToolContext } from '../mcp/types.js';
import { KeyedAsyncQueue } from '../v2/infra/in-memory/keyed-async-queue/index.js';
import type {
  TriggerDefinition,
  WebhookEvent,
  ContextMappingEntry,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteError =
  | { readonly kind: 'not_found'; readonly triggerId: string }
  | { readonly kind: 'hmac_invalid' }
  | { readonly kind: 'payload_error'; readonly message: string };

export type RouteResult =
  | { readonly _tag: 'enqueued'; readonly triggerId: string }
  | { readonly _tag: 'error'; readonly error: RouteError };

/**
 * Function signature for running a workflow.
 * Injected to allow testing without a real V2ToolContext and Anthropic API key.
 */
export type RunWorkflowFn = (
  trigger: WorkflowTrigger,
  ctx: V2ToolContext,
  apiKey: string,
) => Promise<WorkflowRunResult>;

// ---------------------------------------------------------------------------
// Context mapping: dot-path extraction
// ---------------------------------------------------------------------------

/**
 * Traverse an object using a dot-path string.
 *
 * Examples:
 *   "$.pull_request.html_url" -> obj.pull_request.html_url
 *   "pull_request.html_url"   -> obj.pull_request.html_url (leading "$." optional)
 *   "$.labels[0]"             -> logs warning, returns undefined (array indexing unsupported)
 *
 * @returns The extracted value, or undefined if the path does not exist or is invalid.
 */
function extractDotPath(
  obj: Readonly<Record<string, unknown>>,
  rawPath: string,
): unknown {
  // Strip optional leading "$." or "$"
  let path = rawPath.trim();
  if (path.startsWith('$.')) path = path.slice(2);
  else if (path.startsWith('$')) path = path.slice(1);

  const segments = path.split('.');

  let current: unknown = obj;
  for (const segment of segments) {
    if (segment.includes('[')) {
      // Array indexing not supported in MVP
      console.warn(
        `[TriggerRouter] contextMapping path "${rawPath}" contains array indexing ` +
        `(segment: "${segment}"). Array indexing is not supported in MVP. ` +
        `The extracted value will be undefined.`,
      );
      return undefined;
    }

    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

/**
 * Apply a contextMapping to a webhook payload.
 * Returns a Record of workflow context variables.
 * Missing required keys log a warning; undefined values are omitted.
 */
function applyContextMapping(
  payload: Readonly<Record<string, unknown>>,
  entries: readonly ContextMappingEntry[],
): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  for (const entry of entries) {
    const value = extractDotPath(payload, entry.payloadPath);

    if (value === undefined) {
      if (entry.required) {
        console.warn(
          `[TriggerRouter] Required contextMapping key "${entry.workflowContextKey}" ` +
          `(path: "${entry.payloadPath}") resolved to undefined. ` +
          `The workflow context will be missing this variable.`,
        );
      }
      // Omit undefined values from context
      continue;
    }

    context[entry.workflowContextKey] = value;
  }

  return context;
}

// ---------------------------------------------------------------------------
// HMAC validation
// ---------------------------------------------------------------------------

/**
 * Validate X-WorkRail-Signature HMAC-SHA256 signature.
 *
 * Uses crypto.timingSafeEqual to prevent timing attacks.
 * Short-circuits on length difference (safe: HMAC-SHA256 digest length is constant).
 *
 * @param rawBody - Raw request body bytes (must match what the sender hashed)
 * @param secret - HMAC secret (already resolved from env)
 * @param headerValue - The X-WorkRail-Signature header value from the request
 * @returns true if the signature is valid, false otherwise
 */
function validateHmac(rawBody: Buffer, secret: string, headerValue: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Normalize header: strip optional "sha256=" prefix (GitHub-style)
  const received = headerValue.startsWith('sha256=')
    ? headerValue.slice(7)
    : headerValue;

  // Different lengths = not equal (safe early exit; length is not secret for hex digest)
  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(received, 'utf8'),
  );
}

// ---------------------------------------------------------------------------
// TriggerRouter class
// ---------------------------------------------------------------------------

export class TriggerRouter {
  private readonly queue = new KeyedAsyncQueue();

  constructor(
    private readonly index: ReadonlyMap<string, TriggerDefinition>,
    private readonly ctx: V2ToolContext,
    private readonly apiKey: string,
    private readonly runWorkflowFn: RunWorkflowFn,
  ) {}

  /**
   * Route an incoming webhook event.
   *
   * Returns immediately with a RouteResult. The actual runWorkflow() call is
   * enqueued asynchronously -- the caller must NOT await the workflow run.
   *
   * The returned `_tag: 'enqueued'` result means the event was accepted and
   * queued for processing. It does NOT mean the workflow completed successfully.
   */
  route(event: WebhookEvent): RouteResult {
    const trigger = this.index.get(event.triggerId);
    if (!trigger) {
      return {
        _tag: 'error',
        error: { kind: 'not_found', triggerId: event.triggerId },
      };
    }

    // HMAC validation (only if hmacSecret is configured)
    if (trigger.hmacSecret) {
      const signature = event.signature;
      if (!signature) {
        return { _tag: 'error', error: { kind: 'hmac_invalid' } };
      }
      if (!validateHmac(event.rawBody, trigger.hmacSecret, signature)) {
        return { _tag: 'error', error: { kind: 'hmac_invalid' } };
      }
    }

    // Build workflow context from contextMapping + raw payload fallback
    let workflowContext: Record<string, unknown>;
    if (trigger.contextMapping?.mappings.length) {
      workflowContext = applyContextMapping(event.payload, trigger.contextMapping.mappings);
    } else {
      // No contextMapping: pass raw payload as context.payload
      workflowContext = { payload: event.payload };
    }

    const workflowTrigger: WorkflowTrigger = {
      workflowId: trigger.workflowId,
      goal: trigger.goal,
      workspacePath: trigger.workspacePath,
      context: workflowContext,
    };

    // Enqueue asynchronously -- serialize per triggerId to prevent token corruption
    // when two webhooks fire concurrently for the same trigger.
    void this.queue.enqueue(trigger.id, async () => {
      const result = await this.runWorkflowFn(workflowTrigger, this.ctx, this.apiKey);
      if (result._tag === 'success') {
        console.log(
          `[TriggerRouter] Workflow completed: triggerId=${trigger.id} ` +
          `workflowId=${trigger.workflowId} stopReason=${result.stopReason}`,
        );
      } else {
        console.log(
          `[TriggerRouter] Workflow failed: triggerId=${trigger.id} ` +
          `workflowId=${trigger.workflowId} error=${result.message} stopReason=${result.stopReason}`,
        );
      }
    });

    return { _tag: 'enqueued', triggerId: trigger.id };
  }
}
