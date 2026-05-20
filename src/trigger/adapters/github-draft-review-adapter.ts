/**
 * GitHubDraftReviewAdapter: DeliveryAdapter<'github_draft_review'>
 *
 * Extracts a wr.review_verdict artifact from the session output, posts a GitHub
 * PENDING draft review with inline comments, writes a pending-delivery sidecar,
 * and starts a background poller that fires the gate resume callback when the
 * operator submits the review.
 *
 * WHY constructor injection for all deps: makes the adapter independently testable
 * and satisfies the dependency-injection-for-boundaries principle. The router
 * constructs this once at startup and passes it into _runDeliveryByKind.
 *
 * Invariant: writePendingDeliverySidecar() is called BEFORE poller.start().
 * Crash recovery reads the sidecar to restart the poller after daemon restart.
 */

import { randomUUID } from 'node:crypto';
import { PendingDraftReviewPoller, writePendingDraftSidecar } from '../pending-draft-review-poller.js';
import { writePendingDeliverySidecar } from '../pending-delivery-sidecar.js';
import type { DeliveryAdapter, DeliveryPayload, DeliveryReceipt, GateResumeCallback, AdapterConfig } from '../delivery-adapter.js';
import type { ReviewApprovalAdapter } from '../review-approval-adapter.js';
import type { V2ToolContext } from '../../mcp/types.js';
import { parseReviewVerdictArtifact } from '../../v2/durable-core/schemas/artifacts/review-verdict.js';
import { DAEMON_SESSIONS_DIR } from '../../daemon/tools/_shared.js';

export interface GitHubDraftReviewAdapterOptions {
  readonly reviewApprovalAdapter: ReviewApprovalAdapter;
  readonly gateResumeCallback?: GateResumeCallback;
  readonly ctx?: V2ToolContext;
  readonly sessionsDir?: string;
}

export class GitHubDraftReviewAdapter implements DeliveryAdapter<'github_draft_review'> {
  readonly adapterKind = 'github_draft_review' as const;

  private readonly reviewApprovalAdapter: ReviewApprovalAdapter;
  private readonly gateResumeCallback: GateResumeCallback | undefined;
  private readonly ctx: V2ToolContext | undefined;
  private readonly sessionsDir: string;

  constructor(opts: GitHubDraftReviewAdapterOptions) {
    this.reviewApprovalAdapter = opts.reviewApprovalAdapter;
    this.gateResumeCallback = opts.gateResumeCallback;
    this.ctx = opts.ctx;
    this.sessionsDir = opts.sessionsDir ?? DAEMON_SESSIONS_DIR;
  }

