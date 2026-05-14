/**
 * Unit tests for resumeFromGate() in daemon/gate-resume.ts.
 *
 * Uses a temp directory for sidecar files and fully injectable runWorkflowFn.
 * Covers: successful resume, token expiry, missing sidecar, missing fields,
 * already-complete session, old sidecar deletion, verdict injection into prompt.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import { resumeFromGate } from '../../src/daemon/gate-resume.js';
import type { GateVerdict } from '../../src/coordinators/gate-evaluator-dispatcher.js';
import type { WorkflowRunResult } from '../../src/daemon/types.js';
import type { executeContinueWorkflow } from '../../src/mcp/handlers/v2-execution/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = randomUUID();

/** Full gate sidecar JSON. */
function makeSidecar(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    continueToken: 'ct_test_expired_token_001',
    checkpointToken: null,
    ts: Date.now(),
    gateState: {
      kind: 'gate_checkpoint',
      gateToken: 'ct_test_gate_token_001',
      stepId: 'frame-gate',
    },
    workflowId: 'wr.shaping',
    goal: 'Design a CLI tool for task tracking',
    workspacePath: os.tmpdir(),
    ...overrides,
  }, null, 2);
}

const VERDICT: GateVerdict = {
  verdict: 'approved',
  rationale: 'The step output meets the acceptance criteria and is ready to proceed.',
  confidence: 'high',
  stepId: 'frame-gate',
};

/** Minimal V2ToolContext stub -- not used directly since executeContinueWorkflow is injected. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NULL_CTX = {} as any;

/** Fake executeContinueWorkflow that returns a valid rehydrate response (success path). */
const fakeExecuteOk: typeof executeContinueWorkflow = (_input, _ctx) =>
  okAsync({
    response: {
      kind: 'ok' as const,
      continueToken: 'ct_fresh_resume_token_001',
      checkpointToken: null,
      isComplete: false,
      pending: { stepId: 'frame-gate', title: 'Frame Gate', prompt: 'Evaluate the frame direction.', agentRole: undefined },
      preferences: { autonomy: 'full_auto_never_stop' as const, riskPolicy: 'balanced' as const },
      nextIntent: 'perform_pending_then_continue' as const,
      nextCall: { tool: 'continue_workflow' as const, params: { continueToken: 'ct_fresh_resume_token_001' } },
    },
  } as never);

/** Fake executeContinueWorkflow that returns a token error (expiry path). */
const fakeExecuteErr: typeof executeContinueWorkflow = (_input, _ctx) =>
  errAsync({ kind: 'token_invalid' as const, message: 'Token alias not found -- MCP server restarted.' } as never);

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let sessionsDir: string;

