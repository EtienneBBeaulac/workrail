/**
 * Integration test for the WorkRail library engine.
 *
 * Verifies: factory init, start workflow, continue (rehydrate + advance),
 * branded token types, discriminated union response shapes, and close().
 */

import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createWorkRailEngine } from '../../src/engine/index.js';
import type { WorkRailEngine, StepResponse, StateToken, AckToken } from '../../src/engine/index.js';

describe('WorkRail library engine', () => {
  let dataDir: string;

  /** Create engine and register it for cleanup. Each test owns its lifecycle. */
  async function withEngine(fn: (engine: WorkRailEngine) => Promise<void>): Promise<void> {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      await fn(result.value);
    } finally {
      await result.value.close();
    }
  }

  beforeAll(async () => {
    // Use a temp directory for durable state — isolated per test run
    dataDir = path.join(os.tmpdir(), `workrail-engine-test-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterAll(async () => {
    // Clean up temp directory
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates engine with typed result (not thrown)', async () => {
    await withEngine(async () => {
      // withEngine asserts ok: true — if we get here, factory succeeded
    });
  });

  it('lists workflows', async () => {
    await withEngine(async (engine) => {
      const listResult = await engine.listWorkflows();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;

      expect(listResult.value.workflows.length).toBeGreaterThan(0);
      const testWorkflow = listResult.value.workflows.find(w => w.workflowId === 'test-session-persistence');
      expect(testWorkflow).toBeDefined();
      expect(testWorkflow!.name).toBeTruthy();
      expect(testWorkflow!.description).toBeTruthy();
    });
  });

  it('starts a workflow and receives discriminated ok response', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('test-session-persistence');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const response: StepResponse = startResult.value;

      // Discriminated union: kind is 'ok'
      expect(response.kind).toBe('ok');

      // Branded tokens are strings at runtime but typed at compile time
      expect(typeof response.stateToken).toBe('string');
      expect(response.stateToken.length).toBeGreaterThan(0);
      expect(typeof response.ackToken).toBe('string');

      // Pending step with prompt
      expect(response.pending).not.toBeNull();
      expect(response.pending!.stepId).toBeTruthy();
      expect(response.pending!.title).toBeTruthy();
      expect(response.pending!.prompt).toBeTruthy();

      // Preferences
      expect(response.preferences.autonomy).toBeTruthy();
      expect(response.preferences.riskPolicy).toBeTruthy();

      // Not complete on first step
      expect(response.isComplete).toBe(false);
      expect(response.nextIntent).toBe('perform_pending_then_continue');
    });
  });

  it('rehydrates (continue without ack) to recover current step', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('test-session-persistence');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const stateToken: StateToken = startResult.value.stateToken;

      // Rehydrate: null ackToken
      const rehydrateResult = await engine.continueWorkflow(stateToken, null);
      expect(rehydrateResult.ok).toBe(true);
      if (!rehydrateResult.ok) return;

      // Same step returned (rehydrate recovers, doesn't advance)
      expect(rehydrateResult.value.pending?.stepId).toBe(startResult.value.pending?.stepId);
      expect(rehydrateResult.value.nextIntent).toBe('rehydrate_only');
    });
  });

  it('advances with ack and output', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('test-session-persistence');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const stateToken: StateToken = startResult.value.stateToken;
      const ackToken: AckToken = startResult.value.ackToken!;
      const firstStepId = startResult.value.pending!.stepId;

      // Advance with notes
      const advanceResult = await engine.continueWorkflow(stateToken, ackToken, {
        notesMarkdown: '## Step completed\nDid the investigation.',
      });

      expect(advanceResult.ok).toBe(true);
      if (!advanceResult.ok) return;

      // Should be on a different step (or blocked, either is valid)
      if (advanceResult.value.kind === 'ok' && advanceResult.value.pending) {
        // Advanced to next step
        expect(advanceResult.value.pending.stepId).not.toBe(firstStepId);
      }
      // Response is well-typed
      expect(typeof advanceResult.value.stateToken).toBe('string');
    });
  });

  it('surfaces agentRole from workflow step definitions', async () => {
    await withEngine(async (engine) => {
      // workflow-diagnose-environment has agentRole on its steps
      const startResult = await engine.startWorkflow('workflow-diagnose-environment');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      expect(startResult.value.pending).not.toBeNull();
      // agentRole should be surfaced through the library API
      expect(startResult.value.pending!.agentRole).toBeTruthy();
      expect(typeof startResult.value.pending!.agentRole).toBe('string');
    });
  });

  it('passes artifacts through continue_workflow for loop control', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('test-session-persistence');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const stateToken = startResult.value.stateToken;
      const ackToken = startResult.value.ackToken!;

      // Advance with both notes and artifacts — verifies artifacts pass through
      const advanceResult = await engine.continueWorkflow(stateToken, ackToken, {
        notesMarkdown: '## Investigation complete\nFound the root cause.',
        artifacts: [{ type: 'wr.loop_control', action: 'loop_exit', reason: 'Done' }],
      });

      // Should succeed (or block, both are valid) — not crash due to artifacts
      expect(advanceResult.ok).toBe(true);
    });
  });

  it('passes context through continue_workflow for durable recording', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('test-session-persistence');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const stateToken = startResult.value.stateToken;
      const ackToken = startResult.value.ackToken!;

      // Advance with context — verifies context passes through
      const advanceResult = await engine.continueWorkflow(
        stateToken,
        ackToken,
        { notesMarkdown: '## Step done\nInvestigated the issue.' },
        { mrUrl: 'https://gitlab.com/org/repo/-/merge_requests/42', branch: 'main' },
      );

      // Should succeed — context is recorded as a durable event
      expect(advanceResult.ok).toBe(true);
    });
  });

  it('returns typed error for nonexistent workflow', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('nonexistent-workflow-12345');
      expect(startResult.ok).toBe(false);
      if (startResult.ok) return;

      expect(startResult.error.kind).toBe('workflow_not_found');
      if (startResult.error.kind === 'workflow_not_found') {
        expect(startResult.error.workflowId).toBe('nonexistent-workflow-12345');
      }
    });
  });

  it('returns typed error for invalid token', async () => {
    await withEngine(async (engine) => {
      const continueResult = await engine.continueWorkflow(
        'invalid-token' as StateToken,
        null,
      );
      expect(continueResult.ok).toBe(false);
    });
  });

  it('returns blocked response when advancing without required notes', async () => {
    await withEngine(async (engine) => {
      const startResult = await engine.startWorkflow('test-session-persistence');
      expect(startResult.ok).toBe(true);
      if (!startResult.ok) return;

      const stateToken = startResult.value.stateToken;
      const ackToken = startResult.value.ackToken!;

      // Advance with empty output (no notes) — should trigger MISSING_REQUIRED_NOTES blocker
      const advanceResult = await engine.continueWorkflow(stateToken, ackToken, {});
      expect(advanceResult.ok).toBe(true);
      if (!advanceResult.ok) return;

      // Discriminated union: should be 'blocked'
      expect(advanceResult.value.kind).toBe('blocked');
      if (advanceResult.value.kind !== 'blocked') return;

      // Verify blocker structure
      expect(advanceResult.value.blockers.length).toBeGreaterThan(0);
      const notesBlocker = advanceResult.value.blockers.find(b => b.code === 'MISSING_REQUIRED_NOTES');
      expect(notesBlocker).toBeDefined();
      expect(notesBlocker!.message).toBeTruthy();

      // Retryable — can retry with notes
      expect(advanceResult.value.retryable).toBe(true);
      expect(advanceResult.value.retryContinueToken).not.toBeNull();

      // Still has a pending step (not advanced)
      expect(advanceResult.value.pending).not.toBeNull();
    });
  });

  it('rejects creating a second engine without closing the first', async () => {
    const result1 = await createWorkRailEngine({ dataDir });
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;

    // Second create without close — should fail
    const result2 = await createWorkRailEngine({ dataDir });
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.error.kind).toBe('precondition_failed');

    // Clean up
    await result1.value.close();
  });

  it('close() allows creating a fresh engine with different config', async () => {
    // First engine
    const result1 = await createWorkRailEngine({ dataDir });
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    await result1.value.close();

    // Second engine after close — should init cleanly with same dataDir
    const result2 = await createWorkRailEngine({ dataDir });
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    const listResult = await result2.value.listWorkflows();
    expect(listResult.ok).toBe(true);

    await result2.value.close();
  });
});
