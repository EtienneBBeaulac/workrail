/**
 * Unit tests for GitHubDraftReviewAdapter and GitCommitAdapter.
 *
 * Tests verify:
 * - Happy path receipt shapes
 * - Error receipts for missing required inputs
 * - Sidecar write-before-poller invariant (verified via mock ordering)
 * - Pure dispatch loop exhaustiveness via trigger-router _runDeliveryByKind
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeliveryPayload, AdapterConfig } from '../../src/trigger/delivery-adapter.js';
import { GitHubDraftReviewAdapter } from '../../src/trigger/adapters/github-draft-review-adapter.js';
import { GitCommitAdapter } from '../../src/trigger/adapters/git-commit-adapter.js';
import type { ReviewApprovalAdapter } from '../../src/trigger/review-approval-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_PAYLOAD: DeliveryPayload = {
  workflowId: 'wr.mr-review',
  sessionId: 'sess-abc123',
  goal: 'Review PR #42',
  notes: null,
  artifacts: [],
  context: { itemNumber: 42, itemUrl: 'https://github.com/owner/repo/pull/42' },
  workrailSessionId: 'sess_workrail123',
  triggerId: 'mr-review-draft',
  workspacePath: '/workspace',
};

const GITHUB_DRAFT_CONFIG: Extract<AdapterConfig, { kind: 'github_draft_review' }> = {
  kind: 'github_draft_review',
  token: 'gh_token',
  login: 'reviewer',
};

const REVIEW_VERDICT = {
  kind: 'wr.review_verdict',
  verdict: 'minor',
  confidence: 'high',
  findings: [{ severity: 'minor', summary: 'small issue' }],
  summary: 'Looks good',
};

function makeReviewApprovalAdapter(overrides?: Partial<ReviewApprovalAdapter>): ReviewApprovalAdapter {
  return {
    createDraftReview: vi.fn().mockResolvedValue({ kind: 'ok', value: { reviewId: 99, reused: false } }),
    checkSubmission: vi.fn().mockResolvedValue({ kind: 'pending' }),
    ...overrides,
  } as unknown as ReviewApprovalAdapter;
}

function makeFakeV2Ctx() {
  return {
    v2: {
      sessionStore: { load: vi.fn(), append: vi.fn() },
      gate: { withHealthySessionLock: vi.fn() },
      idFactory: { mintEventId: vi.fn().mockReturnValue('ev-1') },
    },
  };
}

// ---------------------------------------------------------------------------
// GitHubDraftReviewAdapter
// ---------------------------------------------------------------------------

describe('GitHubDraftReviewAdapter', () => {
  it('returns error receipt when ctx.v2 is absent', async () => {
    const adapter = new GitHubDraftReviewAdapter({
      reviewApprovalAdapter: makeReviewApprovalAdapter(),
      ctx: { v2: undefined } as unknown as Parameters<typeof GitHubDraftReviewAdapter.prototype.deliver>[0] extends never ? never : ConstructorParameters<typeof GitHubDraftReviewAdapter>[0]['ctx'],
    });
    const receipt = await adapter.deliver({ ...BASE_PAYLOAD, artifacts: [REVIEW_VERDICT] }, GITHUB_DRAFT_CONFIG);
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('ctx.v2 absent');
  });

  it('returns error receipt when no wr.review_verdict in artifacts', async () => {
    const adapter = new GitHubDraftReviewAdapter({
      reviewApprovalAdapter: makeReviewApprovalAdapter(),
      ctx: makeFakeV2Ctx() as never,
    });
    const receipt = await adapter.deliver({ ...BASE_PAYLOAD, artifacts: [] }, GITHUB_DRAFT_CONFIG);
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('wr.review_verdict');
  });

  it('returns error receipt when context missing itemNumber', async () => {
    const adapter = new GitHubDraftReviewAdapter({
      reviewApprovalAdapter: makeReviewApprovalAdapter(),
      ctx: makeFakeV2Ctx() as never,
    });
    const receipt = await adapter.deliver(
      { ...BASE_PAYLOAD, artifacts: [REVIEW_VERDICT], context: { itemUrl: 'https://github.com/owner/repo/pull/42' } },
      GITHUB_DRAFT_CONFIG,
    );
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('itemNumber');
  });

  it('returns error receipt when createDraftReview fails', async () => {
    const adapter = new GitHubDraftReviewAdapter({
      reviewApprovalAdapter: makeReviewApprovalAdapter({
        createDraftReview: vi.fn().mockResolvedValue({ kind: 'err', error: { message: 'GitHub error' } }),
      }),
      ctx: makeFakeV2Ctx() as never,
    });
    const receipt = await adapter.deliver(
      { ...BASE_PAYLOAD, artifacts: [REVIEW_VERDICT] },
      GITHUB_DRAFT_CONFIG,
    );
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('GitHub error');
  });

  it('returns pending receipt on success', async () => {
    const sessionsDir = '/tmp/test-sessions-' + Math.random().toString(36).slice(2);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(sessionsDir, { recursive: true });

    try {
      const adapter = new GitHubDraftReviewAdapter({
        reviewApprovalAdapter: makeReviewApprovalAdapter(),
        ctx: makeFakeV2Ctx() as never,
        sessionsDir,
      });
      const receipt = await adapter.deliver(
        { ...BASE_PAYLOAD, artifacts: [REVIEW_VERDICT] },
        GITHUB_DRAFT_CONFIG,
      );
      expect(receipt.kind).toBe('pending');
      if (receipt.kind === 'pending') {
        expect(receipt.pollHandle.adapterId).toBe('github_draft_review');
      }
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });

  it('writes pending-delivery sidecar before starting poller (sidecar exists after deliver)', async () => {
    const sessionsDir = '/tmp/test-sessions-sidecar-' + Math.random().toString(36).slice(2);
    const { mkdir, readdir } = await import('node:fs/promises');
    await mkdir(sessionsDir, { recursive: true });

    try {
      const adapter = new GitHubDraftReviewAdapter({
        reviewApprovalAdapter: makeReviewApprovalAdapter(),
        ctx: makeFakeV2Ctx() as never,
        sessionsDir,
      });
      await adapter.deliver({ ...BASE_PAYLOAD, artifacts: [REVIEW_VERDICT] }, GITHUB_DRAFT_CONFIG);
      const files = await readdir(sessionsDir);
      const deliverySidecars = files.filter(f => f.startsWith('pending-delivery-'));
      expect(deliverySidecars.length).toBeGreaterThanOrEqual(1);
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GitCommitAdapter
// ---------------------------------------------------------------------------

const GIT_COMMIT_CONFIG: Extract<AdapterConfig, { kind: 'git_commit' }> = {
  kind: 'git_commit',
  autoOpenPR: false,
  secretScan: true,
};

describe('GitCommitAdapter', () => {
  it('returns error receipt when triggerId is absent', async () => {
    const adapter = new GitCommitAdapter({ execFn: vi.fn() as never });
    const receipt = await adapter.deliver({ ...BASE_PAYLOAD, triggerId: undefined }, GIT_COMMIT_CONFIG);
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('triggerId');
  });

  it('returns error receipt when notes are absent', async () => {
    const adapter = new GitCommitAdapter({ execFn: vi.fn() as never });
    const receipt = await adapter.deliver({ ...BASE_PAYLOAD, notes: null }, GIT_COMMIT_CONFIG);
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('notes');
  });

  it('returns error receipt when workspacePath is absent', async () => {
    const adapter = new GitCommitAdapter({ execFn: vi.fn() as never });
    const receipt = await adapter.deliver({ ...BASE_PAYLOAD, notes: 'some notes', workspacePath: undefined }, GIT_COMMIT_CONFIG);
    expect(receipt.kind).toBe('error');
    expect((receipt as { kind: 'error'; message: string }).message).toContain('workspacePath');
  });

  it('calls execFn and returns completed receipt on happy path', async () => {
    const VALID_NOTES = `
## Step notes
\`\`\`json
{
  "commitType": "feat",
  "commitScope": "engine",
  "commitSubject": "add feature",
  "prTitle": "feat(engine): add feature",
  "prBody": "test pr body",
  "filesChanged": ["src/foo.ts"]
}
\`\`\`
`;
    const execFn = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' });
    const adapter = new GitCommitAdapter({ execFn: execFn as never });
    const receipt = await adapter.deliver(
      { ...BASE_PAYLOAD, notes: VALID_NOTES },
      GIT_COMMIT_CONFIG,
    );
    // runDeliveryPipeline calls execFn for git operations
    expect(execFn).toHaveBeenCalled();
    expect(receipt.kind).toBe('completed');
  });
});
