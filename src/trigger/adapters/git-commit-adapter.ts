/**
 * GitCommitAdapter: DeliveryAdapter<'git_commit'>
 *
 * Commits the agent's changes and optionally opens a PR. Reads the HandoffArtifact
 * from the session's final step notes and delegates to runDeliveryPipeline.
 *
 * WHY constructor takes only execFn: all session-scoped fields (workspacePath,
 * branchStrategy, etc.) vary per session and are injected via the widened
 * DeliveryPayload at deliver() call time. execFn is the only truly process-scoped
 * dependency that cannot come from the payload.
 *
 * WHY returns error (not void) when triggerId is absent: dispatch() sessions have
 * no triggerId. GitCommitDeliveryContext.id requires a TriggerId -- rather than
 * fabricating one, we surface the constraint as a typed error receipt so callers
 * can choose how to handle it. This preserves the existing behavior of skipping
 * git-commit delivery for dispatch() sessions.
 */

import type { DeliveryAdapter, DeliveryPayload, DeliveryReceipt, AdapterConfig } from '../delivery-adapter.js';
import { runDeliveryPipeline, DEFAULT_DELIVERY_PIPELINE, type GitCommitDeliveryContext, type DeliveryPipelineDeps } from '../delivery-pipeline.js';
import type { ExecFn } from '../delivery-action.js';
import type { TriggerId } from '../types.js';
import type { WorkflowRunSuccess } from '../../daemon/types.js';

export interface GitCommitAdapterOptions {
  readonly execFn: ExecFn;
  readonly deps?: DeliveryPipelineDeps;
}

export class GitCommitAdapter implements DeliveryAdapter<'git_commit'> {
  readonly adapterKind = 'git_commit' as const;

  private readonly execFn: ExecFn;
  private readonly deps: DeliveryPipelineDeps | undefined;

  constructor(opts: GitCommitAdapterOptions) {
    this.execFn = opts.execFn;
    this.deps = opts.deps;
  }

  async deliver(
    payload: DeliveryPayload,
    config: Extract<AdapterConfig, { kind: 'git_commit' }>,
  ): Promise<DeliveryReceipt> {
    if (!payload.triggerId) {
      return {
        kind: 'error',
        message: 'git_commit delivery requires a triggerId -- dispatch() sessions cannot use git_commit adapter',
        retryable: false,
      };
    }

    if (!payload.notes) {
      console.warn(
        `[GitCommitAdapter] Git commit delivery skipped: triggerId=${payload.triggerId} -- ` +
        `notes absent (agent did not provide notes on the final step).`,
      );
      return {
        kind: 'error',
        message: 'git_commit delivery requires notes on the final step (HandoffArtifact embedded in notes)',
        retryable: false,
      };
    }

    if (!payload.workspacePath) {
      return {
        kind: 'error',
        message: 'git_commit delivery requires workspacePath in DeliveryPayload',
        retryable: false,
      };
    }

    const deliveryCtx: GitCommitDeliveryContext = {
      id: payload.triggerId as TriggerId,
      workflowId: payload.workflowId,
      workspacePath: payload.workspacePath,
      autoCommit: true,
      autoOpenPR: config.autoOpenPR,
      secretScan: config.secretScan,
      branchStrategy: payload.branchStrategy as GitCommitDeliveryContext['branchStrategy'],
      branchPrefix: payload.branchPrefix,
      baseBranch: payload.baseBranch,
    };

    // runDeliveryPipeline never throws -- errors are logged internally per stage.
    const syntheticResult: WorkflowRunSuccess = {
      _tag: 'success',
      workflowId: payload.workflowId,
      stopReason: 'end_turn',
      lastStepNotes: payload.notes,
      lastStepArtifacts: payload.artifacts,
    };

    await runDeliveryPipeline(
      DEFAULT_DELIVERY_PIPELINE,
      syntheticResult,
      deliveryCtx,
      this.execFn,
      payload.triggerId,
      this.deps,
    );

    return { kind: 'completed', destination: `${payload.workspacePath} (git)` };
  }
}
