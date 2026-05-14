/**
 * Unit tests for evaluateGate() in gate-evaluator-dispatcher.ts.
 *
 * Uses injectable fake deps (no real sessions, no network calls).
 * Covers: approved verdict, uncertain fallback (no artifact), uncertain on
 * timeout, uncertain on spawn failure, uncertain on malformed artifact.
 */

import * as os from 'node:os';
import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../../src/coordinators/gate-evaluator-dispatcher.js';
import type { GateEvaluatorDeps } from '../../src/coordinators/gate-evaluator-dispatcher.js';

// ---------------------------------------------------------------------------
// Fake deps builders
// ---------------------------------------------------------------------------

const FAKE_HANDLE = 'sess_fake_handle_001';

function makeDeps(overrides: Partial<GateEvaluatorDeps> = {}): GateEvaluatorDeps {
  return {
    spawnSession: async () => ({ kind: 'ok', value: FAKE_HANDLE }),
    awaitSessions: async () => ({
      results: [{ handle: FAKE_HANDLE, outcome: 'success', status: 'complete', durationMs: 100 }],
      allSucceeded: true,
    }),
    getAgentResult: async () => ({ recapMarkdown: null, artifacts: [] }),
    stderr: () => {},
    ...overrides,
  };
}

function makeVerdictArtifact(verdict: 'approved' | 'rejected' | 'uncertain' = 'approved') {
  return {
    kind: 'wr.gate_verdict',
    version: 1,
    verdict,
    confidence: 'high' as const,
    rationale: 'The step output meets quality standards and acceptance criteria.',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateGate()', () => {
  const WORKSPACE = os.tmpdir();
  const STEP_ID = 'frame-gate';
  const WORKFLOW_ID = 'wr.shaping';
  const ARTIFACT = { stepId: STEP_ID, workflowId: WORKFLOW_ID, goal: 'Design a CLI tool' };

  it('returns approved verdict when evaluator produces valid wr.gate_verdict', async () => {
    const deps = makeDeps({
      getAgentResult: async () => ({
        recapMarkdown: 'Evaluation complete.',
        artifacts: [makeVerdictArtifact('approved')],
      }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('approved');
    expect(verdict.confidence).toBe('high');
    expect(verdict.rationale.length).toBeGreaterThan(10);
    expect(verdict.stepId).toBe(STEP_ID);
  });

  it('returns rejected verdict when evaluator rejects', async () => {
    const deps = makeDeps({
      getAgentResult: async () => ({
        recapMarkdown: null,
        artifacts: [makeVerdictArtifact('rejected')],
      }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('rejected');
    expect(verdict.stepId).toBe(STEP_ID);
  });

  it('returns uncertain when evaluator produces no wr.gate_verdict artifact', async () => {
    const deps = makeDeps({
      getAgentResult: async () => ({ recapMarkdown: 'Some notes.', artifacts: [] }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.rationale).toMatch(/no wr\.gate_verdict artifact/);
    expect(verdict.stepId).toBe(STEP_ID);
  });

  it('returns uncertain when evaluator produces artifacts of other kinds', async () => {
    const deps = makeDeps({
      getAgentResult: async () => ({
        recapMarkdown: null,
        artifacts: [{ kind: 'wr.review_verdict', verdict: 'clean', confidence: 'high', findings: [], summary: 'ok' }],
      }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
  });

  it('returns uncertain when spawn fails', async () => {
    const deps = makeDeps({
      spawnSession: async () => ({ kind: 'err', error: 'workflow not found: wr.gate-eval-generic' }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.rationale).toMatch(/spawn failed/);
  });

  it('returns uncertain when spawn returns null handle', async () => {
    const deps = makeDeps({
      spawnSession: async () => ({ kind: 'ok', value: null }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.rationale).toMatch(/null handle/);
  });

  it('returns uncertain when evaluator session times out (non-success outcome)', async () => {
    const deps = makeDeps({
      awaitSessions: async () => ({
        results: [{ handle: FAKE_HANDLE, outcome: 'timeout', status: null, durationMs: 30000 }],
        allSucceeded: false,
      }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.rationale).toMatch(/timeout/);
  });

  it('returns uncertain when evaluator session fails', async () => {
    const deps = makeDeps({
      awaitSessions: async () => ({
        results: [{ handle: FAKE_HANDLE, outcome: 'failed', status: 'error', durationMs: 500 }],
        allSucceeded: false,
      }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
  });

  it('returns uncertain when wr.gate_verdict artifact fails schema validation (rationale too short)', async () => {
    const deps = makeDeps({
      getAgentResult: async () => ({
        recapMarkdown: null,
        artifacts: [{ kind: 'wr.gate_verdict', version: 1, verdict: 'approved', confidence: 'high', rationale: 'ok' }], // too short
      }),
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.rationale).toMatch(/schema validation/);
  });

  it('uses provided custom timeout', async () => {
    let capturedTimeout = 0;
    const deps = makeDeps({
      awaitSessions: async (_handles, timeoutMs) => {
        capturedTimeout = timeoutMs;
        return {
          results: [{ handle: FAKE_HANDLE, outcome: 'success', status: 'complete', durationMs: 50 }],
          allSucceeded: true,
        };
      },
    });

    const CUSTOM_TIMEOUT = 5 * 60 * 1000;
    await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID, undefined, undefined, CUSTOM_TIMEOUT);

    expect(capturedTimeout).toBe(CUSTOM_TIMEOUT);
  });

  it('never throws -- wraps getAgentResult exception as uncertain', async () => {
    const deps = makeDeps({
      getAgentResult: async () => { throw new Error('session store unavailable'); },
    });

    const verdict = await evaluateGate(deps, ARTIFACT, 'wr.gate-eval-generic', WORKSPACE, STEP_ID);

    expect(verdict.verdict).toBe('uncertain');
    expect(verdict.rationale).toMatch(/session store unavailable/);
  });
});

describe('evaluateGate() -- readStepOutput enrichment', () => {
  const WORKSPACE = os.tmpdir();
  const STEP_ID = 'design-gate';
  const WR_SESSION_ID = 'sess_abc123';

  function makeVerdictArtifact() {
    return {
      kind: 'wr.gate_verdict',
      version: 1,
      verdict: 'approved' as const,
      confidence: 'high' as const,
      rationale: 'Step output is complete and meets quality standards.',
    };
  }

  function makeDepsWithOutput(overrides: Partial<GateEvaluatorDeps> = {}): GateEvaluatorDeps {
    return {
      spawnSession: async () => ({ kind: 'ok', value: 'sess_evaluator_001' }),
      awaitSessions: async () => ({
        results: [{ handle: 'sess_evaluator_001', outcome: 'success', status: 'complete', durationMs: 100 }],
        allSucceeded: true,
      }),
      getAgentResult: async () => ({ recapMarkdown: null, artifacts: [makeVerdictArtifact()] }),
      stderr: () => {},
      ...overrides,
    };
  }

  it('injects stepNotes into spawnSession context when readStepOutput returns notes', async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const deps = makeDepsWithOutput({
      spawnSession: async (_wfId, _goal, _workspace, context) => {
        capturedContext = context as Record<string, unknown>;
        return { kind: 'ok', value: 'sess_evaluator_001' };
      },
      readStepOutput: async () => ({ recapMarkdown: 'The design candidate A uses a sealed class.', artifacts: [] }),
    });

    await evaluateGate(deps, {}, 'wr.gate-eval-generic', WORKSPACE, STEP_ID, WR_SESSION_ID);

    expect(capturedContext?.stepNotes).toBe('The design candidate A uses a sealed class.');
  });

  it('proceeds with metadata-only context when readStepOutput returns null', async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const deps = makeDepsWithOutput({
      spawnSession: async (_wfId, _goal, _workspace, context) => {
        capturedContext = context as Record<string, unknown>;
        return { kind: 'ok', value: 'sess_evaluator_001' };
      },
      readStepOutput: async () => null,
    });

    await evaluateGate(deps, {}, 'wr.gate-eval-generic', WORKSPACE, STEP_ID, WR_SESSION_ID);

    expect(capturedContext?.stepNotes).toBeUndefined();
    expect(capturedContext?.stepId).toBe(STEP_ID);
  });

  it('proceeds with metadata-only context when readStepOutput throws', async () => {
    let capturedContext: Record<string, unknown> | undefined;
    const deps = makeDepsWithOutput({
      spawnSession: async (_wfId, _goal, _workspace, context) => {
        capturedContext = context as Record<string, unknown>;
        return { kind: 'ok', value: 'sess_evaluator_001' };
      },
      readStepOutput: async () => { throw new Error('session store unavailable'); },
    });

    await evaluateGate(deps, {}, 'wr.gate-eval-generic', WORKSPACE, STEP_ID, WR_SESSION_ID);

    // Should not throw and should proceed without stepNotes
    expect(capturedContext?.stepNotes).toBeUndefined();
    expect(capturedContext?.stepId).toBe(STEP_ID);
  });

  it('truncates stepNotes exceeding 4000 characters', async () => {
    const longNotes = 'x'.repeat(5000);
    let capturedContext: Record<string, unknown> | undefined;
    const deps = makeDepsWithOutput({
      spawnSession: async (_wfId, _goal, _workspace, context) => {
        capturedContext = context as Record<string, unknown>;
        return { kind: 'ok', value: 'sess_evaluator_001' };
      },
      readStepOutput: async () => ({ recapMarkdown: longNotes, artifacts: [] }),
    });

    await evaluateGate(deps, {}, 'wr.gate-eval-generic', WORKSPACE, STEP_ID, WR_SESSION_ID);

    const injectedNotes = capturedContext?.stepNotes as string;
    expect(injectedNotes.length).toBeLessThan(5000);
    expect(injectedNotes).toContain('[truncated]');
  });
});