  async deliver(
    payload: DeliveryPayload,
    config: Extract<AdapterConfig, { kind: 'github_draft_review' }>,
  ): Promise<DeliveryReceipt> {
    if (!this.ctx?.v2) {
      return { kind: 'error', message: 'github_draft_review requires v2 session context (ctx.v2 absent)', retryable: false };
    }

    // Extract wr.review_verdict from artifacts.
    let reviewVerdict: ReturnType<typeof parseReviewVerdictArtifact> = null;
    for (const artifact of payload.artifacts) {
      reviewVerdict = parseReviewVerdictArtifact(artifact);
      if (reviewVerdict !== null) break;
    }

    if (reviewVerdict === null) {
      const kinds = payload.artifacts
        .map((a) => (typeof a === 'object' && a !== null ? (a as Record<string, unknown>)['kind'] : 'unknown'))
        .join(', ');
      return {
        kind: 'error',
        message: `no valid wr.review_verdict in artifacts [${kinds}] -- ensure wr.mr-review emits it on the final step`,
        retryable: false,
      };
    }

    // Extract PR context from session context (injected by github_prs_poll or contextMapping).
    const ctx = payload.context as Record<string, unknown> | undefined;
    const prNumber = typeof ctx?.['itemNumber'] === 'number' ? ctx['itemNumber'] : undefined;
    const prUrl = typeof ctx?.['itemUrl'] === 'string' ? ctx['itemUrl'] : undefined;

    if (prNumber === undefined || prUrl === undefined) {
      return {
        kind: 'error',
        message: 'context missing itemNumber or itemUrl -- ensure the trigger uses contextMapping to inject these fields',
        retryable: false,
      };
    }

    let prRepo: string | undefined;
    try {
      const url = new URL(prUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) prRepo = `${parts[0]}/${parts[1]}`;
    } catch { /* invalid URL */ }

    if (!prRepo) {
      return {
        kind: 'error',
        message: `could not derive prRepo from prUrl="${prUrl}"`,
        retryable: false,
      };
    }

    const createResult = await this.reviewApprovalAdapter.createDraftReview({
      prNumber,
      prRepo,
      token: config.token,
      login: config.login,
      findings: reviewVerdict.findings,
      prUrl,
    });

    if (createResult.kind === 'err') {
      return {
        kind: 'error',
        message: `draft review creation failed: ${createResult.error.message}`,
        retryable: true,
      };
    }

    const { reviewId, reused } = createResult.value;
    console.log(
      `[GitHubDraftReviewAdapter] Draft review ${reused ? 'reused' : 'created'}: ` +
      `workflowId=${payload.workflowId} prRepo=${prRepo} prNumber=${prNumber} reviewId=${reviewId}`,
    );

    const daemonSessionId = payload.sessionId !== 'unknown' ? payload.sessionId : randomUUID();
    const workrailSessionId = payload.workrailSessionId ?? '';

    if (workrailSessionId) {
      // Write pending-draft sidecar (old format) for transition-window recovery compatibility.
      // Write pending-delivery sidecar (new format) for post-transition recovery.
      // INVARIANT: both writes BEFORE poller.start() -- crash recovery depends on pre-existing sidecars.
      try {
        await writePendingDraftSidecar({
          reviewId,
          prNumber,
          prRepo,
          daemonSessionId,
          workrailSessionId,
          token: config.token,
          login: config.login,
          createdAt: new Date().toISOString(),
          triggerId: payload.triggerId ?? '',
        });
        await writePendingDeliverySidecar({
          adapterId: 'github_draft_review',
          daemonSessionId,
          state: {
            reviewId,
            prNumber,
            prRepo,
            token: config.token,
            login: config.login,
            workrailSessionId,
          },
          createdAt: new Date().toISOString(),
        }, this.sessionsDir);
      } catch (e: unknown) {
        console.warn(
          `[GitHubDraftReviewAdapter] Failed to write pending sidecar: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        );
        // Non-fatal: poller still starts; crash recovery won't work but review still posts.
      }

      const gateResumeCallback = this.gateResumeCallback;
      const poller = new PendingDraftReviewPoller(this.reviewApprovalAdapter, {
        prNumber,
        prRepo,
        reviewId,
        token: config.token,
        login: config.login,
        workrailSessionId,
        daemonSessionId,
        sessionStore: this.ctx.v2.sessionStore,
        gate: this.ctx.v2.gate,
        mintEventId: this.ctx.v2.idFactory.mintEventId.bind(this.ctx.v2.idFactory),
        sessionsDir: this.sessionsDir,
        onSubmitted: (submittedAt) => {
          console.log(
            `[GitHubDraftReviewAdapter] Review published by operator: workflowId=${payload.workflowId} ` +
            `prRepo=${prRepo} prNumber=${prNumber} submittedAt=${submittedAt}`,
          );
        },
        onGateResume: gateResumeCallback,
      });
      poller.start();
    }

    return {
      kind: 'pending',
      pollHandle: {
        adapterId: 'github_draft_review',
        state: {
          reviewId,
          prNumber,
          prRepo,
          token: config.token,
          login: config.login,
          workrailSessionId,
        },
      },
    };
  }
}
