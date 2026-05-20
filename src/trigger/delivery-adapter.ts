/**
 * Pluggable output delivery: adapter interface, config types, and resolver.
 *
 * WHY in src/trigger/ (not src/daemon/): the coordinator layer cannot import
 * daemon-internal types; placing the interface here lets both delivery paths
 * share the same adapter contract.
 *
 * WHY generic DeliveryAdapter<K>: each adapter receives only its own config
 * variant so the compiler catches mismatched config at the call site rather
 * than requiring runtime narrowing inside deliver().
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config + payload types
// ---------------------------------------------------------------------------

export type AdapterConfig =
  | { readonly kind: 'cli_inbox' }
  | { readonly kind: 'github_draft_review'; readonly token: string; readonly login: string }
  | { readonly kind: 'gitlab_mr_note'; readonly token: string; readonly baseUrl: string; readonly projectId: string }
  | { readonly kind: 'slack_webhook'; readonly webhookUrl: string }
  | { readonly kind: 'callback_url'; readonly url: string }
  | { readonly kind: 'git_commit'; readonly autoOpenPR: boolean; readonly secretScan: boolean };

/**
 * WHY source discriminant: distinguishes operator-configured delivery ('explicit') from
 * the synthesized fallback ('synthesized'). route() only fires adapter.deliver() for
 * explicit configs -- prevents flooding outbox.jsonl for every session on every trigger.
 * A boolean would allow { explicit: false } to compile but behave as synthesized; a
 * discriminated union makes the two states exhaustive and unambiguous.
 */
export type DeliveryConfig =
  | { readonly source: 'explicit'; readonly adapters: readonly AdapterConfig[] }
  | { readonly source: 'synthesized'; readonly adapters: readonly AdapterConfig[] };

export interface DeliveryPayload {
  readonly workflowId: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly notes: string | null;
  readonly artifacts: readonly unknown[];
}

// ---------------------------------------------------------------------------
// Poll handle + receipt
// ---------------------------------------------------------------------------

export interface PollHandle {
  // WHY AdapterConfig['kind'] (not string): constrained to the closed set so
  // startup recovery can exhaustively switch without casting.
  readonly adapterId: AdapterConfig['kind'];
  // WHY Record<string,unknown>: each adapter stores its own polling state without
  // leaking internal types at the interface level.
  readonly state: Readonly<Record<string, unknown>>;
}

/** Errors are data -- deliver() must never throw. */
export type DeliveryReceipt =
  | { readonly kind: 'completed'; readonly destination: string }
  | { readonly kind: 'pending'; readonly pollHandle: PollHandle }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface DeliveryAdapter<K extends AdapterConfig['kind'] = AdapterConfig['kind']> {
  readonly adapterKind: K;
  deliver(
    payload: DeliveryPayload,
    config: Extract<AdapterConfig, { kind: K }>,
  ): Promise<DeliveryReceipt>;
}

// ---------------------------------------------------------------------------
// Migration shim: synthesize DeliveryConfig from legacy TriggerDefinition fields
// ---------------------------------------------------------------------------

/**
 * Parameters are the already-validated legacy delivery fields from TriggerDefinition.
 * Called once per trigger at parse time in validateAndResolveTrigger().
 *
 * WHY git_commit before github_draft_review: the branch must exist (commit pushed)
 * before a review can reference it. Ordering is positional in the adapters array.
 */
export interface SynthesizeDeliveryFields {
  readonly autoCommit?: boolean;
  readonly autoOpenPR?: boolean;
  readonly secretScan?: boolean;
  readonly callbackUrl?: string;
  readonly reviewerIdentity?: { readonly platform: 'github' | 'gitlab'; readonly token: string; readonly login: string };
}

export function synthesizeDeliveryConfig(fields: SynthesizeDeliveryFields): DeliveryConfig {
  const adapters: AdapterConfig[] = [];

  // git_commit first -- branch must exist before review can reference it
  if (fields.autoCommit) {
    adapters.push({
      kind: 'git_commit',
      autoOpenPR: fields.autoOpenPR ?? false,
      secretScan: fields.secretScan ?? true,
    });
  }

  // github_draft_review after commit
  if (fields.reviewerIdentity) {
    adapters.push({
      kind: 'github_draft_review',
      token: fields.reviewerIdentity.token,
      login: fields.reviewerIdentity.login,
    });
  }

  // callback_url: fire-and-forget HTTP notification.
  // Delivery still goes through runCallbackUrlDelivery() in route() (not _runDeliveryByKind())
  // to preserve the delivery_failed result that suppresses autoCommit.
  // The synthesized entry here is for observability (delivery_planned event) and
  // future Phase 8 unification through _runDeliveryByKind().
  if (fields.callbackUrl) {
    adapters.push({ kind: 'callback_url', url: fields.callbackUrl });
  }

  // cli_inbox fallback when no delivery fields are configured
  if (adapters.length === 0) {
    adapters.push({ kind: 'cli_inbox' });
  }

  return { source: 'synthesized', adapters };
}

// ---------------------------------------------------------------------------
// CliInboxAdapter
// ---------------------------------------------------------------------------

// WHY inline (not imported from src/cli/commands/worktrain-inbox.ts): importing
// from the CLI layer would couple trigger/ to a CLI command type, which is
// architecturally backwards. Shape must match OutboxMessage in worktrain-inbox.ts.
interface OutboxEntry {
  readonly id: string;
  readonly message: string;
  readonly timestamp: string;
}

/** Zero-config default adapter. Used when no other adapter is configured. */
export class CliInboxAdapter implements DeliveryAdapter<'cli_inbox'> {
  readonly adapterKind = 'cli_inbox' as const;

  constructor(private readonly workrailDir: string) {}

  async deliver(
    payload: DeliveryPayload,
    _config: Extract<AdapterConfig, { kind: 'cli_inbox' }>,
  ): Promise<DeliveryReceipt> {
    const outboxPath = path.join(this.workrailDir, 'outbox.jsonl');
    const entry: OutboxEntry = {
      id: randomUUID(),
      message: `[${payload.workflowId}] ${payload.goal}`,
      timestamp: new Date().toISOString(),
    };
    try {
      await fs.appendFile(outboxPath, JSON.stringify(entry) + '\n', 'utf-8');
      return { kind: 'completed', destination: outboxPath };
    } catch (err) {
      return { kind: 'error', message: String(err), retryable: false };
    }
  }
}