beforeEach(async () => {
  sessionsDir = path.join(os.tmpdir(), `gate-resume-test-${randomUUID()}`);
  await fs.mkdir(sessionsDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(sessionsDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resumeFromGate()', () => {

  it('calls runWorkflowFn with pre_allocated source on success', async () => {
    await fs.writeFile(path.join(sessionsDir, `${SESSION_ID}.json`), makeSidecar());

    let capturedSourceKind = '';
    let resolveRun!: () => void;
    const runDone = new Promise<void>((r) => { resolveRun = r; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowFn = async (_trigger: unknown, _ctx: unknown, _key: unknown, ..._rest: any[]) => {
      // runWorkflowFn(trigger, ctx, apiKey, daemonRegistry, emitter, activeSessionSet, _statsDir, _sessionsDir, source)
      // With (_trigger, _ctx, _key, ..._rest): rest = [daemonRegistry, emitter, activeSessionSet, _statsDir, _sessionsDir, source]
      const source = _rest[5]; // index 5 in rest = source (index 8 overall)
      capturedSourceKind = source?.kind ?? '';
      resolveRun();
      return { _tag: 'success', workflowId: 'wr.shaping', stopReason: 'stop', sessionId: SESSION_ID } as WorkflowRunResult;
    };

    const result = await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', runWorkflowFn as never,
      undefined, undefined, undefined, sessionsDir, fakeExecuteOk,
    );
    await runDone;

    expect(result.kind).toBe('ok');
    expect(capturedSourceKind).toBe('pre_allocated');
  });

  it('injects verdict into firstStepPrompt', async () => {
    await fs.writeFile(path.join(sessionsDir, `${SESSION_ID}.json`), makeSidecar());

    let capturedFirstStepPrompt = '';
    let runCalled = false;
    // Use a deferred so we can await runWorkflowFn completing even though it's fire-and-forget
    let resolveRun!: () => void;
    const runDone = new Promise<void>((r) => { resolveRun = r; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowFn = async (_trigger: any, _ctx: any, _key: any, ..._rest: any[]) => {
      runCalled = true;
      // runWorkflowFn(trigger, ctx, apiKey, daemonRegistry, emitter, activeSessionSet, _statsDir, _sessionsDir, source)
      // With (_trigger, _ctx, _key, ..._rest): rest = [daemonRegistry, emitter, activeSessionSet, _statsDir, _sessionsDir, source]
      const source = _rest[5]; // index 5 in rest = source (index 8 overall)
      if (source?.kind === 'pre_allocated') {
        capturedFirstStepPrompt = source.session.firstStepPrompt ?? '';
      }
      resolveRun();
      return { _tag: 'success', workflowId: 'wr.shaping', stopReason: 'stop', sessionId: SESSION_ID } as WorkflowRunResult;
    };

    await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', runWorkflowFn as never,
      undefined, undefined, undefined, sessionsDir, fakeExecuteOk,
    );
    await runDone; // wait for fire-and-forget to complete

    expect(runCalled).toBe(true);
    expect(capturedFirstStepPrompt).toContain('approved');
    expect(capturedFirstStepPrompt).toContain('frame-gate');
    expect(capturedFirstStepPrompt).toMatch(/Gate evaluation result/);
  });

  it('deletes the gate sidecar before calling runWorkflowFn', async () => {
    const sidecarPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await fs.writeFile(sidecarPath, makeSidecar());

    let sidecarExistedDuringRun = true;
    let resolveRun!: () => void;
    const runDone = new Promise<void>((r) => { resolveRun = r; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowFn = async (..._args: any[]) => {
      sidecarExistedDuringRun = await fs.access(sidecarPath).then(() => true).catch(() => false);
      resolveRun();
      return { _tag: 'success', workflowId: 'wr.shaping', stopReason: 'stop', sessionId: SESSION_ID } as WorkflowRunResult;
    };

    await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', runWorkflowFn as never,
      undefined, undefined, undefined, sessionsDir, fakeExecuteOk,
    );
    await runDone;

    expect(sidecarExistedDuringRun).toBe(false); // sidecar deleted BEFORE runWorkflow fires
    const stillExists = await fs.access(sidecarPath).then(() => true).catch(() => false);
    expect(stillExists).toBe(false);
  });

  it('returns err and cleans up sidecar on token expiry', async () => {
    const sidecarPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await fs.writeFile(sidecarPath, makeSidecar());

    const result = await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', (() => {}) as never,
      undefined, undefined, undefined, sessionsDir, fakeExecuteErr,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('token_expired');
      expect(result.error.message).toMatch(/Rehydrate failed/);
    }
    // Sidecar should be cleaned up on token expiry
    const exists = await fs.access(sidecarPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('returns err when sidecar has no gateState', async () => {
    const sidecarPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await fs.writeFile(sidecarPath, makeSidecar({ gateState: undefined }));

    const result = await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', (() => {}) as never,
      undefined, undefined, undefined, sessionsDir,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('missing_sidecar_fields');
      expect(result.error.message).toMatch(/gateToken/);
    }
    // Sidecar should be deleted on this error path too
    const exists = await fs.access(sidecarPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('returns err when sidecar missing workflowId', async () => {
    const sidecarPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await fs.writeFile(sidecarPath, makeSidecar({ workflowId: undefined }));

    const result = await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', (() => {}) as never,
      undefined, undefined, undefined, sessionsDir,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('missing_sidecar_fields');
      expect(result.error.message).toMatch(/workflowId/);
    }
  });

  it('returns err when sidecar missing workspacePath', async () => {
    const sidecarPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await fs.writeFile(sidecarPath, makeSidecar({ workspacePath: undefined }));

    const result = await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', (() => {}) as never,
      undefined, undefined, undefined, sessionsDir,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('missing_sidecar_fields');
      expect(result.error.message).toMatch(/workspacePath/);
    }
  });

  it('returns err when sidecar file does not exist', async () => {
    const result = await resumeFromGate(
      'no-such-session', VERDICT, NULL_CTX, 'sk-test', (() => {}) as never,
      undefined, undefined, undefined, sessionsDir,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('sidecar_read_failed');
    }
  });

  it('returns err when sidecar contains invalid JSON', async () => {
    const sidecarPath = path.join(sessionsDir, `${SESSION_ID}.json`);
    await fs.writeFile(sidecarPath, 'this is not json {{{');

    const result = await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', (() => {}) as never,
      undefined, undefined, undefined, sessionsDir,
    );

    expect(result.kind).toBe('err');
    if (result.kind === 'err') {
      expect(result.error.kind).toBe('sidecar_read_failed');
    }
  });

  it('reconstructs WorkflowTrigger from sidecar fields', async () => {
    await fs.writeFile(path.join(sessionsDir, `${SESSION_ID}.json`), makeSidecar());

    let capturedWorkflowId = '';
    let capturedGoal = '';
    let capturedWorkspacePath = '';
    let resolveRun!: () => void;
    const runDone = new Promise<void>((r) => { resolveRun = r; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runWorkflowFn = async (trigger: any, ..._rest: any[]) => {
      capturedWorkflowId = trigger.workflowId;
      capturedGoal = trigger.goal;
      capturedWorkspacePath = trigger.workspacePath;
      resolveRun();
      return { _tag: 'success', workflowId: 'wr.shaping', stopReason: 'stop', sessionId: SESSION_ID } as WorkflowRunResult;
    };

    await resumeFromGate(
      SESSION_ID, VERDICT, NULL_CTX, 'sk-test', runWorkflowFn as never,
      undefined, undefined, undefined, sessionsDir, fakeExecuteOk,
    );
    await runDone;

    expect(capturedWorkflowId).toBe('wr.shaping');
    expect(capturedGoal).toBe('Design a CLI tool for task tracking');
    expect(capturedWorkspacePath).toBe(os.tmpdir());
  });
});
