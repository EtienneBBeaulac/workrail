/**
 * V2 Resume Response Formatter Tests
 *
 * Tests the natural language formatting of resume_session responses.
 * Verifies the formatter produces helpful output for agents with zero
 * WorkRail context.
 *
 * @module tests/unit/v2/v2-response-formatter-resume
 */

import { describe, it, expect } from 'vitest';
import { formatV2ResumeResponse } from '../../../src/mcp/v2-response-formatter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkCandidate(overrides: Partial<{
  sessionId: string;
  runId: string;
  workflowId: string;
  sessionTitle: string | null;
  gitBranch: string | null;
  resumeToken: string;
  snippet: string;
  whyMatched: string[];
  confidence: 'strong' | 'medium' | 'weak';
  matchExplanation: string;
  pendingStepId: string | null;
  isComplete: boolean;
  lastModifiedMs: number | null;
}> = {}) {
  const token = overrides.resumeToken ?? 'st1_test_token';
  return {
    sessionId: overrides.sessionId ?? 'sess_test1',
    runId: overrides.runId ?? 'run_test1',
    workflowId: overrides.workflowId ?? 'coding-task-workflow-agentic',
    sessionTitle: overrides.sessionTitle ?? null,
    gitBranch: overrides.gitBranch ?? null,
    resumeToken: token,
    snippet: overrides.snippet ?? 'Working on MR ownership feature',
    whyMatched: overrides.whyMatched ?? ['recency_fallback'],
    confidence: overrides.confidence ?? 'weak',
    matchExplanation: overrides.matchExplanation ?? 'Recent session with no stronger explicit match',
    pendingStepId: overrides.pendingStepId ?? null,
    isComplete: overrides.isComplete ?? false,
    lastModifiedMs: overrides.lastModifiedMs ?? null,
    nextCall: {
      tool: 'continue_workflow' as const,
      params: { continueToken: token, intent: 'rehydrate' as const },
    },
  };
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

describe('formatV2ResumeResponse - shape detection', () => {
  it('returns null for non-resume data', () => {
    expect(formatV2ResumeResponse({ foo: 'bar' })).toBeNull();
    expect(formatV2ResumeResponse(null)).toBeNull();
    expect(formatV2ResumeResponse('string')).toBeNull();
  });

  it('returns null for execution responses (has pending/nextIntent)', () => {
    // Execution responses have candidates-like fields but also pending/nextIntent
    const executionLike = {
      candidates: [],
      totalEligible: 0,
      pending: { stepId: 'step1', title: 'Do something', prompt: 'Do it' },
      nextIntent: 'advance',
    };
    expect(formatV2ResumeResponse(executionLike)).toBeNull();
  });

  it('recognizes valid resume response', () => {
    const data = { candidates: [mkCandidate()], totalEligible: 1 };
    expect(formatV2ResumeResponse(data)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empty candidates
// ---------------------------------------------------------------------------

describe('formatV2ResumeResponse - empty candidates', () => {
  it('explains no sessions found and suggests what to do', () => {
    const data = { candidates: [], totalEligible: 0 };
    const result = formatV2ResumeResponse(data);
    expect(result).not.toBeNull();
    const text = result!.primary;

    expect(text).toContain('No Resumable Sessions Found');
    expect(text).toContain('Ask the user');
    // Should include search params help
    expect(text).toContain('query');
    expect(text).toContain('runId');
    expect(text).toContain('sessionId');
    expect(text).toContain('workspacePath');
  });

  it('mentions total searched when some existed but none matched', () => {
    const data = { candidates: [], totalEligible: 30 };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('30 session(s)');
  });
});

// ---------------------------------------------------------------------------
// All recency fallback (no search signal)
// ---------------------------------------------------------------------------

describe('formatV2ResumeResponse - all recency fallback', () => {
  it('labels as recent sessions and tells agent to ask user', () => {
    const data = {
      candidates: [
        mkCandidate({ whyMatched: ['recency_fallback'] }),
        mkCandidate({ sessionId: 'sess_2', runId: 'run_2', whyMatched: ['recency_fallback'] }),
      ],
      totalEligible: 50,
    };
    const result = formatV2ResumeResponse(data)!;
    const text = result.primary;

    expect(text).toContain('Recent Workflow Sessions');
    expect(text).toContain('Action required');
    expect(text).toContain('ask which one');
    expect(text).toContain('2 most recent');
    expect(text).toContain('50 total');
  });

  it('shows search params help', () => {
    const data = {
      candidates: [mkCandidate({ whyMatched: ['recency_fallback'] })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('To narrow results');
    expect(result.primary).toContain('runId');
  });

  it('shows overflow count when more sessions exist', () => {
    const data = {
      candidates: [mkCandidate({ whyMatched: ['recency_fallback'] })],
      totalEligible: 50,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('49 more session(s) not shown');
  });
});

// ---------------------------------------------------------------------------
// Strong match signal
// ---------------------------------------------------------------------------

describe('formatV2ResumeResponse - strong match', () => {
  it('recommends direct resume for exact ID match', () => {
    const data = {
      candidates: [mkCandidate({ whyMatched: ['matched_exact_id'] })],
      totalEligible: 50,
    };
    const result = formatV2ResumeResponse(data)!;
    const text = result.primary;

    expect(text).toContain('Resumable Workflow Sessions');
    expect(text).toContain('exact ID match');
    expect(text).toContain('Resume it directly');
  });

  it('recommends user confirmation for non-exact strong match', () => {
    const data = {
      candidates: [mkCandidate({ whyMatched: ['matched_notes'] })],
      totalEligible: 10,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('strongest match signal');
    expect(result.primary).toContain('confirm which one');
  });

  it('treats mixed strong+weak results as strong match', () => {
    const data = {
      candidates: [
        mkCandidate({ whyMatched: ['matched_branch'] }),
        mkCandidate({ sessionId: 'sess_2', runId: 'run_2', whyMatched: ['recency_fallback'] }),
      ],
      totalEligible: 10,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('Resumable Workflow Sessions');
    expect(result.primary).not.toContain('Recent Workflow Sessions');
  });
});

// ---------------------------------------------------------------------------
// Candidate formatting
// ---------------------------------------------------------------------------

describe('formatV2ResumeResponse - candidate details', () => {
  it('includes session ID, run ID, workflow ID, confidence, and match reason', () => {
    const data = {
      candidates: [mkCandidate({
        sessionId: 'sess_abc',
        runId: 'run_xyz',
        workflowId: 'my-workflow',
        sessionTitle: 'Task dev for MR ownership',
        gitBranch: 'feature/mr-ownership',
        whyMatched: ['matched_head_sha', 'matched_repo_root'],
        confidence: 'medium',
        matchExplanation: 'Matched current git commit; same workspace',
      })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    const text = result.primary;

    expect(text).toContain('sess_abc');
    expect(text).toContain('run_xyz');
    expect(text).toContain('my-workflow');
    expect(text).toContain('Task dev for MR ownership');
    expect(text).toContain('feature/mr-ownership');
    expect(text).toContain('Same git commit');
    expect(text).toContain('Same workspace/repository');
    expect(text).toContain('Confidence');
    expect(text).toContain('Matched current git commit; same workspace');
  });

  it('includes snippet preview', () => {
    const data = {
      candidates: [mkCandidate({ snippet: 'Implementing OAuth flow', whyMatched: ['matched_notes'] })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('Implementing OAuth flow');
  });

  it('truncates long snippets', () => {
    const longSnippet = 'A'.repeat(300);
    const data = {
      candidates: [mkCandidate({ snippet: longSnippet, whyMatched: ['matched_notes'] })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('...');
    expect(result.primary).not.toContain('A'.repeat(300));
  });

  it('shows placeholder when no snippet exists', () => {
    const data = {
      candidates: [mkCandidate({ snippet: '', whyMatched: ['matched_branch'] })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('no recap notes available');
  });

  it('includes continue_workflow JSON template with only params (no tool field)', () => {
    const data = {
      candidates: [mkCandidate({ resumeToken: 'st1_mytoken', whyMatched: ['matched_notes'] })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    const text = result.primary;

    // Should contain the params
    expect(text).toContain('"continueToken"');
    expect(text).toContain('"rehydrate"');
    expect(text).toContain('st1_mytoken');
    // Should NOT contain "tool" as a JSON key (it's mentioned in prose but not in the JSON block)
    expect(text).not.toContain('"tool"');
    expect(text).toContain('inspect or resume this candidate');
    expect(text).toContain('rehydrate');
  });

  it('marks weak matches with (weak match) label', () => {
    const data = {
      candidates: [mkCandidate({ whyMatched: ['recency_fallback'] })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('(weak match)');
  });

  it('shows pending step ID when available', () => {
    const data = {
      candidates: [mkCandidate({
        pendingStepId: 'phase-3-implement',
        whyMatched: ['matched_notes'],
      })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('phase-3-implement');
    expect(result.primary).toContain('Current step');
  });

  it('shows completed status tag and warning', () => {
    const data = {
      candidates: [mkCandidate({
        isComplete: true,
        whyMatched: ['matched_notes'],
      })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('(completed)');
    expect(result.primary).toContain('already completed');
  });

  it('shows relative time when lastModifiedMs is present', () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    const data = {
      candidates: [mkCandidate({
        lastModifiedMs: twoHoursAgo,
        whyMatched: ['matched_notes'],
      })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('Last active');
    expect(result.primary).toContain('2 hours ago');
  });

  it('shows status for completed sessions without pendingStepId', () => {
    const data = {
      candidates: [mkCandidate({
        isComplete: true,
        pendingStepId: null,
        whyMatched: ['matched_branch'],
      })],
      totalEligible: 1,
    };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('Workflow completed');
  });

  it('shows workspace-driven ranking note when candidates are matched only by git context', () => {
    const data = {
      candidates: [
        mkCandidate({ whyMatched: ['matched_head_sha'] }),
        mkCandidate({ sessionId: 'sess_2', runId: 'run_2', whyMatched: ['matched_branch'] }),
      ],
      totalEligible: 2,
    };

    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('ranked primarily from current workspace git context');
    expect(result.primary).toContain('continue_workflow(..., intent: "rehydrate")');
  });

  it('shows sameWorkspaceOnly in narrowing help', () => {
    const data = { candidates: [], totalEligible: 0 };
    const result = formatV2ResumeResponse(data)!;
    expect(result.primary).toContain('sameWorkspaceOnly');
  });
});
